# macOS 저장 어댑터

`plugins/storage/src/platforms/macos.ts`는 Windows와 같은 공통 어댑터(`node-storage.ts`의 `NodeStorage`)에
macOS의 경로 문법과 덮어쓰지 않는 이름 변경을 더한 클래스다. 읽기, 쓰기, 추가, 복사, 이동, 목록, 생성,
삭제, 재귀 삭제, 용량 계산의 열일곱 작업을 구현하며 공개 작업과 권한 계약은 Windows와 같다.
경로 제한은 앱 명령의 책임이고 플러그인은 입력 형식만 검사한다([ADR 0024](../decisions/0024-plugin-path-responsibility.md)).

## 호스트 통합

이 어댑터는 macOS I/O Worker foundation에 올라간다. 그 foundation의 요청 검증, 작업별 권한 재검사,
실행 큐, 취소와 종료 및 dispose를 재사용하며 구현을 복제하지 않는다.
`src/operations.ts`의 입력과 출력 스키마 및 handler를 Windows와 공유하고, platforms.macos는 operations,
initialize와 dispose를 지정한다. SDK가 작업 키에서 지원 정보를 만든다.
기능 메서드는 검증된 입력을 받고 이름별 execute 분기 없이 결과를 반환한다.
AppKit 메인 스레드에서 동기 파일 작업을 실행하지 않는다.
`tests/lifecycle/macos-storage-host.ts`가 공유 native runner에서 실제 ad-hoc 서명 compiled 앱의
WKWebView와 공통 SDK로 호출한다.

## 경로

`macos-path.ts`는 파일 시스템에 접근하지 않고 문법만 검사한다. 앱이 정한 POSIX 절대 경로만 받으며
빈 이름, 반복 `/`, 끝의 `/`, `.`과 `..`, NUL과 줄바꿈, UTF-8로 왕복하지 않는 UTF-16은 거부한다.
경로는 NUL을 포함해 1024 bytes 이하, 각 이름은 255 bytes 이하다.
검사를 통과한 경로는 `node:fs`가 일반 경로처럼 연다. symlink, hardlink, `/tmp` 같은 별칭은
거부하지 않고 따라간다. 정규 이름 비교, 부모와 대상의 열린 descriptor 고정, hardlink 수 검사는 없다.
OS 접근 거부는 `PERMISSION_DENIED`, 없는 대상은 `INVALID_ARGUMENT`다. exists와 stat의 false와 null은
없는 대상에만 쓰고 접근 거부를 숨기지 않는다.

## 입출력과 전송

텍스트는 UTF-8이며 읽기는 잘못된 인코딩을 거부하고 BOM을 보존한다.
readText는 파일 512 KiB와 JSON 인코딩 768 KiB, 파일 전체를 읽는 readBytes는 256 KiB를 넘으면 `INVALID_ARGUMENT`로 실패한다.
`offset`이나 `length`를 주면 위치를 지정해 그 범위만 읽는다. 바이트 입력은 canonical base64 계약을 쓴다.
write는 연 descriptor에 쓴 뒤 꼬리를 자르며 `O_TRUNC`로 열기 전에 내용을 지우지 않는다.
append는 `O_APPEND`를 쓴다. 새 파일은 0600, 새 부모는 0700을 요청하고 OS umask가 적용된다.
성공 전에 파일을 fsync한다. 열 때 `O_NONBLOCK`을 주어 FIFO의 무기한 대기를 막고, 일반 파일이 아닌 대상은
`INVALID_ARGUMENT`로 거부한다.

copyFile은 대상을 `O_EXCL`로 만든 뒤 원본을 1 MiB씩 옮기며 크기 상한은 없다. 하나의 동기 작업이라 시작 뒤에는 취소할 수 없다. 기존 파일, 디렉터리, 링크(대상이 없는 링크 포함)를
덮어쓰지 않으며 대상 부모는 이미 있어야 한다. 쓰기 실패 시 일부 대상이 남을 수 있고, 이름이 바뀌었을 수 있어
이름으로 지우지 않는다. 원본의 동시 쓰기는 배제하지 않으므로 복사는 일관된 스냅샷이 아니다.

move는 `renamex_np(from, to, RENAME_EXCL)`를 호출한다. Node의 `rename`은 기존 대상을 덮어쓰므로 쓰지 않는다.
기존 대상은 `EEXIST`로 실패해 `INVALID_ARGUMENT`가 되고, 다른 볼륨(`EXDEV`)과 `RENAME_EXCL`을 지원하지 않는
파일 시스템(`ENOTSUP`)은 `UNSUPPORTED`다. 실패한 호출의 errno가 FFI 계층에서 0으로 읽히면 같은 호출을 한 번 더
하고(실패한 이름 변경은 아무것도 바꾸지 않는다) 그래도 읽을 수 없으면 알 수 없는 오류로 실패한다.
같은 경로로의 이동과, 문자열로 확인되는 자기 하위로의 이동은 호출 전에 `INVALID_ARGUMENT`로 거부한다.
대소문자와 Unicode 정규화를 무시하는 볼륨에서 철자만 다른 하위 경로는 문자열 비교를 통과하지만, 커널이 거부한 오류가
`INVALID_ARGUMENT`가 될 것으로 본다(실행으로 확인하지 않았다).

## 디렉터리

readDirectory는 직접 자식 최대 256개를 UTF-16 순서로 정렬한다. 초과는 `INVALID_ARGUMENT`다. 256개를 넘는 디렉터리는 같은 Node 어댑터의 `readDirectoryPage`가 이름 커서로 나눠 읽고, 하위 트리 전체는 `readDirectoryRecursive`가 경로 커서로 나눠 읽는다.
종류는 목록 항목과 `lstat` 중 하나라도 링크이면 `link`이고, dangling symlink도 `link`, hardlink는 `file`이다.
FIFO, 장치와 socket은 공개 schema로 표현할 수 없어 `UNSUPPORTED`다.
createDirectory는 recursive 기본값 false에서 없는 부모를 `INVALID_ARGUMENT`로 거부하고, 이미 있는 디렉터리는
성공하며 파일이 막으면 `INVALID_ARGUMENT`다.
remove는 파일, 링크 자체, 빈 디렉터리를 지운다. removeRecursive는 `fs.promises.rm({ recursive: true })`로 지우며
트리 안의 링크는 링크만 지운다. 하나의 호출이라 취소는 시작 전에만 효과가 있다.
directorySize는 `opendirSync` 순회로 파일의 논리 크기를 더하고 링크는 따라가지 않는다.
항목 100,000개와 깊이 64 상한, 취소, 어댑터 해제를 처리한다.

## 남는 위험

- 앱이 정한 폴더 안의 링크가 폴더 밖을 가리킬 수 있다. 읽기, 쓰기, 복사, 이동이 링크를 거치면 폴더 밖에 닿는다.
- 앱이 경로를 검사한 뒤 쓰기 전에 다른 프로세스가 이름이 가리키는 대상을 바꿀 수 있다.
- 다른 프로세스의 동시 쓰기나 새 hardlink 생성을 막는 OS 공유 잠금은 없다.

앞의 두 위험은 앱 명령이 경로를 정하는 단계에서 다룬다([경로 제한은 앱 명령에서 합니다](../site/src/content/docs/concepts/views-and-policy.mdx)).

## 실제 네이티브 검증

`tests/lifecycle/macos-storage.test.ts`는 Darwin에서만 독립 자식 fixture를 실행한다.
`tests/lifecycle/macos-storage.ts`는 실제 파일 시스템에서 chmod, 링크 추종, FIFO 거부, 여러 chunk의 복사,
덮어쓰지 않는 복사와 이동, 디렉터리 이동, 재귀 용량 계산과 삭제, 독립 프로세스 재시작과 fd 정리를 검사한다.
`macos-storage-directories.ts`는 목록, UTF-16 정렬, 링크 관찰, 정확한 256개 경계, 생성 계약과 삭제를 검사한다.
Linux의 skip은 네이티브 통과 근거가 아니다. `RENAME_EXCL` 값과 `renamex_np` 서명은 이 macOS 시험으로만 확인했다.

`.github/workflows/ci.yml`의 macOS native integration 작업에서 같은 fixture를 Bun으로 compile하고 기존
entitlement와 ad-hoc 서명을 적용해 실행한다. packaged storage host fixture는 두 뷰의 독립 작업 권한,
뷰 출처를 유지하는 명령, 공개 SDK 호출, 이동과 삭제, 실제 앱 재시작과 cleanup을 검증한다.

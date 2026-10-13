# macOS 저장 어댑터

`plugins/storage/src/platforms/macos.ts`는 read/write text/bytes, append,
exists/stat와 copyFile의 아홉 작업을 구현한다. 공개 계약과 Windows 코드는
변경하지 않으며 디렉터리 API는 이 PR 범위에 포함하지 않는다.
`storage.move`는 source 객체 고정 보장을 충족할 수 없어 macOS에서 `UNSUPPORTED`다.

## 호스트 통합

이 변경은 PR #164의 macOS I/O Worker foundation에 명시적으로 쌓는다.
그 foundation의 요청 검증, 작업별 권한 재검사, 실행 큐, 취소와 종료 및 dispose를
재사용하며 구현을 복제하지 않는다. storage를 `execution: "io"`로 등록하고
지원 목록에서 move를 제외한다. AppKit 메인 스레드에서 동기 파일 작업을 실행하지 않는다.
`tests/lifecycle/macos-storage-host.ts`를 공유 native runner에 추가하며 실제
ad-hoc 서명 compiled 앱의 WKWebView와 공통 SDK에서 호출한다.

## 경로와 자원

앱이 정한 POSIX 절대 경로만 받는다. 빈 이름, 반복 `/`, 끝의 `/`, `.`과 `..`,
NUL과 줄바꿈, UTF-8로 왕복하지 않는 UTF-16은 거부한다.
경로는 NUL을 포함해 1024 bytes 이하, 각 이름은 255 bytes 이하다.
생성 없이 조회하는 부모 또는 대상의 `ENOENT`만 exists의 false와 stat의 null로 바꾼다.
OS 접근 거부, 링크와 잘못된 부모는 `PERMISSION_DENIED`다.

각 부모를 이전 디렉터리의 열린 descriptor 기준으로 연다.
`O_NOFOLLOW`, `O_DIRECTORY`, `O_CLOEXEC`와 `F_GETPATH`로 링크, 부모 종류,
소유 자원과 정규 이름을 검사한다. 정규 이름의 Unicode 정규화만 NFC로 비교하며
대소문자는 유지한다. macOS의 `/tmp`와 `/var` 같은 심볼릭 링크 별칭 대신
`/private/tmp` 또는 `realpath`로 얻은 정규 경로를 사용한다.
대상은 일반 파일이며 메타데이터에서는 일반 디렉터리도 받는다.
일반 파일의 하드 링크 수가 1이 아니면 거부한다. FIFO와 장치는 읽기 전에 거부하며
`O_NONBLOCK`으로 FIFO open의 무기한 대기를 막는다.

어댑터는 자기 native binding만 소유한다. 각 호출이 모든 descriptor를 성공과 실패에서 닫는다.
dispose는 반복 가능하며 이후 호출은 `CANCELLED`다. import만으로 native binding을 열지 않는다.
Darwin arm64의 variadic ABI를 피하기 위해 시스템 `__openat`와 `__fcntl`의
고정 인자 syscall entrypoint를 호출한다. stat 구조체를 직접 해석하지 않고 Bun의
`node:fs` descriptor API를 사용한다.
Apple의 [open wrapper](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/open-base.c)를 따른다.

## 입출력과 전송

텍스트는 UTF-8이며 읽기는 잘못된 인코딩을 거부하고 BOM을 보존한다.
readText는 4 MiB, readBytes는 256 KiB를 넘으면 실패한다. 바이트 입력은 기존
canonical base64 계약을 그대로 사용한다. write는 대상 검사를 마친 descriptor에
쓴 뒤 꼬리를 자른다. `O_TRUNC`로 검사 전에 내용을 지우지 않는다.
append는 `O_APPEND`를 사용한다. 새 파일은 0600, 새 부모는 0700을 요청하며
OS umask와 상속 ACL이 적용된다. 성공 전에 파일을 fsync하고 재시작 후 파일을 유지한다.
power loss의 완전한 내구성이나 부모 디렉터리의 트랜잭션은 보장하지 않는다.

copyFile은 4 MiB 이하 원본을 열린 descriptor에서 먼저 읽고 대상을 `O_EXCL`로
생성한다. 다른 프로세스가 먼저 만든 파일, 디렉터리 또는 링크를 덮어쓰지 않는다.
대상 부모는 이미 존재해야 한다. ACL과 시각은 복제하지 않는다.
원본의 동시 쓰기는 배제할 수 없으므로 복사는 파일 전체의 일관된 스냅샷이 아니다.
쓰기 실패 시 일부 대상이 남을 수 있다. POSIX에는 열린 descriptor 자체를 unlink하는
API가 없으므로 다른 프로세스가 바꾼 경로를 다시 찾아 삭제하지 않는다.

## 기존 계약과 경합 검토

writeText와 바이트 작업의 기존 문서는 부분 쓰기, 실패 및 시작한 작업의 취소를
되돌리지 않는다고 설명한다. copyFile도 원자적 저장이나 crash recovery를 제공하지
않으며 검사, 정리 실패와 강제 종료에서 일부 대상이 남을 수 있다. 따라서 부분 쓰기를
보존하는 처리는 이 계약과 맞는다. 교체된 이름을 찾아 삭제하지 않는 규칙도 유지한다.

Windows move는 검사한 source 핸들 자체에 이름 변경을 적용한다.
이전 macOS 구현의 `renameatx_np`는 source 이름을 다시 조회하므로 검사와 변경 사이에
교체된 다른 객체를 이동할 수 있었다. 기존 source 고정 보장을 충족하지 못하므로
그 구현을 제거하고 macOS 지원 목록에서 move를 제외했다. 호출은 파일이나 이름을
바꾸기 전에 `UNSUPPORTED`로 실패한다. Windows move의 계약과 구현은 그대로다.
이 제한은 기능 동등성을 완료했다는 뜻이 아니다. descriptor 기준으로 source 객체를
고정하는 안전한 구현이 확보되기 전까지 macOS move는 미지원이다.

Darwin의 `fsetattrlist`는 파일 이름 변경을 지원하지 않는다. 디렉터리 lease는
`com.apple.private.vfs.file-leases` entitlement를 요구하므로 기존 ad-hoc 서명 범위에서 사용하지 않는다.
[Apple setattrlist의 허용 속성](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/vfs/vfs_attrlist.c)과
[lease 접근 검사](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/vfs/vfs_subr.c)를 확인했다.

열린 descriptor는 read/write가 교체된 경로를 다시 열거나 symlink를 따라가게 하지 않는다.
다른 프로세스의 동시 쓰기나 새 hardlink 생성까지 차단하는 OS 공유 잠금은 제공하지 않는다.
이는 앱 백엔드가 신뢰 코드라는 모델과 별개로 기록하는 운영체제 동시성 한계다.

## 실제 네이티브 검증

`tests/lifecycle/macos-storage.test.ts`는 Darwin에서만 독립 자식 fixture를 실행한다.
`tests/lifecycle/macos-storage.ts`는 실제 descriptor와 chmod, 링크, FIFO,
여러 chunk의 복사, 무덮어쓰기, 미지원 move의 무변경, 교체 경합, 독립 프로세스 재시작과 fd 정리를 검사한다.
parent 교체는 읽기, leaf 교체는 쓰기로 검사한다. Linux의 skip은 네이티브 통과 근거가 아니다.

`.github/workflows/macos-storage.yml`은 기존 CI 작업을 보존한 별도 macOS arm64 작업이다.
동일 fixture를 Bun으로 compile하고 기존 entitlement와 ad-hoc 서명을 적용해 실제로 실행한다.
결과는 `build/macos-storage-results.json`과 로그 artifact다. Developer ID, 공증이나
signing account는 사용하거나 변경하지 않는다. 추가 host fixture는 backend setup, 두 뷰의 독립 작업 권한, 뷰 출처를 유지하는 명령,
아홉 작업의 공개 SDK 호출, 미지원 move의 무변경과 실제 앱 재시작 및 cleanup을 검증한다.
공유 foundation fixture의 AppKit 응답성과 취소 및 폐기 검증도 기존 native runner에서 유지한다.

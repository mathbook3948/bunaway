# macOS 저장 어댑터

`plugins/storage/src/platforms/macos.ts`는 read/write text/bytes, append,
exists/stat와 copyFile, readDirectory와 createDirectory의 열한 작업을 구현한다.
공개 작업, 권한과 오류 계약은 유지한다.
`storage.move`와 `storage.remove`는 source 객체 고정 보장을 충족할 수 없어
macOS에서 `UNSUPPORTED`다. `storage.directorySize`는 Windows 핸들 고정 순회만 구현하므로
macOS에서도 `UNSUPPORTED`다.

## 호스트 통합

이 변경은 PR #164의 macOS I/O Worker foundation에 명시적으로 쌓는다.
그 foundation의 요청 검증, 작업별 권한 재검사, 실행 큐, 취소와 종료 및 dispose를
재사용하며 구현을 복제하지 않는다. storage를 기본 Worker에 등록하고
`src/operations.ts`의 입력과 출력 스키마 및 handler를 Windows와 공유한다.
platforms.macos는 operations, initialize와 dispose를 지정하며 SDK가 작업 키에서 지원 정보를 만든다.
최상위 공통 작업 맵은 없으며 공개 Storage 인터페이스는 플러그인 작성자가 정한다.
기능 메서드는 검증된 입력을 받고 이름별 execute 분기 없이 결과를 반환한다.
move와 remove에는 handler가 없다. AppKit 메인 스레드에서 동기 파일 작업을 실행하지 않는다.
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

## 디렉터리 목록과 생성

readDirectory는 검사한 디렉터리 fd를 F_DUPFD_CLOEXEC로 복제하고 fdopendir에 넘긴다.
성공한 stream은 duplicate fd를 소유하며 closedir가 해제한다. fdopendir 실패에서는
호출자가 duplicate를 닫는다. 원래 대상 fd와 부모 fd는 기존 호출 수명주기가 해제한다.
다시 경로를 열거나 자식 경로를 조회하지 않는다. readdir의 EOF와 오류는 errno로 구분한다.
Darwin arm64는 64-bit inode ABI만 제공하므로 fdopendir와 readdir의 일반 symbol을 사용한다.
개별 dirent의 record와 이름 범위, NUL terminator 및 UTF-8을 검사하고 다음 native 호출 전에
이름을 복사한다. Apple의 [dirent 구조체](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/dirent.h),
[symbol ABI](https://github.com/apple-oss-distributions/Libc/blob/main/include/sys/cdefs.h)와
[fdopendir 소유권](https://github.com/apple-oss-distributions/Libc/blob/main/gen/FreeBSD/opendir.c)을 따른다.

직접 자식 최대 256개를 UTF-16 순서로 정렬하며 초과는 INVALID_ARGUMENT다.
일반 파일, 디렉터리와 symlink의 관찰한 종류만 반환한다. dangling symlink도 link이며
hardlink는 file로 관찰한다. FIFO, 장치, socket이나 알려지지 않은 종류는 공개 schema로
표현할 수 없으므로 UNSUPPORTED다. 목록의 원자적 스냅샷은 제공하지 않는다.

createDirectory는 기존 recursive 기본값 false를 유지한다. false에서 없는 부모는
INVALID_ARGUMENT며 부모를 만들지 않는다. true에서는 검사한 부모 fd 기준으로
mkdirat를 실행한 뒤 다음 디렉터리를 연다. 새 디렉터리 mode는 0700을 요청한다.
이미 있는 일반 디렉터리는 성공하며 기존 파일은 INVALID_ARGUMENT, 링크와 잘못된 부모는
PERMISSION_DENIED다. 실패 전에 만든 디렉터리는 남을 수 있으며 이름으로 찾아 지우지 않는다.

## 기존 계약과 경합 검토

writeText와 바이트 작업의 기존 문서는 부분 쓰기, 실패 및 시작한 작업의 취소를
되돌리지 않는다고 설명한다. copyFile도 원자적 저장이나 crash recovery를 제공하지
않으며 검사, 정리 실패와 강제 종료에서 일부 대상이 남을 수 있다. 따라서 부분 쓰기를
보존하는 처리는 이 계약과 맞는다. 교체된 이름을 찾아 삭제하지 않는 규칙도 유지한다.

Windows move는 검사한 source 핸들 자체에 이름 변경을 적용한다.
이전 macOS 구현의 `renameatx_np`는 source 이름을 다시 조회하므로 검사와 변경 사이에
교체된 다른 객체를 이동할 수 있었다. 기존 source 고정 보장을 충족하지 못하므로
그 구현을 제거하고 move의 macOS handler를 선언하지 않는다. 호출은 파일이나 이름을
바꾸기 전에 `UNSUPPORTED`로 실패한다. Windows move의 계약과 구현은 그대로다.
이 제한은 기능 동등성을 완료했다는 뜻이 아니다. descriptor 기준으로 source 객체를
고정하는 안전한 구현이 확보되기 전까지 macOS move는 미지원이다.

Windows remove도 검사한 target 핸들에 FILE_DISPOSITION_INFO를 적용한다.
Darwin unlinkat는 열린 부모 fd를 받아도 target 이름을 다시 조회한다.
허용 flags에는 열린 target 객체를 지정하는 기능이 없으며 rmdir와 Carbon delete도
이름을 조회한다. fstat로 identity를 다시 비교해도 비교와 unlink 사이의 교체를 막지 못한다.
[Apple unlinkat 구현과 허용 flags](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/vfs/vfs_syscalls.c)를
검토했으며 기존 ad-hoc 서명에서 사용할 unprivileged handle-bound 삭제를 확보하지 못했다.
따라서 remove의 macOS 메서드나 handler를 구현하지 않는다. 파일, 빈 디렉터리, 링크와 없는 경로에
대한 호출 모두 UNSUPPORTED로 실패하고 어떤 이름도 삭제하지 않는다. 이 제한은
macOS 디렉터리 동등성의 남은 blocker이며 Windows remove의 강한 보장은 유지한다.

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
`macos-storage-directories.ts`는 목록, UTF-16 정렬, 링크와 hardlink 관찰, 정확한 256개 경계,
생성 계약과 미지원 remove의 무변경을 추가한다. parent 교체는 읽기, 목록과 생성,
leaf 교체는 쓰기로 검사한다. Linux의 skip은 네이티브 통과 근거가 아니다.

`.github/workflows/ci.yml`의 기존 macOS native integration 작업에서 동일 fixture를
Bun으로 compile하고 기존 entitlement와 ad-hoc 서명을 적용해 한 번 실행한다.
packaged storage host fixture도 공유 native runner에서 한 번 실행한다. 기존 다섯 CI 작업의
이름과 coverage를 유지하며 별도 작업을 추가하지 않는다. 결과와 실패 진단은 기존
macos-native-diagnostics artifact에 포함한다. Developer ID, 공증이나
signing account는 사용하거나 변경하지 않는다. 추가 host fixture는 backend setup, 두 뷰의 독립 작업 권한, 뷰 출처를 유지하는 명령,
열한 작업의 공개 SDK 호출과 디렉터리별 권한, 미지원 move와 remove의 무변경,
실제 앱 재시작 및 cleanup을 검증한다.
공유 foundation fixture의 AppKit 응답성과 취소 및 폐기 검증도 기존 native runner에서 유지한다.

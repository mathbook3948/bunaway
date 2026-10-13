# macOS opener 독립 어댑터

`plugins/opener/src/platforms/macos.ts`는 기존 `openUrl`, `openFile`, `revealFile` 작업을
구현한다. 공통 호스트의 I/O Worker를 통해 실행한다. Windows 구현과 공개 계약은
변경하지 않는다. 지정 앱의 `.exe` 계약과 휴지통 작업은 이 변경에 포함하지 않는다.

## 실행과 수명

`macos-workspace.ts`는 AppKit의 NSWorkspace에 직접 Objective-C FFI 호출을 보낸다.
URL과 파일은 `openURL:`, Finder 선택은 `selectFile:inFileViewerRootedAtPath:`를 사용한다.
셸 명령, AppleScript나 앱의 직접 자식 프로세스로 실행하지 않는다. 반환값이 참이면
요청을 접수한 것으로 보고 `null`을 반환한다. 거짓이면 `INTERNAL`이다. 기본 앱의 실행,
문서 읽기와 Finder 화면의 선택 완료를 기다리지 않는다.

각 동기 호출은 자체 autorelease pool을 만들고 성공과 실패 모두에서 비운다. 어댑터 종료는
파일 검사 바인딩과 workspace 바인딩을 해제한다. 반복 종료는 안전하며 이후 작업은
`CANCELLED`이다. 호출이 접수된 뒤에는 취소나 어댑터 종료로 외부 앱을 닫지 않는다.

`macos-path.ts`는 `/`로 시작하는 절대 POSIX 파일 경로를 검사한다. 기존 작업 스키마의
경로 예산을 확대하지 않으며 259 UTF-16 코드 단위와 이름별 255 UTF-8 바이트를 넘으면
거부한다. 상대 경로, 빈 이름, 중복 구분자, `.`과 `..`, 제어 문자와 잘못된 Unicode를
거부한다. 한글, 공백, 쉼표, 따옴표와 POSIX에서 유효한 역슬래시는 그대로 전달한다.

`macos-file.ts`는 루트부터 `openat`과 `O_NOFOLLOW`로 부모 디렉터리를 따라가고 읽을 수
있는 일반 파일만 허용한다. 심볼릭 링크와 하드 링크를 거부하고 디렉터리와 다른 파일
종류는 `INVALID_ARGUMENT`으로 처리한다. 없는 파일은 `INVALID_ARGUMENT`과
`details.reason: "FILE_NOT_FOUND"`, 접근 거부는 `PERMISSION_DENIED`다. 요청 직전에
파일 identity를 다시 확인하고 모든 descriptor는 요청 종료 때 닫는다.

POSIX descriptor는 경로 이름의 rename이나 교체를 막지 않는다. NSWorkspace가 경로를
다시 읽는 시점의 경쟁은 남아 있다. Windows의 삭제 공유를 금지한 핸들 고정과 같은 보장을
하지 않는다. OS가 요청을 접수한 뒤 파일 소실이나 연결 앱 실패도 결과에 포함하지 않는다.

## 호스트 기반 작업과 등록

공통 호스트의 공유 I/O dispatch를 사용한다. 호스트는 실행 직전에 살아 있는 호출 컨텍스트, 해당 작업 권한과 취소를
검사한다. NativeAdapter의 동기 `execute`는 권한 token을 받지 않으며 승인된 호출만 받는다.
파일 검사와 NSWorkspace 호출 사이에는 비동기 대기가 없다.

`src/index.ts`는 macOS `execution: "io"`에 `openUrl`, `openFile`, `revealFile`만 등록한다.
지정 앱 두 작업은 macOS 지원 목록에서 제외한다. 공개 기본 파일 helper는 POSIX와 Windows
경로 표기를 받으며 해당 OS 어댑터가 플랫폼 검증을 수행한다. 기존 Windows
`normalizeFilePath`와 `.exe`용 `normalizeApplicationPath`는 그대로 유지한다.
공개 계약의 필드, 이름과 길이 예산을 바꾸지 않는다.

`tests/lifecycle/run-native.ts`에는 이 기능의 독립 Worker 검사와 `macos-opener-host.ts`를 추가한다.
폐기 가능한 실행 세션에서 호출자가 `BUNAWAY_OPENER_ISOLATED=1`을 지정했을 때만
실행한다. macOS CI는 이 값을 명시하고 일반 로컬 native 검사에는 자동으로 지정하지 않는다.

## 검증 범위

`tests/lifecycle/macos-opener.test.ts`는 POSIX 문법, 기존 작업별 권한, 선택 앱 미지원,
요청 접수와 반복 정리를 검사한다. macOS에서는 실제 descriptor와 NSWorkspace 초기화,
읽기 거부, 링크와 파일 소실도 검사한다. workspace 검사의 초기화는 라이브러리와 symbol
로드를 뜻하며 실제 요청 접수는 다음 네이티브 fixture에서 검사한다. 다른 OS에서 건너뛴
검사는 네이티브 결과가 아니다.

`macos-opener-native.test.ts`는 폐기 가능한 macOS CI 세션에서만
`BUNAWAY_OPENER_ISOLATED=1`로 실행한다. 기존 entitlement와 ad-hoc 서명으로 Bun fixture
앱을 만들고 고유 확장자의 파일을 실제 NSWorkspace로 전달해 인자를 기록한다. loopback
HTTP/HTTPS URL은 runner의 기본 브라우저에 요청하며 NSWorkspace의 접수 결과를 확인한다.
브라우저의 페이지 로딩은 검사하지 않는다. 고유 문서 타입을 선언한 fixture 앱을 저장소의
`build` 아래에 등록하고 기본 handler 설정은 변경하지 않는다. 기본 브라우저를 바꾸지 않으며 `finally`에서
fixture 앱 종료를 확인하고 등록과 파일을 정리한다. 사용자 파일이나 clipboard는 읽거나
바꾸지 않는다. 개인 데스크톱에서 실행하지 않는다. 등록 뒤에는 최대 10초 동안 실제 앱과
문서 handler가 fixture의 파일 identity로 조회되는지 확인한다. 조회되지 않으면 실패하며
설정 변경으로 우회하지 않는다.

독립 Worker 검사는 NativeRegistry로 작업별 권한과 승인 전 취소를 검사한다.
`macos-opener-host.ts`는 기존 entitlement로 ad-hoc 서명한 compiled 앱의 실제 WKWebView,
Core, macOS 호스트와 설치된 opener I/O 어댑터를 연결한다. 공개 POSIX helper로 파일과
HTTP/HTTPS를 열고 Finder 요청을 제출한다. 다른 뷰의 권한 거부, 지정 앱 미지원, 취소와
정상 호스트 종료를 검사하며 receiver의 파일 수신을 별도로 확인한다. Finder 검사는 OS
요청 접수만 확인하며 실제 선택 UI를 읽지 않는다.
결과는 `build/macos-opener-results.json`, `build/macos-opener-host-results.json`과 CI 로그에
기록한다. 기존 `.github/workflows/ci.yml`의 macOS arm64 작업에서 독립 Worker 검사와
`run-native.ts`의 compiled 호스트 검사를 각각 한 번 실행한다. 기존 호스트와 배포 검사도 유지한다.

Linux에서 고정 Bun 1.4.2로 계약 검사를 수행했다. 실제 macOS 결과는 해당 head의 CI에서
확인해야 한다. 초기 네이티브 검사에서는 기본 앱 요청이 `INTERNAL`로 실패했으며,
독립 handler 조회와 세부 오류로 원인을 검사한다. 성공 assertion을 유지하며 실패한
네이티브 검사를 지원 근거로 보지 않는다. 사용자 화면 검증도 별도 근거가 필요하다.

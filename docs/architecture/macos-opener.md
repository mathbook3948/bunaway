# macOS opener 독립 어댑터

`plugins/opener/src/platforms/macos.ts`는 기존 `openUrl`, `openFile`, `revealFile` 작업을
구현한다. 호스트의 공통 I/O 연결과 공개 등록은 별도 작업이다. Windows 구현과 공개 계약은
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

## 호스트 소유자의 연결 조건

1. 공통 macOS I/O dispatch는 어댑터 실행 직전에 살아 있는 호출 컨텍스트, 해당 작업 권한과
   취소를 검사해야 한다. 현재 NativeAdapter의 `execute`는 권한이나 취소 token을 받지 않는다.
   파일 검사와 NSWorkspace 호출 사이에는 비동기 대기가 없다.
2. opener의 `src/index.ts`에 macOS `execution: "io"`, `createOperations`와 작업 목록
   `["openUrl", "openFile", "revealFile"]`만 등록해야 한다. `openFileWith`와 `openUrlWith`는
   macOS 지원 목록에서 제외한다. 현재 독립 어댑터도 두 작업을 `UNSUPPORTED`로 거부한다.
3. 공개 `openFile`과 `revealFile` helper의 POSIX 입력 경로를 연결해야 한다. 기존
   `normalizeFilePath`와 `.exe`용 `normalizeApplicationPath`는 Windows 계약 그대로다.
   그 계약이나 선택 앱의 의미를 조용히 바꾸지 않고 플랫폼별 검증 경계를 정해야 한다.
4. 실제 호스트 fixture와 `tests/lifecycle/run-native.ts`에 작업 권한 거부, 승인 전 취소,
   컨텍스트 폐기와 I/O Worker 종료 회귀를 연결해야 한다. 이 변경은 공유 호스트 파일을
   수정하지 않는다. 연결 전에는 설치된 공개 패키지가 macOS opener를 제공하지 않는다.

## 검증 범위

`tests/lifecycle/macos-opener.test.ts`는 POSIX 문법, 기존 작업별 권한, 선택 앱 미지원,
요청 접수와 반복 정리를 검사한다. macOS에서는 실제 descriptor와 NSWorkspace 초기화,
읽기 거부, 링크와 파일 소실도 검사한다. 다른 OS에서 건너뛴 검사는 네이티브 결과가 아니다.

`macos-opener-native.test.ts`는 폐기 가능한 macOS CI 세션에서만
`BUNAWAY_OPENER_ISOLATED=1`로 실행한다. 기존 entitlement와 ad-hoc 서명으로 Bun fixture
앱을 만들고 고유 확장자의 파일을 실제 NSWorkspace로 전달해 인자를 기록한다. loopback
HTTP/HTTPS URL은 runner의 기본 브라우저에 요청하며 NSWorkspace의 접수 결과를 확인한다.
브라우저의 페이지 로딩은 검사하지 않는다. 기본 브라우저를 바꾸지 않으며 `finally`에서
fixture 앱 종료를 확인하고 등록과 파일을 정리한다. 사용자 파일이나 clipboard는 읽거나
바꾸지 않는다. 개인 데스크톱에서 실행하지 않는다. 첫 CI에서 기본 handler 변경이 OSStatus
`-54`로 거부되어 해당 변경을 제거했다. 권한 제한을 우회하지 않는다.

실제 어댑터는 독립 Worker에서 실행하고 fixture dispatcher가 기존 NativeRegistry로
작업별 권한과 승인 전 취소를 검사한다. 이것은 아직 연결하지 않은 제품 호스트의 검증을
대신하지 않는다. Finder 검사는 OS 요청 접수만 확인하며 실제 선택 UI를 읽지 않는다.
결과는 `build/macos-opener-results.json`과 CI 로그에 기록한다. 별도
`.github/workflows/macos-opener.yml`이 실제 arm64 검사를 수행하고 기존 CI 작업은 유지한다.

Linux에서 고정 Bun 1.4.2로 계약 검사를 수행했다. 실제 macOS 결과는 해당 head의 CI에서
확인해야 하며, 공개 호스트 연결과 사용자 화면 검증은 별도 근거가 필요하다.

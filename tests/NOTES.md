# 검증 노트

각 fixture와 테스트가 검사하는 세부 동작과 그 근거를 변경 순서대로 기록한 참고 자료다.
어떤 변경에 어떤 검사를 돌릴지는 [tests/README.md](./README.md)의 표를 따르고, 이 문서는
특정 fixture의 동작 범위나 과거 결정의 이유가 필요할 때 검색해서 읽는다.
새 기록은 해당 영역의 절 끝에 덧붙이며, 실행 결과 자체는 PR과 `docs/architecture/*-results.md`에 남긴다.

`fixtures/native-child-diagnostics.ts`는 실제 자식 프로세스의 stdout과 stderr를 동시에 읽고
원본 바이트와 종료 코드, signal, 실행 단계와 경과 시간을 보관한다.
실행기가 기한 초과로 중단한 자식은 정상 정리로 0을 반환해도 실행 실패로 처리한다.
macOS storage, appearance와 WebView controls 실행기는 보고서가 없거나 검사에 실패하면
보관한 출력과 호스트 로그를 CI 로그에도 출력한다. 재시작과 권한 시나리오는 서로 다른
진단 디렉터리를 사용한다. 종료 코드가 0이어도 기존 보고서 검사를 모두 통과해야 한다.
`lifecycle/native-child-diagnostics.test.ts`는 실제 프로세스에서 성공과 실패, 큰 출력과
CLIXML 및 UTF-8이 아닌 바이트의 보존과 POSIX 기한 초과 종료 뒤 0 반환의 거부를 검사한다.
`fixtures/macos-startup-diagnostics.ts`는 storage와 controls 자식의 기존 기한을 유지하며
부모에서 host 및 현재 사용자 WebKit 서비스의 PID, 상태와 CPU 시간을 최대 네 번 기록한다.
WebKit 서비스는 특정 창 소유로 단정하지 않는다. 초기 지연 checkpoint 또는 10초 이상 실행에서
짧은 sample을 한 번 수집하고 허용한 함수 분류의 개수만 저장한다. 원본 stack, 명령행, 경로와
URL은 저장하지 않는다. 진단 명령은 2초로 제한하고 자식 종료 시 함께 정리한다.
기존 host 로그의 delegate 오류, 종료 및 asset 도달 단계와 `startup-processes.json`을 비교한다.
Windows native CI의 호스트 단계는
cmd 파일 리다이렉션으로 출력을 보관하고 원래 종료 코드를 반환하므로 중첩 PowerShell
진단이 XML 파서 오류로 바뀌지 않는다. notification의 PowerShell probe도 같은 실행기를
사용하며 기존 20초 기한, 단계별 경과 시간과 원본 출력을 Windows native 로그에 보관한다.

계약 테스트는 `bun test ./tests`로 실행한다. `bunfig.toml`의 `[test] root`가 `tests`이므로
`bun test tests/api`처럼 필터로 실행해도 build 디렉터리의 테스트 복사본은 수집하지 않는다.
`docs/text-style.test.ts`는 `scripts/check-text-style.ts`로 추적 중인 문서와 소스 텍스트에서
em dash와 middle dot을 거부하며, 같은 스크립트가 commit-msg 훅에서 커밋 메시지를 검사한다.
`fixtures/native-platform.ts`는 실제 플러그인 정의의 SDK factory를 사용한다. 네이티브 드라이버를 주입하는
fixture도 운영 작업 목록과 자원 소유자를 재사용하며 별도 dispatch 구현을 만들지 않는다.
`cli/plugin-build.test.ts`는 재내보내기와 operation 객체, 네이티브 스키마 변환 보존 및 공개 선언에서 내부 타입 제외를 검사한다.
패키지 내부의 # 별칭도 상대 import와 같은 OS 분리와 빌드 실패 시 출력 보존을 적용한다.
조건부 # 별칭의 browser와 bun, import와 require 선택, 중첩 wildcard 별칭과 외부 의존성 유지도 검사한다.
외부 의존성에는 Bun 전용 exports와 플랫폼 경계에 해당하는 파일 이름을 사용하며 내부와 외부 대상이 섞인 별칭도 검사한다.
`cli/plugin-imports.test.ts`는 중첩 조건의 default 복귀, 배열과 wildcard 우선순위, module과 node 및 환경 조건을 Bun 결과와 비교하고 null 차단도 확인한다.
로컬 browser 대체, 비공개 별칭의 false 제외와 tsconfig 별칭도 Bun 결과와 비교한다. Bun이 거부하는 제외 경로는 빌드 실패를 유지한다.
`cli/plugin-build.test.ts`는 dist만 설치한 브라우저 소비자에서 대체와 제외 결과를 실행하고 네이티브 출력의 원본 구현 및 플랫폼 분리를 확인한다.
dist만 설치한 소비자 프로세스에서 두 출력과 실제 어댑터를 실행하고, 네이티브 대상의 해석 실패 뒤 기존 출력을 비교한다.
`cli/distribution.test.ts`는 설치한 CLI로 별칭을 사용하는 외부 플러그인을 빌드한 뒤,
src 없이 dist만 설치해 공개 호출과 재내보낸 타입을 검사한다.
원본 구현을 직접 검사하는 tests/tsconfig.json은 bunaway-source 조건으로 각 플러그인의
소스를 선택한다. 배포 패키지를 검사하는 생성 앱은 이 조건을 사용하지 않는다.

`api/native-plugin-object.test.ts`는 기본 export를 직접 호출하고 `defineApp`에 등록하는 계약,
이벤트 타입 추론, 숨겨진 등록 메타데이터와 예약 이름의 충돌 거부를 검사한다.

`lifecycle/macos-appearance.ts`는 각 실행의 stdout, stderr와 종료 원인을
`build/macos-native-logs/appearance/`에 보존한다. 기동 기한은 60초이며 도달하면
호스트가 종료 코드 0을 반환해도 실패로 처리하고, 보고서 누락을 포함한 실패 시
임시 디렉터리를 지우기 전에 호스트 로그와 기한, 경과 시간 진단을 출력한다.

공식 플러그인 fixture는 스키마만 있는 공통 계약 목록 대신 완성된 작업 선언의 스키마를 사용한다.
`api/native-handler-platform.test.ts`는 동기 handler의 반환 타입도 보존하는지 검사한다.
동시 정리의 공유, 실패 후 재시도와 성공 후 반복 방지, 비동기 초기화의 타입 및 런타임 거부,
늦게 반환된 인스턴스 회수와 초기화 및 회수 실패의 진단도 검사한다.

`api/native-handler-platform.test.ts`는 플랫폼별 operations 키에서 지원 정보 생성, 인스턴스별 초기화와
정리, 기본 worker 스레드와 명시적인 ui 스레드, 동기 및 비동기 반환, 입력과 출력 변환 횟수,
미지원 작업과 안전한 오류, 동일 작업의 플랫폼별 스키마 선택을 검사한다. `api/native-plugins.test.ts`와 `cli/plugins.test.ts`는
이전 execution 설정과 잘못된 thread 값의 거부도 검사한다.
`lifecycle/plugin-async-parsing.test.ts`는 실제 I/O Worker에서 handler 실행 context 전달과
입력 콜백의 권한 승인, 실행 재승인 및 취소된 파서의 늦은 완료를 검사한다.
storage의 플랫폼별 작업 샘플은 `windows-bun-storage.ts`의 실제 Windows 파일 시스템 검사와
`windows-storage-metadata.ts`의 WebView, I/O Worker 호출을 함께 사용한다.
macOS는 `macos-storage.ts`와 `macos-storage-directories.ts`에서 실제 파일 시스템 검사를 하며
`macos-storage-host.ts`에서 실제 SDK와 I/O Worker 호출을 검증한다.

`lifecycle/macos-safe-storage.test.ts`는 합성 Keychain으로 lazy 준비, 키 생성 경합,
접근 실패 뒤 키 보존과 재시도, 작업별 키 지우기, 버전과 namespace 인증, 변조와 크기 상한을
검사한다. AES-GCM은 Python cryptography로 생성한 고정 벡터와 비교한다.
`lifecycle/macos-keychain-native.test.ts`는 실제 Security.framework와 합성 데이터로
disposable private Keychain을 만들고 공유 Bun과 ad-hoc compiled 실행 파일에서 Unicode,
바이트 상한, 변조, 잠금 상태와 같은 실행 파일의 프로세스 재시작을 확인한 뒤 삭제한다.
사용자 secret(`setSecret`, `getSecret`, `deleteSecret`)은 같은 Keychain에서 교체, 다른 `app.id`와의 분리, 삭제와 재시작한 프로세스의 조회 및 삭제를 확인한다.
기본 Keychain과 search list, trust, ACL이나 signing identity는 바꾸지 않는다.
사용자의 login Keychain과 실제 credential, 시스템 UI 선택, 다른 서명 빌드로의 이전은
검증하지 않는다. 기존 macOS native CI에서 별도로 실행하고 로그를 보관한다.
`lifecycle/macos-safe-storage-host.ts`는 PR164의 수정된 I/O foundation과 실제 WKWebView,
공개 backend/client API 및 운영 factory를 공유 Bun과 ad-hoc compiled 호스트에서 사용한다.
내부 provider만 disposable Keychain으로 지정하며 검증한 패키지의 identity 전달,
호출자의 appId 거부, 개별 정책, 문자열과 바이트 왕복, 동일 실행 파일의 재시작 복호화와
Core 정리 뒤 네이티브 정리를 확인한다. 결과는 `build/macos-safe-storage-results.json`이다.
`lifecycle/macos-store.ts`는 ad-hoc 서명한 compiled 앱과 실제 WKWebView에서 운영 `store` 플러그인을
사용한다. 백엔드가 defaults 병합(파일에 없는 default 키 채움 포함), 저장 파일 모드(0600, 폴더 0700), 저장 전 파일 없음, reload의
`ignoreDefaults`, reset 뒤 reload, 쓰기 불가 폴더에서 저장 실패 시 원본 보존과 임시 파일 없음, 손상 파일의
`error`와 `reset`, autosave 대기, 저장하지 않은 저장소의 종료 시 flush를 실행하고, 같은 실행 파일을 다시
시작해 파일에서 `file`로 읽히는지 확인한다. 화면은 `store.get`만 허용받아 쓰기 거부와 경로 형태 이름 거부를
확인한다. 변경 이벤트는 다루지 않는다. 결과는 `build/macos-store-results.json`과
`build/macos-store-diagnostics/`이다.
`macos-bun.test.ts`의 macOS 설정 단위 검사는 선언과 호출별 창 옵션에서 `visible`과
`showWhenReady`를 허용하고 배치, titlebar, alwaysOnTop, 초기 상태를 `UNSUPPORTED`로
거부하는지 확인한다. 같은 파일의 identity 회귀는 실제 Worker와 호스트 수명을 사용하지만 네이티브 UI를
대체한 계약 검사다. 이 검사나 번들 성공을 macOS 실행 증거로 보고하지 않는다.

초기 `maximized`와 `fullscreen`은 `windows-bun-window-api.ts`에서 일반 복원 영역과
표시 상태를 검사합니다. 이 실행기는 실제 WebView2와 WinEvent를 사용하는 숨김 준비 fixture도
네 옵션 조합으로 실행하므로 `mise run host:windows`에서 일시적인 표시와 활성화, 포커스를 검사합니다.
실제 다중 물리 모니터와 혼합 DPI 수동 검증을 대신하지 않습니다.

`api/webview-print-ui.test.ts`는 인쇄 UI의 개별 권한, browser 기본값과 system 선택,
경로와 silent 입력 거부, 취소와 닫힌 창 및 플랫폼 서비스 부재를 확인한다.
`lifecycle/windows-webview-print-ui.ts`는 `mise run host:windows`에서 실제 Win32와
WebView2 문서에 browser 인쇄 UI를 요청하고 반복 요청 및 종료 뒤 native 자원 정리를
확인한다. 실제 COM ABI의 E_NOINTERFACE도 optional 조회와 required 조회로 구분한다.
결과는 `build/windows-webview-print-ui-results.json`에 기록한다.
system UI 사용자 선택과 물리 프린터 출력은 별도 검증이며 테스트가 인쇄 제출을 하지 않는다.

`lifecycle/macos-webview-controls.test.ts`는 공개 작업 지원 목록, URL과 zoom 경계,
생성 중과 닫힌 소유자의 거부를 검사한다. `lifecycle/macos-webview-controls.ts`는
기존 `host:macos`에서 실제 compiled WKWebView와 백엔드 Worker의 공통 SDK를 실행한다.
문서 상태, origin과 redirect 거부, 서브프레임 신원, history, reload, 느린 탐색 중단,
문서 교체의 명령 취소와 fragment 세션 유지, zoom 및 닫기와 재생성을 검사한다.
각 문서의 대기 명령이 백엔드에 등록된 뒤 history 이동과 reload를 시작한다.
도착 응답과 명령 등록 사이의 경합이 취소 검사를 건너뛰지 않게 하며 기존 횟수와 기한은 유지한다.
scheme과 hostname을 대문자로 작성한 자산 URL에서도 실제 문서와 SDK 연결을 확인한다.
`pageshow`와 `pagehide`의 `persisted`, `isTrusted`를 SDK와 독립적으로 기록한다.
실제 history cache 복원과 합성 persisted 이벤트의 reload 검사를 결과에서 구분한다.
합성 검사는 실제 WKWebView에서 기존 SDK를 닫고 같은 history 항목의 새 문서와 SDK를 요구한다.
신뢰된 persisted 이벤트가 없으면 실제 history cache 복원의 실행 근거로 사용하지 않는다.
결과와 실패 로그는 macOS native CI artifact에 포함한다. macOS DevTools, 다운로드,
창 readiness API와 출시 배포 서명은 이 검사의 범위가 아니다.

`lifecycle/macos-log-capabilities.test.ts`는 생성한 macOS export와 실제 임시 파일로
JSON 줄의 순서와 출처, 새 파일 권한, 반복 회전, 기록과 회전 실패 후 복구,
입력과 작업 권한, 폐기 및 호스트가 정한 지원 목록을 검사한다.
`macos-log-capabilities-compiled.test.ts`는 현재 OS에서 macOS 어댑터 probe를 Bun으로
compile하고 원본 파일을 제거한 뒤 실행한다. 실제 macOS native CI에도 포함하며
호스트의 전체 실행 경로를 대신하지 않는다.
`macos-log-capabilities.ts`는 ad-hoc 서명한 compiled 앱과 실제 WKWebView에서 백엔드 및
뷰 기록, 권한 거부, 쓰기 실패 후 복구, 회전, 백엔드의 최소 level 변경과 flush 호출 성공,
WebView의 `log.configure`와 `log.flush` 거부, manifest의 등록한 작업과 기능 목록의 일치
및 정상 종료를 검사한다. `run-native.ts`에 포함하며 결과와 앱 데이터 진단은
`build/macos-log-capabilities-results.json`과 `build/macos-log-capabilities-diagnostics/`에 남긴다.
앱과 화면의 코드는 `fixtures/macos-log-capabilities/`의 타입 검사 대상이며 실행 전
정책 권한 이름도 실제 설치된 플러그인 계약으로 검사한다.
`macos-autostart-host.ts`는 shared Bun과 ad-hoc 서명한 compiled 앱의 백엔드에서 autostart의 등록, 반복 등록,
숨김 시작 거부, 해제와 재실행 뒤 조회를 실행하고 호스트가 사용자 홈으로 받은 HOME 아래 `Library/LaunchAgents`의 plist(launchd가 읽는 위치이며 앱 데이터 루트나 계정의 실제 홈에 쓰이면 실패한다)를 `plutil -lint`와
`plutil -convert json`으로 검사한다. `run-native.ts`에 포함하며 결과와 진단은 `build/macos-autostart-results.json`과
`build/macos-autostart-diagnostics/`에 남긴다. 정책 권한 이름은 실행 전에 설치된 플러그인 계약으로 검사한다.

`lifecycle/windows-ui-lifecycle.test.ts`는 운영 UI Worker와 창 플러그인을 실행하며 Win32와
WebView 경계만 제어한다. 닫기 확인 거부와 마지막 창의 quit 취소, 재생성 성공 시 임시
프로필 보존, constructor와 controller 생성 실패 및 네이티브 정리 후 재생성 취소를
검사한다. 실제 임시 디렉터리와 저장 파일로 프로필의 보존과 삭제를 확인하고,
반복 종료와 부모 입력 복원 재시도에서 HWND와 COM 정리가 중복되지 않는지 검사한다.
이는 계약 및 자원 소유권 검사이며 실제 HWND, COM, WebView2 실행은 기존
`mise run host:windows`와 Windows native CI에서 별도로 검증한다.

다운로드 UI-loop regression은 생성된 worker 경계에서 전용 `windows-download-cleanup/ui.ts`를
번들하고 실제 승인 transfer의 cancel 자원만 일시적으로 실패시킨다. 소유 창을 닫는 동안
SDK 응답이 진행하고, 소유자의 재시도도 복구되는지
확인한다. 운영 worker와 다른 테스트 프로세스는 주입하지 않는다. 순수 모델은 조절한 시계로
재시도 간격과 기한, 자원 보존을 검증하고 cancelled snapshot의 interruptReason을 검사한다.

다운로드의 실패 regression은 metadata 조회 실패와 native Cancel 실패를 독립적으로
주입해 취소 재시도와 cleanup의 소유권을 확인한다. 브라우저 UI 재개 뒤 paused 상태,
JSON escape와 UTF-8 metadata 한도, 만료 retained 항목의 aggregate 예산 및 최대 식별자의
실제 protocol response 직렬화도 검증한다.

`api/webview-downloads.test.ts`는 Zod 계약, 개별 작업 권한과 backend 출처 검사를 확인한다.
renderer에 모든 다운로드 권한을 허용해도 작업이 실행되지 않으며 호출자가 임의 저장 경로를
전달할 수 없는지 검사한다. `lifecycle/downloads.test.ts`는 pending 승인 기한, 상한과 슬롯 회수,
탐색 시 pending 거부, 승인된 작업의 수명, pause/resume과 종료 기록 및 실패 시 자원 정리를 확인한다.
`lifecycle/windows-webview-downloads.ts`는 `mise run host:windows`에서 실제 UI Worker와
WebView2 다운로드를 실행한다. 기본 거부, renderer 권한 거부, 항목별 승인과 거부, 실제 파일
내용과 byte 진행, pause/resume/cancel, 승인 기한, 탐색 및 종료 시 pending 정리를 검증한다.
승인된 전송과 pending 요청이 함께 있는 브라우저를 종료해 죽은 broker에 작업을 보내지 않고
COM 참조, timer와 창 자원을 정리하는지도 확인한다.
기존 multiple-automatic-downloads 권한 거부를 유지하며 제어 시나리오는 새 WebView에서
첫 다운로드로 실행한다. 마지막 장애 검사는 browser 프로세스에서
승인된 전송과 pending 요청을 각각 유지한다. 자동 다운로드 권한을 허용하는 검증이 아니다.
테스트가 기록한 고유한 브라우저 기본 경로의 파일만 지운다. 사용자 지정 경로, 물리 다운로드 UI
조작이나 앱 재실행 후 재개 검증은 포함하지 않는다. 결과는
`build/windows-webview-downloads-results.json`에 기록한다.

`lifecycle/macos-clipboard-adapter.test.ts`는 RGBA TIFF의 endian, alpha, orientation과 unsigned SampleFormat,
크기와 잘못된 외부 데이터 및 네이티브 호출 전 권한과 취소를 검사한다.
`lifecycle/macos-clipboard-native.test.ts`는 고유 이름의 실제 NSPasteboard에서 Unicode,
빈 텍스트, 없는 형식, HTML/RTF, RGBA 상한과 자원 정리를 확인한다. 같은 보드에서
`changeCount` 비교가 어댑터의 쓰기와 두 번째 바인딩의 쓰기를 `waitForChange`와
`clipboard.changed` 발행으로 알리고, 대기 직전의 쓰기로는 대기가 풀리지 않으며 종료 시
대기가 `CANCELLED`로 끝남을 확인하고 `changeCount` 1회 읽기 시간을 로그로 남긴다.
`api/clipboard-macos-change.test.ts`는 이 폴러를 수동 비교(`flush`)로 구동해 기준값, 합쳐짐,
읽기 실패 재시도, 종료 뒤 정지와 이벤트 서비스가 없을 때의 `INTERNAL`을 결정적으로 검사한다.
`lifecycle/macos-dialog-native.test.ts`는 실제 NSOpenPanel과 NSSavePanel의 파일, 폴더, 다중 선택,
숨김 항목, 기본 위치와 이름, 허용 확장자를 AppKit에서 다시 읽고, 모달 패널을 예약한 `cancel:`로 닫아
사용자 취소 결과를 확인한다. 실제 NSAlert의 문구, 버튼 순서와 key equivalent, 스타일, 확인란도 다시 읽고,
모달 알림을 예약한 `performClick:`으로 눌러 버튼 순번과 확인란 상태를 확인한다.
항목을 고르는 사용자 조작과 Return, Escape 입력은 자동화하지 않는다.
`lifecycle/macos-clipboard-webview.ts`는 compiled macOS host, WKWebView와 공개 SDK에서
backend setup과 뷰 명령의 권한 보존, 다중 형식, 파일 목록 거부, 뷰에서 호출한 `waitForChange`가
쓰기 뒤 `sequence`와 `changedAt`을 반환함(`change` 결과)과 종료를 확인한다.
macOS native CI에서 `BUNAWAY_CLIPBOARD_NATIVE=1`로 실행한다. WKWebView 검사는 CI
데스크톱의 일반 클립보드를 변경하고 종료 시 fixture 내용을 지우므로 개인 데스크톱에서
실행하려면 이 동작을 먼저 확인한다. 결과는 `build/macos-clipboard-results.json`이다.

`api/webview-controls.test.ts`는 기본 WebView 제어의 Zod 입력과 출력, 개별 작업 권한,
닫힌 창과 취소, 플랫폼 서비스 부재 및 네이티브 오류 전파를 검사한다.
`lifecycle/windows-webview-controls.ts`는 `mise run host:windows`에서 실제 UI Worker와
WebView2를 실행한다. URL과 제목, history, reload와 stop, 허용하지 않은 origin 및 redirect,
탐색에 따른 진행 중 명령 취소, 같은 문서 fragment의 세션 유지, zoom 조회와 적용,
창 전환에 따른 `focused` 변화와 조회가 포커스를 바꾸지 않음, 창 종료 뒤 `isOpen` 및
개발 모드 DevTools 열기와 프로덕션 거부를 확인한다. DevTools의 물리 조작과 paint,
실제 모니터 및 하드웨어 검증은 포함하지 않는다. 결과는
`build/windows-webview-controls-results.json`에 기록한다.
`api/webview-audio.test.ts`는 audio 작업의 개별 권한, 엄격한 boolean 입력, 음소거와 재생의
독립 상태, 취소와 닫힌 창 및 플랫폼 서비스 부재를 검증한다.
`lifecycle/windows-webview-audio.ts`는 `mise run host:windows`에서 실제 WebView2의 음소거
변경과 반복 설정, 문서 탐색 뒤 유지, 준비 전과 종료 후 거부 및 native 자원 정리를 확인한다.
결과는 `build/windows-webview-audio-results.json`이다. 조용한 문서를 사용하며 재생 중인
audio와 물리 장치 출력은 별도 수동 검증이다.
`lifecycle/windows-webview-color-scheme.ts`는 `mise run host:windows`에서 실제 WebView2와 appearance
컨트롤러로 창 생성 전에 고른 dark가 첫 문서에 보이는지, light와 dark 전환이 열린 문서의
`prefers-color-scheme` 변경 이벤트로 전달되는지, 탐색 뒤 값이 유지되는지, system과 플러그인 종료가
OS 설정으로 되돌리는지, 닫는 중 요청이 거부되지 않는지를 확인한다. 결과는
`build/windows-webview-color-scheme-results.json`이다. 고대비 세션과 같은 프로필을 공유하는 두 창의
동시 지정과, OS 앱 테마가 dark인 러너에서 플러그인 종료 시 복원(화면 값이 바뀌지 않음)은 포함하지 않는다.
고대비 세션이나 오래된 런타임에서는 콘텐츠 검증을 건너뛰고 결과 JSON의 `skipped`에 사유를 남긴다.

`api/window-taskbar.test.ts`는 작업 표시줄 진행률의 상태별 입력, 출력, SDK 호출 컨텍스트,
독립 작업 권한, 취소, 닫힌 창과 미지원 플랫폼을 검사한다.
`lifecycle/taskbar-progress.test.ts`는 버튼 준비, 마지막 성공 값의 복원, 실패 후 재시도,
서로 다른 HWND와 파괴 후 핸들 재사용을 검사한다. 버튼 재생성은 합성 호출이다.
`windows-bun-window-api.ts`는 실제 UI Worker와 WebView2에서 공개 SDK를 통해
ITaskbarList3의 다섯 상태를 설정한다. 네이티브 재생성 뒤 새 HWND에서도 반복한다.
`mise run host:windows`에 포함하며 실제 작업 표시줄의 색상, 그룹 표시 또는
Explorer 프로세스 재시작을 육안으로 검증하지 않는다.

`api/notification.test.ts`는 알림 상태 조회와 Windows 설정 열기의 독립 권한,
Zod 계약, SDK 컨텍스트와 취소, WinRT 실패 경계와 자원 정리를 검사한다.
`lifecycle/windows-notification.test.ts`는 별도 프로세스에서 누락된 앱 등록 오류를 확인한다.
등록된 조회는 격리된 프로세스에 UUID 시작 메뉴 바로가기와 process AppUserModelID를 설정한
뒤 fixture 전용 popup 억제/15초 만료 알림으로 OS 상태를 초기화한다. 엄격한 WinRT projection
getter와 FFI 값을 비교하며 고유 tag/group의 임시 알림은 finally에서 history 제거와 빈 상태를
검사한다. 바로가기도 실패 때 정리한다. 실제 I/O Worker의 승인, 거부, 취소, opener STA 공존과
종료도 확인한다. 공개 getStatus는 이런 알림을 보내거나 상태를 초기화하지 않는다.
상태 조회 회귀는 `mise run host:windows`에도 포함한다. Windows 설정 열기 접수는
폐기 가능한 데스크톱에서 `BUNAWAY_NOTIFICATION_SETTINGS_NATIVE=1`을 지정한 선택 검사다.
기본 CI는 실제 설정 페이지 표시나 사용자 차단 상태 변경, toast 표시를 검증하지 않는다.
[notification README](../plugins/notification/README.md)의 실행 명령과 남은 검증 범위를 따른다.

`api/notification-scheduled.test.ts`는 예약 입력 계약, 독립 권한, 과거 시각 거부와 OS 소유 예약의
조회, 취소, 종료 후 유지를 가짜 driver로 검사하고 `fixtures/notification-scheduled-ffi.ts`가 실제 vtable
slot과 인자 순서, 교체 순서, 4096개 한도, HRESULT 실패 때 COM 참조와 HSTRING 정리를 가짜 COM으로 검사한다.
`windows-toast.fixture.ts`의 예약 단계는 실제 WinRT로 예약, 교체, 조회, 취소와 약 8초 뒤의 표시 시각
도착을 확인하며 앱 프로세스가 종료된 상태의 표시는 확인하지 않는다.

`api/notification-cold-activation.test.ts`는 앱이 꺼진 뒤의 클릭을 받는 toast activator의 Linux 계약 시험이다.
활성화 인수 형식의 허용과 거부, 다른 앱 ID 거부, 첫 `takeActivations` 전 보관과 16건 한도, 이번 실행 toast의
`data`와 선언 버튼 검사, toast 객체와 activator 두 경로의 중복 제거를 가짜 controller로 확인한다.
`lifecycle/windows-notification-activator.test.ts`는 Windows에서 부모가 class object를 등록하고 별도
프로세스가 COM으로 `Activate`를 호출해 정상 호출과 잘못된 호출(`E_INVALIDARG`), 해제 뒤 연결 실패를
확인하며 `LocalServer32`의 기록과 갱신도 본다. `packaging/windows-toast-activator.test.ts`는 컴파일한
설치 프로그램으로 바로가기의 CLSID 기록, CLSID 없는 링크의 업데이트(CLSID 추가와 `Arguments` 유지, CLSID가 있는 링크는 그대로)와 perUser 제거 때 키 삭제를 확인한다. 대화형 데스크톱에서 실제
알림을 클릭해 꺼진 앱이 시작되는 것은 자동으로 확인하지 않는다.

`notification-shortcut-cleanup.test.ts`는 바로가기 정리의 일시적인 EBUSY만 최대 10회,
100ms 간격으로 재시도하는지 검사한다. 실패한 삭제는 정리 완료로 표시하지 않고 shell DLL을
유지하며 다음 정리에서 복구할 수 있다. 영구 잠금의 기한과 다른 오류의 즉시 전파를 검사한다.
생성 실패 뒤 정리도 실패한 경우 오류 객체에 남긴 cleanup으로 복구하는지 확인한다.
동시 정리의 단일 소유권 및 실제 임시 파일 삭제도 확인한다. fixture는 자신의 파일만 지우고
디렉터리를 재귀 삭제하지 않는다.

`packaging/windows-relocation.test.ts`는 생성한 Inno 스크립트에서 다른 폴더로 옮길 때의 정리 계약을 검사한다.
제거 프로그램을 실행하지 않고 재귀 삭제와 와일드카드가 없으며, 이전 기록을 설치 전에 읽고, 정리가 등록과
바로가기 갱신 뒤에 실행되고, 이전 폴더 조건(로컬 일반 폴더, 겹침 없음, `perMachine`은 Program Files 아래)을
스크립트가 갖는지를 본다. 실제 Inno 설치 결과는 아래 `windows-associations.test.ts`의 Windows 시험이 확인한다.

`packaging/windows-associations.test.ts`는 파일과 URL 처리 후보 설정, opt-in 작업과
실행 명령 계약을 검사한다. Windows에서 Inno Setup이 있으면 실제 설치와 업데이트,
작업 해제, 선언 제거와 제거 프로그램을 실행한다. 격리된 임의 확장자와 scheme으로
기존 기본값과 UserChoice 보존, Unicode와 공백, EXE 이름 변경, 변경된 ProgID 보존을 검사한다.
폴더를 바꾼 재설치 시험은 같은 AppId를 폴더 A에서 B로 설치해 연결과 `App Path`가 B를 가리키고,
A의 실행 파일, 제거 프로그램과 페이로드 목록의 파일만 없어지며 사용자가 둔 파일은 남는지 확인한다.
시작 메뉴와 바탕화면의 앱 링크는 사용자 인자를 넣은 뒤 폴더를 옮겨 대상, 인자, 시작 폴더가
새 설치를 가리키는지(아이콘 경로는 읽지 않는다), 제거 링크는 대상이 새 제거 프로그램인지, 사용자가 고른 시작 폴더는 유지되는지 읽는다. 등록 단계가 실패한 뒤의 재시도가
저장된 이전 제거 프로그램 경로로 정리하는지와, 이전 폴더로 향하는 junction 경로로 재설치해도 아무것도 지우지
않는지도 실제 설치로 확인한다.
선택하지 않은 연결이 켜지지 않는지, 새 폴더가 이전 폴더 안에 있거나 Inno 기록이 앱 기록과 다르면
이전 폴더(또는 제거 프로그램)를 지우지 않는지, 잠긴 이전 EXE는 종료 코드 1과 복구 기록을 남기고
다음 실행에서 정리되는지도 실제 설치로 확인한다.
선택한 ProgID의 외부 명령 충돌은 기존 후보와 파일을 보존한 채 설치를 실패시킨다. 임의 확장자의
OpenWith 키에만 쓰기 거부 ACL을 적용해 실제 설치 후 쓰기 실패의 종료 코드 1과 외부 값 보존을 확인한다.
ACL은 `finally`에서 복구하고 테스트 소유 항목만 정리한다.
별도 복구 회귀는 생성된 테스트 설치 스크립트에만 ACL 설정 호출을 삽입해 실제 첫 DefaultIcon 쓰기와
Capabilities 매핑 쓰기를 거부한다. 후보 이름 기록과 명령 미기록을 확인하고, ACL 복원 뒤 재시도와
제거, 외부 명령으로 변경된 후보 보존을 검사한다. 테스트 스크립트에 ACL 준비 호출만 추가하며
실제 등록과 삭제는 제품의 코드와 레지스트리 API로 수행한다.
Old.exe에서 New.exe로 바꾸는 업데이트의 OpenWith 삭제를 거부하고, 반복 실패 뒤에도 Inno 복구 소유자
기록이 Old.exe를 유지하는지 확인한다. 권한 복원 뒤 재시도와 새 제거 프로그램의 이전 후보 정리,
성공한 복구 기록 삭제와 기존 EXE 정리도 확인한다. 각 회귀는 별도 임시 앱 ID와 키를 사용한다.
복구 기록은 실제 Inno 제거 키에서 조회하며 기존 AppId의 닫는 괄호 두 개를 유지한다.
잘못된 별도 제거 키가 생기지 않는지도 검사한다. 기존 prerequisite 회귀의 `Uninstallable=no` 설치는
연결 작업과 이전 등록이 없을 때 복구 기록 없이 성공해야 하며, 일반 업데이트의 선언 제거와 작업 해제는
이전 등록 정리를 계속 확인한다.
기본 앱 UI 선택과 실제 링크 클릭은 자동 검사에 포함하지 않는다.
등록 변경 뒤 payload 삭제 실패 회귀는 실제 Windows 파일 핸들에서 delete sharing을 제외한다.
두 번의 실패 후에도 복구 소유자가 이전 EXE를 가리키는지 확인하고, 핸들을 닫은 뒤 재시도나
새 제거 프로그램이 이전 파일과 현재 파일을 정리하는지 검사한다. dummy EXE의 파일 잠금을
소유한 검사 프로세스를 Restart Manager가 닫지 않도록 이 설치 fixture만 `CloseApplications=no`로
실행한다. 별도 제거 회귀는 다른 폴더의 이전 파일과 junction을 통해 접근하는 이전 파일을 보존한다.
세 이름 회귀는 Old.exe 삭제를 막아 New.exe 업데이트를 실패시킨 뒤 Third.exe 업데이트가 파일과
이전 설치 데이터를 쓰기 전에 종료 코드 7로 거부되는지 확인한다. 잠금을 닫아도 거부를 유지하고,
New.exe로 복구한 뒤에만 Third.exe 변경을 허용한다. 같은 New.exe로 설치 폴더만 바꾸는 경우도
복구 전에는 거부한다. 복구 대신 제거한 경우에도 이전 파일이 남지
않는지 확인한다. 기존 두 이름 복구와 제거 회귀도 유지한다.
동시 실행 회귀는 초기화가 끝난 실제 설치 마법사와 제거 진행 콜백을 marker로 일시 정지한다.
같은 AppId의 다른 설치와 제거가 파일이나 등록을 바꾸지 못하고, 네이티브 종료 후에만 다음 설치가
진행하는지 확인한다. 별도 이전 버전 fixture는 설치의 잠금 호출과 SetupMutex 선언만 제외한다.
대기 중인 Third.exe 마법사가 New.exe를 읽은 뒤 이 fixture로 Old.exe, 실패한 New.exe 업데이트를
실행해 현재 이름은 New.exe지만 복구 소유자는 Old.exe인 상태를 만든다. 대기 마법사가 종료 코드 7로
거부되고 이전 파일과 복구 기록이 남는지 확인한다. 실제 파일 핸들과 레지스트리, 설치 및 제거를 사용하며
등록과 삭제 구현은 모방하지 않는다. 모든 marker는 `finally`에서 해제하고 시작한 프로세스의 완료를 관찰한다.
레지스트리 ACL 회귀는 부분 등록 뒤 외부 명령으로 바뀐 command 키의 `QueryValues`만 거부하고,
열거와 삭제 권한은 유지한다. 설치와 제거가 읽기 실패를 부재로 처리하지 않고 외부 명령과 등록을
보존하는지 검사한다. 성공한 ProgID의 `DefaultIcon` 삭제만 거부하는 회귀는 command가 먼저
삭제된 실제 부분 정리 상태를 확인하고, 복구 기록으로 재시도나 제거가 나머지 키를 정리하는지 검사한다.
`Capabilities/FileAssociations`의 값 조회만 거부하는 회귀는 선언 없는 New.exe 업데이트와 제거가
실패해도 등록, ProgID, Old.exe와 복구 소유자가 남고 권한 복구 뒤 정리가 완료되는지 확인한다.
설치 식별 정보 회귀는 Old.exe 정리가 실패한 New.exe 설치에서 실제 Inno 제거 키의 `QueryValues`만
거부한다. 설치와 제거의 초기화 및 대기 중인 콜백 뒤의 검증이 실패해도 두 EXE, 이전 등록과 세 식별
값이 남는지 확인한다. `ExecutableName`, `InstallDir`, `PendingAssociationOwner`를 각각 DWORD로
바꾼 경우에도 설치와 제거가 빈 값으로 받아들이지 않아야 한다. ACL과 문자열을 복구한 뒤 재시도와
제거가 이전 파일, 등록과 제거 정보를 정리하는지 확인한다. 기존 값 누락 회귀와 prerequisite도 유지한다.

`windows-initial-placement.fixture.ts`는 모니터 겹침이 바뀌는 `SetWindowPos`에서
실제 창 프로시저에 `WM_DPICHANGED`를 전달한다. 초기 DPI 보정의 수렴, 중앙 좌표와
content/outer 크기, DPI 순환 때 숨김 HWND 정리 및 생성 후 OS 권장 배치 처리를 검증한다.
기본 tracking 크기 보정도 재현해 큰 창의 중앙 배치와 작은 작업 영역의 overflow,
생성 이후 제한 복원 및 실제 rectangle 불일치 때 정리를 확인한다.
합성 모니터 검증이며 실제 다중 모니터 실행을 대신하지 않는다.

`mise run check`와 플랫폼 검사는 먼저 `plugins:build`를 실행해 중립 공개 출력과 OS별
호스트 출력을 생성한다. `cli/plugin-build.test.ts`는 화면 출력의 OS 코드 제외,
확장자를 작성하거나 생략한 플랫폼 import의 동일한 처리, 깨끗한 체크아웃에서 빌드 테스트 폴더 생성,
대상 OS 선택, package.json 버전 반영과 잘못된 버전 거부, 실패 시 기존 출력 보존을 검사한다. storage 네이티브 검사는 여러
어댑터의 DLL 소유권과 반복 dispose도 확인한다. 저장 어댑터 생성 시 기본 폴더가 생기지 않는지,
앱이 지정한 절대 경로의 입출력이 가능한지와 링크, 별칭, ACL 및 파일 교체 검사를 실제 Windows에서 확인한다.

`cli/plugins.test.ts`는 네이티브 export의 실제 경로를 패키지 루트와 비교해 내부 링크는 허용하고
외부로 연결되는 링크는 거부하는지 검사한다. Windows의 임시 폴더에 남은 짧은 경로도 정규화해
같은 패키지 안의 모듈을 잘못 거부하지 않는지 확인한다. macOS 네이티브 CI는 호스트 실행 전에
`plugins:build`를 실행한다.

`api/cli-arguments.test.ts`는 nested subcommand, Bun flag 문법, Zod defaults/transform, help와
오류 복구, snapshot과 타입 추론을 검사한다. `windows-cli-arguments.ts`는 실제 Windows host의
windowless UI Worker와 named pipe에서 초기 및 두 번째 실행의 argv를 onOpen에 전달하고
match, help, 오류 이후 다음 요청 처리를 확인한다. raw 모드에서 `https://`와 `file:relative.txt`도
원래 인자로 전달한다. `lifecycle/desktop.test.ts`는 초기 및 전달 요청의 URL 모양 string 옵션과
기존 파일 URL 검증과 onOpenUrls 목록 도출, 호출 순서를 함께 확인한다. `windows-cli-arguments.ts`는 기본 모드의
초기 및 두 번째 실행에서 `myapp://` URL과 상대 파일 경로가 정규화된 URL과 `file:` URL로 onOpen 뒤에
onOpenUrls에 전달되는지도 별도 자식 프로세스에서 확인한다. `host:windows`에 포함하며 WebView 페이지는 만들지 않는다.
raw 모드와 자동 실행 prefix를 함께 사용해 `launchReason`, 앱 argv와 숨김 전달의 표시 상태가
유지되는지 확인한다. 실제 Windows CLI 초기 요청에서도 자동 실행 prefix를 제거한 앱 인자를 검사한다.

공식 플러그인은 `src/index.ts`에서 선언을 조립하고 `src/contract.ts`에 계약을 둔다.
`api/plugin-contracts.test.ts`는 OS 자원 없이 네이티브 입력 검증을 실행해 모르는 작업의
UNSUPPORTED, 잘못된 입력의 INVALID_ARGUMENT과 입력 스냅샷을 확인한다.

권한 식별자는 operation 이름이며 작업마다 독립적으로 허용한다. API 검사는 저장 메타데이터의
exists와 stat 분리, 창 연산의 권한 검사를 확인한다.
앱 명령의 접근 검사와 직접 플러그인 호출 거부도 확인하며 범용 자원별 권한 계약은 두지 않는다.
windows-ui-operations.test.ts는 실제 UI Worker에서 정책 승인 전에 플러그인의 동의 요청이
실행되지 않는지, 비동기 요청의 승인과 사용자 거부가 전달되는지 검사한다. OS 대화상자는 대체하며
실제 카메라 권한 검증을 뜻하지 않는다. capabilities는 플랫폼 지원만 반환한다.

`windows-windowless.ts`의 `destroy-recreate-resident`와 `destroy-recreate-tray`는
마지막 창 재생성의 이전 세션이 폐기된 뒤 destroy를 호출합니다. 새 HWND를 만들지 않고
재생성을 CANCELLED로 끝내며 keep-alive와 기본 quit 트레이 앱이 beforeQuit 없이
StopHook과 네이티브 자원 정리를 완료하는지 확인합니다. `mise run host:windows`에 포함합니다.
`nonfocusable-resident`와 `nonfocusable-tray`는 실제 UI Worker의 desktop Show와 트레이
Open으로 숨김 및 최소화 상태를 복원합니다. 전경 활성화를 요청하지 않고 최대화 이력,
창 ID와 WebView 세션을 유지하는지 확인합니다.

Android의 `FrameDispatcherTest`는 읽기 스레드의 직접 전달이 멈춰도 별도 타이머가
실행되는지, 유휴 이후에도 기한을 감시하는지와 종료 제어 뒤의 응답 폐기를 검사한다.
`ProtocolTest`는 큰 한글과 이모지, 문자열과 키의 잘못된 surrogate, 원문 payload 전달의
중복 키와 이스케이프, envelope를 포함한 깊이 및 크기 제한을 확인한다.
`WebViewSessionTest`는 최초 hello, 입력 방향, 종료 및 화면 전환 뒤 대기 요청 폐기를 검사한다.
이 Java 검사들은 `mise run host:android`의 Gradle 단위 검사에 포함된다.
`android-bridge.test.ts`는 실제 `bridge.js`를 실행해 SDK의 텍스트 전달, 기존 객체 기반
리스너와의 호환성, 잘못된 메시지 거부와 종료 후 리스너 해제를 검사한다.
포트 연결 전 요청의 순서와 용량, 이전 문서 및 중복 포트 거부, fallback과 포트 회수도 포함한다.
직접 연결의 SDK 종료 알림과 출력 버퍼 제한도 검사한다. `loopback-channel.test.ts`는
실제 로컬 WebSocket으로 Origin, 일회용 주소, 만료와 회수, 늦은 SDK 초기화, 입력 순서와
크기 및 대기 제한을 검사한다. `runtime-bun.test.ts`는 실제 Bun 자식 프로세스에서
직접 연결의 정책 거부, 명령 오류 응답, 호스트 회수와 종료를 확인한다.
`android-bridge.test.ts`는 WebSocket 생성 실패와 최초 연결의 error/close에서 MessagePort와
reply proxy로 한 번만 전환하고 대기 메시지를 순서대로 전달하는지 검사한다. 이전 소켓의
늦은 콜백과 중복 주소를 무시하며 연결 성공 후에는 실패한 요청을 재전송하지 않는다.
`runtime-bun.test.ts`는 기존 직접 연결 권한을 회수한 뒤 새 파이프 세션이 동작하는지도 검사한다.
`runtime-channel-failure.test.ts`는 실제 TCP 연결의 close 프레임 없는 종료, 잘못된 입력과
수신 정지로 인한 출력 버퍼 초과를 재현한다. 해당 문서의 진행 중 명령만 취소되고 같은 Bun PID와
앱 상태, 다른 세션, 새 문서 연결 및 정상 shutdown이 유지되는지 검사한다.

창 준비 계약은 `api/window-readiness.test.ts`, `lifecycle/window-readiness.test.ts`와
`window-operations.test.ts`에서 설정 검증, 작업 권한, 단계별 완료와 상태 복구,
새 세대와 늦은 확인 차단, 기한, 생성 취소와 전환 순서를 확인한다.
`api/client.test.ts`는 협상한 SDK 준비 확인과 이전 호스트 호환, 확인 전송 실패를 검사한다.
`windows-window-readiness.ts`는 실제 WebView2에서 숨김 생성, 별도 준비 이벤트,
탐색과 fragment, 창 재생성, 문서 실패와 탐색 취소, SDK 미준비의 실제 30초 기한,
문서만 준비된 자동 표시 후 한 번의 마지막 창 종료를 검사한다.
`mise run host:windows`에 포함하며 네이티브 입력 준비 뒤 직접 실행할 수 있다.
`windows-hidden-webview.test.ts`는 실제 Win32, WebView2를 별도 STA 프로세스에서 실행한다.
HWND 생성부터 문서 완료까지 Win32 표시, 활성화, 포커스 메시지와 같은 프로세스의 WinEvent를
관찰하고 입력 포커스와 숨김 상태를 확인한다. DLL 대체나 주기적 상태 조회만으로 순간 표시를 판정하지 않는다.
WebView2 SDK 입력이 없거나 다른 OS이면 이 검사를 건너뛴다.

`mise run host:android`는 Windows의 Android SDK/JDK와 선택 기기에서 실제 APK를 검사한다.
`ANDROID_SERIAL` 기본값은 `emulator-5554`이며 기기를 먼저 부팅하거나 연결해야 한다.
공통 Core/SDK 명령, 이벤트와 구독 해제, 정책 거부, 취소, 자산과 subframe 경계,
화면 회전 후 같은 Bun PID와 Core 상태, Activity 종료 뒤 실제 Bun 종료를 확인한다.
홈 런처에서 fixture 아이콘을 눌러 실행하고 호출 주체와 root task를 확인한다.
홈 이동과 복귀에서는 Bun을 유지하고, 시스템 뒤로가기에서는 종료하는지 구분해 검사한다.
회전 설정은 원래 값으로 복원한다. Java 스키마 검사와 Android lint도 포함한다.
실제 WebView에서 localStorage와 sessionStorage의 저장, 읽기와 제거도 확인한다.
`cli/android.test.ts`는 지원하지 않는 설정과 잘못된 명령 인자, 대상 잠금, sync 후
사용자 Java/Manifest/Gradle/Wrapper 보존, 생성 파일 교체, 무관한 프로젝트와 링크 거부를 검사한다.
설치된 패키지의 실제 Android 번들 Worker를 실행하고 생성된 백엔드의 IPC 부팅 협상과 정상 종료도 검사한다.
앱이 지정한 launcher 해석과 시작, ADB가 종료 코드 0으로 반환한 실행 오류의 실패 처리도 검사한다.
Gradle 출력의 최종 application ID와 잘못된 메타데이터 거부도 검사한다.
별도 프로세스의 ADB fixture로 설치와 시작 중 출력 잠금, debug 접미사가 붙은 ID의 전달,
정상 종료와 설치 실패, 시작 실패, 취소 후 ADB 종료 및 잠금 해제를 확인한다.
이 결과는 ARM64 실기기, release APK/AAB와 네이티브 플러그인 검증이 아니다.
실제 런처 intent와 renderer 실패 후 회전, Bun의 cacheDir 임시 파일 쓰기도 확인한다.
백엔드 파일 import의 APK 추출과 읽기, Bun이 만든 자식 및 손자의 회전 중 유지와
뒤로가기 및 renderer 실패 후 정리도 검사한다. 설치된 Android Worker 검사는 텍스트,
바이너리와 JS 파일 자산을 번들하고 추출한 뒤 원본 소스를 삭제하고 IPC 명령으로 읽는다.
`lifecycle/android-process-group.test.ts`는 Linux와 JDK 17 이상에서 실제 Java 소유자를
컴파일하고 시작 취소, 정상 및 실패 종료, 강제 종료 후 자식과 손자, 상속된 파이프 정리를
검사한다. 다른 그룹의 프로세스가 유지되는지도 확인하며 Android 기기 실행을 대신하지 않는다.
`lifecycle/android-backend-assets.test.ts`는 JDK 17 이상에서 실제 Java 추출 소유자를
컴파일하고 APK 갱신 시 이전 파일 import 제거, 앱 데이터 보존과 추출 실패 후 재시도를 검사한다.
Linux와 macOS에서는 기존 추출 트리와 루트의 심볼릭 링크가 외부 파일을 건드리지 않는지도 검사한다.
`packaging/publication.test.ts`는 공통 게시의 복구 성공, 게시와 복구 오류의 동시 유지,
게시 후 백업 정리 실패, Android 출력 대상과 패키징 BuildTarget의 분리를 검사한다.

`api/clipboard.test.ts`는 텍스트 계약, 작업별 권한, SDK 호출 컨텍스트와 브라우저 번들을 검사한다.
`api/window-activation.test.ts`는 `showInactive`, `activate`의 입력과 결과,
작업 권한과 열린 창 검사, OS 전환 거부를 검사한다.
`lifecycle/windows-activation.test.ts`는 앱 창 하나와 EDIT 입력 필드를 가진 보조 Win32 창을 사용한다.
창 배치와 전경 요청의 메시지를 처리한 뒤 스레드 활성 창과 EDIT 포커스를 설정하며,
다시 메시지를 처리하기 전후에 같은 입력 상태인지 검사한다. 각 HWND의 소유 스레드와
프로세스를 확인하고 실패 시 최근 64개 활성화 메시지와 호출 전후 입력 상태를 출력한다.
일반, 최소화, 최대화와 최대화에서 최소화한 창을 표시하거나 숨긴 뒤 `showInactive`를
호출해 활성 창과 키보드 입력 포커스 보존, 표시 상태와 이벤트, snapshot의 일치를 확인한다.
`activate`가 숨김과 최소화를 유지하는지도 검사한다. 전경 전환을 OS가 거부한 실행은
입력 포커스 보존 결과와 구분해 기록하며 실제 전경 활성화 성공으로 계산하지 않는다.
DLL 대체 fixture는 반환 BOOL과 실제 전경 상태가 다를 때 관찰 상태를 반환하고,
동기 활성화 콜백 뒤에 반영된 상태도 중복 이벤트 없이 전달하는지 검사한다.
WebView2 경로는 기존 `windows-bun-window-api.ts`와 `windows-window-events.ts`에 포함한다.
`lifecycle/clipboard-resources.test.ts`는 별도 프로세스의 Win32 바인딩 대체로 메모리 실패,
소유권 이전, 잘못된 UTF-16, 점유와 취소, 종료 정리를 확인하며 데스크톱 클립보드를 바꾸지 않는다.
실제 Windows 검사는 `BUNAWAY_CLIPBOARD_NATIVE=1`을 설정한 뒤
`mise exec -- bun test tests/lifecycle/windows-clipboard.test.ts`로 실행한다.
공통 SDK와 실제 UI Worker의 읽기, 쓰기, 지우기, 별도 프로세스 점유와 취소를 확인한다.
WebView2 페이지 실행은 포함하지 않는다. 이전 텍스트만 복원하며 이미지 등 다른 형식은 복원하지 않는다.
실제 검증 기록과 명령은 [clipboard README](../plugins/clipboard/README.md)에 둔다.

`lifecycle/windows-bun-window-api.ts`는 실제 WebView2와 UI Worker에서 문서 탐색의 ID 유지,
네이티브 재생성의 ID 교체, 닫힌 창의 `isOpen`, normal과 destroyed 상태를 확인한다.
네이티브 입력을 준비한 뒤 `bun --no-env-file tests/lifecycle/windows-bun-window-api.ts`로
단독 실행하거나 `mise run host:windows`로 전체 Windows 호스트 회귀와 함께 실행한다.

`api/window-creation.test.ts`는 create/recreate의 `{ options? }` 계약과 독립 작업 권한,
공개 registry 및 직렬화 Host 경계의 허용된 표시 옵션과 잘못된 옵션, URL, 프로필과 임의 ID 거부를 확인한다.
`lifecycle/windows-window-placement.test.ts`는 ADR 0019의 작업 영역 배치, content/outer 크기,
음수 좌표, DPI 96/120/144/192의 반올림, 최소 크기 충돌과 좌표 범위를 순수 계산으로 검사한다.
런타임 `windows.center`의 `monitorId`는 정확한 ID 일치, 음수 원점과 위쪽 모니터의 작업 영역,
알 수 없는 ID의 `INVALID_ARGUMENT`와 주 모니터 대체 금지를 같은 파일에서 검사한다.
DPI가 바뀐 크기에 대해서도 `centerInWorkArea`가 같은 작업 영역의 중앙 좌표를 계산하는지만 순수 계산으로 확인한다.
네이티브 경로에서 크기 변경을 감지해 다시 중앙에 배치하는 판단은 실제 다중 모니터와 혼합 DPI 검증으로 남아 있다.
`api/window-move-to-anchor.test.ts`는 `windows.moveToAnchor`의 아홉 앵커 좌표, `margin`의 모니터 DPI 환산, 작업 영역보다 큰 창의 중앙 대체,
`monitorId` 해석과 거부, 최소화와 최대화 중 복원 영역 사용, 크기가 바뀐 뒤의 두 번째 배치를 가짜 창으로 검사한다.
`lifecycle/windows-bun-window-api.ts`는 실제 HWND에서 숨긴 창의 아홉 앵커와 `margin`, `monitorId`를 생략한 배치, 알 수 없는 ID 거부와 위치 불변,
숨김과 포그라운드 창 유지를 모니터 1개와 DPI 96에서 확인한다.
`api/window-move-next-to-rect.test.ts`는 `windows.moveNextToRect`의 네 방향과 세 정렬 좌표, `margin`, 작업 영역 보정과 뒤집지 않는 동작,
작업 영역보다 큰 창의 중앙 대체, 가장 가까운 모니터 선택과 DPI 환산, 최소화와 최대화 중 복원 영역 사용, 크기가 바뀐 뒤의 두 번째 배치,
잘못된 사각형과 열거값 거부를 가짜 창으로 검사한다. `lifecycle/windows-bun-window-api.ts`는 실제 HWND에서 합성 사각형 기준 배치와 잘못된 사각형 거부,
숨김과 포그라운드 창 유지를 모니터 1개와 DPI 96에서 확인하고 실제 트레이 위치는 확인하지 않는다.
계약 회귀는 병합 오류와 네이티브 배치 검증이 예약 및 기존 창 종료보다 먼저
실행되고 호출별 옵션이 선언을 바꾸지 않는지 확인한다. macOS 선언의 미지원 오류도 검사한다.
`lifecycle/windows-initial-placement.ts`는 실제 HWND와 WebView2에서 초기 선언,
생성 및 재생성, 예약 전 거부와 선언 복원을 확인한다.
실제 HWND에서 8192 논리 픽셀의 content 및 outer 요청을 기본 tracking 제한으로 줄이지 않고
중앙에 배치하는지도 확인한다.
8192 content 최소 크기가 들어가는지는 실제 작업 영역과 측정한 DPI 및 프레임으로 계산한다.
들어가면 재생성 성공을, 들어가지 않으면 기존 창을 보존하는 거부를 검사한다.
`mise run host:windows`와 CI의 windows-native에 포함하며 네이티브 입력 준비 후
`bun --no-env-file tests/lifecycle/windows-initial-placement.ts`로도 실행할 수 있다.
이 검사는 실행 환경의 모니터와 DPI를 기록하며 다중 물리 모니터 검증을 대신하지 않는다.
`cli/windows-config.test.ts`는 숨김 및 지연 창의 중복 뷰 진단, 식별자 개행과 창 정의
하나 요구를 검사한다. `lifecycle/window-operations.test.ts`는 열린 뷰의 두 번째 create가
BUSY로 실패하고 기존 자원 소유자를 유지하는지 확인한다. 호출별 옵션의 크기 보정,
제약 병합과 선언값 복원, 제목 검증 및 잘못된 옵션과 미지원 플랫폼에서 기존 창 보존도
검사한다. 실제 WebView2 실행은 포함하지 않는다.
`lifecycle/windows-window-readiness.ts`는 실제 Windows 호스트에서 호출별 크기 적용,
잘못된 제약에서 창 ID 유지와 다음 재생성의 선언 크기 복원을 검증한다.

`lifecycle/window-events.test.ts`는 실제 Core와 typed SDK를 연결해 `windows.changed`의
스키마, 뷰별 구독 권한, 해제, 폐기 세션과 Core 종료 후 늦은 발행 차단을 확인한다.
MessageChannel로 네이티브 이벤트 전송 방향, 미확인 128개 상한과 종료 용량도 검사한다.
Core 구독 큐 초과는 BUSY로 구독을 끝내고 이후 이벤트를 차단하는지 확인한다.
이 계약 검사는 WebView2 실행을 포함하지 않는다.
객체형 앱 정의의 `plugins` tuple에서도 이벤트 이름과 payload 타입을 추론하는지 타입 검사로 확인한다.

`lifecycle/windows-window-events.test.ts`는 실제 Win32에서 API와 시스템 메뉴 명령의
표시, 포커스, 이동, 크기, 최소화, 최대화, 복원과 전체화면 전환을 확인한다.
중복 억제, 현재 물리 outer bounds, revision과 HWND 파괴 후 콜백 차단 및 재생성 식별자도 검사한다.
각 전경 전환 요청의 반환값과 실제 전경 창을 확인한다. OS가 전환을 거부하면 focused 조회와 snapshot의 일치를 확인하고 실제 focus/blur
전환은 검증하지 못했다는 메시지를 출력한다. 해당 실행을 focus/blur 성공으로 기록하지 않는다.
DLL 대체 fixture는 전경 HWND가 동기 활성화 콜백 뒤에 반영되는 경우에도 게시한 창 메시지에서
focus/blur를 발행하는지 확인한다. 실제 OS 전경 전환 검증과는 구분한다.
`lifecycle/windows-window-events.ts`는 실제 WebView2로 구독한 세 문서에서 정상 전달,
권한 거부, 구독 해제, snapshot 조회, 탐색과 창 재생성 및 정상 종료를 확인한다.
`mise run host:windows`에 포함되며, 네이티브 입력 준비 후 이 파일만 실행할 수도 있다.

`api/window-state-persistence.test.ts`는 모니터 목록을 주입해 `window-state`의 보정(보이는 위치 유지, 사라진
모니터, 작은 겹침, DPI 비율, 작업 영역 한도)을 확인하고, 가짜 `windows`와 `store`로 저장 값, 복원 순서,
`include`, 손상된 기록, 삭제와 입력 검증을 확인한다. `lifecycle/windows-window-state.ts`는 실제 WebView2 창에서
위치와 크기, 최대화, 전체화면 왕복, 일부 항목만 복원, 화면 밖 좌표 기록의 보정, 삭제 뒤 복원 없음을 확인한다.
CI는 모니터 1개와 DPI 96이라 실제 모니터 분리와 혼합 DPI는 만들 수 없고 화면 밖 좌표 기록으로 대신한다.

`cli/app-manifest.test.ts`는 Windows 실행 manifest의 형식과 계약 검증, 플러그인 제거 후
재생성, 생성 import와 metadata 불일치를 검사한다.
`cli/plugins.test.ts`는 index.ts 한곳의 선언에서 플랫폼 경로를 찾고 설치만 한 어댑터를
불러오지 않는지 확인한다. 선언 진입점 기준 경로와 패키지 밖의 링크 거부, I/O와 UI의
부분 지원 조회 및 UNSUPPORTED 응답도 검사한다. `api/native-plugins.test.ts`는 플랫폼
선언 검증, 지원 목록 복사와 일반 플러그인의 시작 제한과의 분리를 확인한다.
manifest 생성과 카탈로그 로딩에서 작업 이름만 전달하며 작업 개수 상한을 유지하는지도 검사한다.
`api/plugin-zod-runtime.test.ts`는 원본 Zod와 입력, 결과 파싱을 비교한다. record 키 정규화와
제거, when, 사용자 검사, 변환 횟수, JSON 제한과 동기 및 비동기 파싱을 검사한다.
실패하는 비동기 검사 뒤에도 같은 Worker가 다음 호출을 처리하고 종료 코드 0으로 끝나는지,
`lifecycle/plugin-async-parsing.test.ts`는 실제 I/O Worker에서 권한 거부 시 입력 콜백이
실행되지 않고, 입력 파싱 뒤 재승인이 거부되면 네이티브 작업도 실행되지 않는지 확인한다.
중복 승인, 입력 검사 전 취소와 파싱 중 취소, 늦은 검사 실패와 다음 요청의 처리도 검증한다.
`lifecycle/plugin-cancellation.test.ts`는 실제 Windows UI와 I/O Worker에서 입력과 출력 파싱,
비동기 UI 실행을 한도만큼 취소해도 승인 용량과 다음 호출이 정상인지 확인한다. 컨텍스트 취소,
늦은 완료와 실패, 중복 승인과 작업 대기 중 종료도 검증한다. `lifecycle/macos-bun.test.ts`는
네이티브 UI만 대체한 실제 macOS 호스트와 Worker에서 같은 입력, 출력, 실행 취소 경로를 검사한다.
`lifecycle/io-response-ownership.test.ts`는 실제 I/O Worker와 `ImageResources`에서 응답 승인 전
취소, 컨텍스트 폐기와 종료가 전달되지 않은 이미지 자원을 회수하고, 승인된 자원은 유지하는지 확인한다.
`lifecycle/windows-host-shutdown.test.ts`는 백엔드 I/O 취소가 Core 종료 훅보다 먼저 전달되고
어댑터 폐기는 훅 이후 실행되는지 확인한다. Windows에서는 실제 Win32 UI Worker와 Job을 사용한
창 없는 실행도 검사하며 `host:windows`에 포함한다. Linux에서는 UI와 Job 경계를 대체한다.
`lifecycle/windows-ui-lifecycle.test.ts`는 실제 UI Worker와 대체 Win32 경계에서 마지막 창을
파괴해 종료를 확정한 뒤 입력 파싱을 재개한다. 취소 패킷 없이도 동기 어댑터와 비동기 UI
어댑터의 실행을 차단하고 CANCELLED를 반환하는지 확인한다.
`lifecycle/native-requests.test.ts`는 취소된 요청의 용량 반환과 이전 완료의 새 요청 간섭 방지를 확인한다. 실제 Worker와
빌드한 플러그인에서 파서가 로컬로 실행되고 전송 경로가 다시 파싱하지 않는지도 확인한다.
정책의 기존 크기와 깊이 상한도 manifest 생성과 읽기에서 유지하며, 상한 초과 입력은 거부하는지 검사한다.
`cli/windows-assets.test.ts`는
원본 소스와 임시 자산을 삭제한 뒤에도 compiled EXE가 manifest와 플러그인 구현을
읽고 지연 로딩을 유지하는지 검사한다.
메인과 두 Worker에서 플러그인의 `BunawayError` 코드가 그대로 전달되는지도 확인한다.
중간 생성 소스 없이 가상 모듈이 EXE에 포함되는지 검사한다.
`cli/macos-build.test.ts`는 macOS compiled 실행 파일의 메인과 백엔드 Worker가
원본 소스와 임시 자산을 삭제한 뒤에도 파일 import를 읽는지 검사한다.
텍스트, 바이너리와 `.js` 파일을 자산으로 가져오는 경우를 포함한다.
`packaging/contract.test.ts`는 `.bunaway/work/`와 `.bunaway/locks/`의 성공 및 실패 후 정리,
작업 디렉터리 링크 거부와 외부 파일 보존을 검사한다.
작업 중과 게시 직전에 작업 경로가 링크로 바뀌어도 외부 파일을 게시하지 않고 이전 출력을 보존하는지 검사한다.

`cli/restart-controller.test.ts`는 코드 교체 응답을 기다리는 중 받은 UI 변경의 즉시 무효화,
조절한 타이머로 연속 저장 대기와 종료 시 대기 취소를 검사한다. 정리 중 연속 저장,
빌드와 실행 준비 중 취소, 실행 실패 후 재시도, 마지막 작업 완료 직후 저장도 확인한다.
`cli/dev-ownership.test.ts`는 앱과 개발 서버의 소유권 이전, 늦게 완료한 실행의 회수,
이전 프로세스 종료 알림 제외, 반복 종료와 감시 범위의 복구를 명시적인 완료 신호로 검사한다. 개발 종료 신호는 진행 중인 서버 시작을 취소하지만 준비된 서버는 앱 정리가 끝날 때까지 유지하는지 확인한다.
`cli/dev-server.test.ts`는 종료 신호 뒤에도 실제 준비된 서버가 응답하고 명시적 정리 뒤 포트를 해제하는지 확인한다.
`cli/cli.test.ts`는 실제 감시와 서버 프로세스로 소스 및 앱 프로세스 실행 실패 후 재시도,
서버 재사용과 교체 및 앱 종료 뒤 서버 정리를 확인한다. 시작 중 알림으로 첫 빌드가 폐기돼도 실제 실행 시도에서 실패하도록 주입하고, 복구 저장 전에는 후속 빌드의 실행을 기다린다. 이 계약 검사는 실제 Windows WebView 실행을 대신하지 않는다.
`cli/distribution.test.ts`는 설치한 CommonJS
플러그인의 `.cjs`, `.js` 진입점을 실제로 번들하고 로드해 export와 교체 전후 객체 동일성을 검사한다.
조건별 import/require 결과와 require 전용 진입점, 차단된 import 거부 및 setup 플러그인의
바인딩 객체 재사용도 확인한다. Host API 테스트는 같은 플러그인을 재사용한 앱의 실행 컨텍스트가 독립적인지 검사한다.

- `protocol/`: 직렬화, 버전 협상, 오류 계약.
- `api/`: 모듈 공통 타입, 명령 input/output, Host API 컨텍스트, 취소, 오류 계약,
  클라이언트 기본 연결의 지연 초기화, 문서/HMR 공유, 구독 해제, 실패, 취소, 문서 종료 정리.
- `core/`: 명령, 상태, 이벤트, 플러그인.
- `conformance/`: 네이티브 호스트 간 공통 계약.
- `security/`: 권한, origin, 세션, 파일 범위.
- `lifecycle/`: 종료, 재연결, 모바일 수명주기.
  `webview-session.test.ts`는 WebView 전송, Windows 메시지 경계와 실제 Core를 연결해
  잘못된 구독 응답과 클라이언트 종료 시 세션 철회, 원격 구독 제거와 명령 취소를 확인한다.
- `docs/`: 문서 링크 검사기의 정상 입력, 잘못된 링크와 출력 경로 경계.

Windows 이벤트 전송 회귀는 실제 `MessageChannel`과 Core를 연결한다. 두 뷰의
총 130개 구독에 대한 방송과 구독별 순서, 수신 확인 지연, BUSY 구독 종료,
서버 대기열 포화와 세션 정리, 취소 및 종료 용량을 확인한다.
이 검사는 WebView2 GUI 실행을 포함하지 않는다.

`windows-window-events.test.ts`의 `windows-modal-events.fixture.ts`는 실제 Win32
이동 모달 루프에서 5ms 간격으로 위치를 384번 변경한다. 이벤트 수신 확인과
서버 전달이 모달 종료 전에도 진행되고, 양방향 전송의 순서와 정리가 유지되는지 검사한다.
물리 마우스 드래그를 실행하는 검사는 아니다.

Windows 호스트 시나리오는 `lifecycle/windows-host.ts`에 두고 PID 조회, 창 닫기와
프로세스 종료 감시는 `lifecycle/windows-host-processes.ts`에서 실행한다.

`api/opener.test.ts`는 HTTP/HTTPS 계약과 파일 API, 절대 경로 입력과 작업별 권한을 확인한다.
`lifecycle/macos-opener.test.ts`는 POSIX 경로와 파일 확인, 작업별 권한과 정리를 검사한다.
macOS arm64 CI에서는 `BUNAWAY_OPENER_ISOLATED=1`로 `macos-opener-native.test.ts`의
실제 I/O Worker와 `macos-opener-host.ts`의 compiled WKWebView 호출을 각각 한 번 실행한다.
고유 문서 타입을 선언한 앱을 등록하고 실제 파일 수신, loopback HTTP/HTTPS 및 Finder의
요청 접수, 권한 거부, 취소와 종료를 확인한다. 기본 handler 설정은 변경하지 않는다.
브라우저 페이지 로딩과 Finder 선택 화면은 검사하지 않는다.

`windows-ui-lifecycle.test.ts`와 `window-operations.test.ts`는 trusted destroy의 백엔드 출처와 독립 작업 권한,
닫기 확인 우회, 재생성 중 destroy와 이미 닫힌 창의 no-op(`true`)을 검사한다.
`windows-windowless.ts`의 destroy 시나리오는 keep-alive와 트레이 상주 앱에서도
마지막 창의 trusted destroy가 닫기 확인과 beforeQuit를 우회하고 앱을 정리하는지 검사한다.

`lifecycle/windows-opener.test.ts`는 실제 Windows I/O STA, 없는 파일과 디렉터리와 공유 잠금의 거부, junction과
대소문자 별칭이 풀린 경로로 따라가는지, 하드 링크가 자기 경로를 그대로 돌려주는지를 검사한다. 실제 I/O Worker의 승인 거부와
대기 작업 취소, 자체 COM 초기화와 종료도 검사한다. `windows-opener-job.test.ts`는 Explorer가 실행한
프로세스의 Job 분리와 앱 종료 후 생존을 확인한다. `cli/opener.test.ts`는 설치한 `.tgz`의 선언,
카탈로그, 작업 권한과 브라우저 번들, UI Worker에서 어댑터를 초기화하지 않는지 검사한다. `BUNAWAY_OPENER_FILES_TEST=1`로 실행하면
`cli/windows-opener-files.ts`의 자체 STA를 소유한 compiled I/O 어댑터 프로브로 실행 파일의 기본 동작과 실제 Explorer 선택을 확인한다.
이 opt-in 검사는 Explorer 데스크톱이 필요하며 사용자 파일 연결을 바꾸지 않고 테스트 폴더의 창만 닫는다.
일반 문서 편집기의 실행 완료, UNC 공유, MSIX나 Inno 설치 검증은 포함하지 않는다.
`app-reload.test.ts`는 명령 교체 후 상태, 세션, 구독, 진행 중인 명령의 기존 구현과
비공개 개발 IPC 입력 검증을 확인한다. 일반 경로와 별칭 경로에서 정상 번들을 교체하고,
해시가 다르거나 세대 디렉터리 밖을 가리키는 번들은 거부하는지도 검사한다.
`windows-app-reload.ts`는 생성하고 설치한 앱의
실제 CLI 파일 감시와 WebView2를 사용해 소스 오류 중 기존 앱 유지, 수정 후 상태와
화면 입력, 이벤트 순서, Host API, 오류 코드 보존, 계약 변경 시 전체 재시작을 검증한다.
CLI 계약 테스트는 로컬 UI와 백엔드의 공유 파일 변경을 전체 재시작 대상으로 분류하고
두 번들을 갱신하는지, JSON을 export하는 플러그인도 개발 번들에 포함할 수 있는지 확인한다.
뷰 프로필 이름은 호스트의 순수 `view-profile.ts` 함수를 공유한다.
macOS WebContent PID 조회와 종료는 `lifecycle/macos-renderer.ts`가 맡으며,
`macos-host.ts`는 시나리오별 기준 PID와 테스트 순서를 유지한다.

`mise run test`는 프로토콜, 정책, SDK, 코어, Host API의 계약 테스트와 네이티브용 생성
스키마 일치 검사를 실행한다. `mise run check`에는 테스트와 테스트 코드의 타입 검사도 포함한다.
코어, SDK 테스트와 `runtime-bun.test.ts`의 실제 Bun 프로세스 IPC 테스트를 포함한다.
런타임 테스트는 플러그인 초기화 중 Host API, 응답 컨텍스트, 취소, 폐기, 늦은 응답,
새 세션, 종료 훅, EOF와 부팅 전/초기화 중 종료를 확인한다.
`mise run host:windows`는 C++ 컴파일 없이 Bun UI Worker의 실제 WebView2, SDK, 권한,
저장, 메모 복원, 정상/비정상 종료를 검증한다.
모달 중 메인의 타이머, Promise, 네트워크와 초기화 중 닫기, 생성 실패, 파일 핸들 경계,
이동한 독립 CLI 프로젝트도 포함한다. [실행 결과](../docs/architecture/windows-bun-results.md).
모달 테스트는 실제 Win32 진입 알림부터 700ms 동안 타이머, Promise와 네트워크 진행을
관찰한다. 진입 전에 취소 메시지를 예약하지 않으며 종료 시 남은 취소 타이머를 해제한다.
진행 중인 HTTP 요청을 완료한 뒤 테스트 서버를 닫는다.
독립 CLI 프로젝트는 테스트용 UI 명령 호출을 추가한 뒤 생성 앱의 타입 검사를 통과해야 빌드와 창 실행을 진행한다.
공통 앱, 화면 데이터는 `tests/fixtures/desktop/host/`에서 Windows/macOS가 공유한다.
예전 Windows C++ 호스트/probe와 전용 실행기, 테스트는 삭제했다.
독립 실험 실행기와 모의 백엔드는 제거했다. `runtime-bun.test.ts`는 실제 Bun 런타임의
boot 전후 종료와 초기화 중 프로토콜 버전, 런타임 ID 및 세대 불일치 거부를 확인한다.
다른 플랫폼, 모바일 수명주기의 검증 완료를 뜻하지 않는다.

공개 창 API의 계약, 작업 권한, 카탈로그와 개발 URL은 SDK, CLI 테스트에서 확인한다.
`api/window-geometry.test.ts`는 content, outer와 normal 조회 schema, 공개 SDK 호출 컨텍스트,
반올림과 정수 범위, 작업 권한 거부 및 닫힌 창을 검사한다.
`lifecycle/windows-geometry.test.ts`는 실제 Win32 창에서 setter 직후 조회, 일반, 숨김,
최소화, 최대화와 전체화면 bounds, normal 복원과 음수 좌표를 검사한다. DPI 메시지는
합성 메시지이며 실제 배율이 다른 물리 모니터 사이의 이동 검증과 구분한다.
최소화 또는 최대화 직후, 표시와 숨김 직후 및 복원 영역 setter 뒤의 체크포인트는
HWND 소유 프로세스와 스레드, style, 원본 WINDOWPLACEMENT와 Win32 상태를 함께 검사한다.
일반, 최소화와 최대화의 표시 및 숨김 주기는 전체화면 진입 직전과 진입 직후,
복원 직후 상태도 기록한다. 복원 직후에는 원래 표시 상태를 확인하므로 다음 숨김 전에
상태가 바뀌었는지 구분한다. 비동기 일반 영역 조회를 마친 다음 숨김 직전에도 상태를
확인하여 복원 직후부터 숨김 요청 사이의 변경과 숨김 호출 안의 변경을 구분한다.
현재 outer 영역과 `WINDOWPOS`의 좌표, 크기 및 flags, style 변경 전후 값과 활성화 메시지의
최소화 상태도 기록한다. callback 안에서 native struct의 scalar 값만 복사하며 포인터를 보관하지 않는다.
일반 복원 뒤 숨김, 전체화면 진입, 제약 갱신과 종료의
마지막 주기도 같은 상태 기록을 남긴다.
마지막 bounds 불일치는 이 기록을 출력한 뒤 원래 assertion 오류를 그대로 전파한다.
실패에는 최근 체크포인트와 제한된 상태 메시지 기록, 호스트 callback 오류를 포함한다.
검사는 상태를 복구하거나 메시지를 pump하지 않으며 기존 geometry 기대값을 유지한다.
`lifecycle/windows-window-state.test.ts`는 같은 HWND에서 일반, 최소화와 최대화 상태,
표시와 숨김을 반복해 전체화면 해제 후 현재 bounds, normal bounds와 표시 상태를 검사한다.
프레임 재계산 뒤 일반 배치를 확정하는 순서를 회귀 검사하며 음수 화면 좌표를 유지한다.
같은 검사는 `setContentPosition`, `setOuterSize`, `setContentBounds`, `setOuterBounds`의
일반 및 숨김 적용, 제약 보정, 최소화 및 최대화 중 복원 영역 변경, 전체화면 거부,
rectangle 경계 오류의 변경 방지와 실제 이벤트 snapshot 일치도 확인한다.
각 성공한 작업 뒤 WndProc 오류도 확인하고, 숨김 크기를 위치 변경 전후에 각각 검사한다.
마지막 전체화면 검사에서는 진입 전 일반 상태, 숨김 직후 상태와 종료 뒤 일반 상태도 확인한다.
실패 때 native style, placement와 client/outer rectangle 및 최대 32개 scalar 메시지를
출력해 크기와 표시 상태가 실패한 단계를 구분한다. native pointer는 보관하지 않는다.
`api/window-geometry.test.ts`는 새 setter의 단위 기본값, DPI 반올림, 입력과 출력 schema,
SDK 호출 컨텍스트, 작업 권한, 닫힌 창 및 시작 전 취소를 GUI 없이 검사한다.
`windows-window-events.ts`는 실제 WebView2, Core와 UI Worker를 연결해 네 setter의
공개 SDK 호출 및 `setOuterBounds` 결과와 `windows.changed`의 revision, bounds 일치를 확인한다.
`windows-fullscreen-dpi.fixture.ts`는 DLL 대체로 음수 좌표의 모니터 이동, 작업 영역의
좌표 보정과 전체화면 중 현재 DPI에 따른 normal bounds 계산을 검사한다.
같은 fixture는 DPI 120/144/192에서 601×451 물리 content의 resizable 반복 변경을 검사한다.
일반, 최소화, 최대화와 전체화면 및 표시와 숨김 상태를 구분하며 실제 물리 모니터 검증은 아니다.
작업 영역 오프셋이 다른 모니터로 최대화 창을 옮기거나 전체화면에 진입해도 원래 일반
복원 rectangle의 모니터로 좌표를 보정하는지, 조회가 숨김 상태를 유지하는지도 검사한다.
왼쪽과 위쪽 모니터의 경계에 걸친 일반 창의 위치, 모니터 변경과 최소화, 최대화 중
복원 모니터 정보의 보존도 검사한다. 전체화면과 DPI 변경도 경계에 걸친 복원 영역을 사용한다.
최소화, 최대화와 전체화면 중 복원 모니터를 제거해도 normal bounds 조회가 유효 모니터를 다시 선택하고 표시 상태를 유지하는지 검사한다. 대체 모니터도 조회할 수 없으면 공개 `INTERNAL` 오류를 반환해야 한다.
최소화와 최대화 중 원래 모니터를 다시 연결해도 Windows가 옮긴 복원 위치를 유지하는지 검사한다. 분리 중 조회하는 경우와 한 번도 조회하지 않는 경우를 모두 확인한다. 전체화면에서는 표시와 숨김 상태로 모니터 분리와 재연결을 반복해 원래 복원 모니터의 좌표 보정으로 돌아오는지 확인한다. 재연결 후 핸들이 유지되는 경우와 바뀌는 경우를 모두 검사한다. 이 검사는 DLL 대체이며 실제 물리 모니터의 분리와 재연결 검증은 아니다.
`api/window-state.test.ts`는 상태 제어와 조회의 입력 및 출력 schema, 독립적인 작업 권한,
전체화면 중 변경 거부, 닫힌 창과 허용된 미선언 뷰의 오류를 검사한다.
`lifecycle/windows-window-state.test.ts`는 실제 Win32 창에서 최소화 전 최대화 복원과 일반
복원의 차이, 숨긴 창의 표시, OS에서 직접 바꾼 상태 조회, 크기 제약과 전체화면 복원을 확인한다.
최대화와 최소화 이력이 있는 일반 창도 전체화면 해제 후 일반 상태로 복원되는지 검사한다.
공개 함수와 UI Worker, WebView2를 연결한 상태 제어와 조회는 `windows-bun-window-api.ts`로 검증한다.
`lifecycle/windows-window-size.test.ts`는 서로 다른 작업 영역과 DPI에서 최대화 크기 보정과
제약이 없는 축의 보존을 확인한다. `windows-size-constraints.test.ts`는 실제 Win32에서
최대화 중 제약 축소, 확대와 해제, 숨긴 최대화 창과 최소화 창의 표시 상태 및 복원 크기를 검사한다.
두 창을 사용해 최대화된 보조 창의 제약, 복원 크기와 DPI를 바꿀 때 활성화 메시지가 발생하지 않고 입력 창의 활성 상태와 키보드 포커스가 유지되는지도 검사한다. 다른 프로세스가 전경 창을 바꿀 수 있으므로 입력 창이 계속 전경인지는 비교하지 않는다. 보조 창이 전경을 가져오는 것은 항상 거부한다.
일반, 최소화와 최대화 상태에서 숨긴 보조 창의 제약, DPI와 전체화면을 바꿀 때 표시나 활성화 메시지가 발생하지 않고 숨김 상태, 복원 크기와 입력 창의 포커스를 유지하는지도 검사한다.
합성 DPI 메시지 이후 최대화 크기를 다시 계산하고 표시 상태와 논리 복원 크기를 유지하는지도 확인한다.
합성 DPI 메시지로 표시하거나 숨긴 전체화면 창이 실제 모니터 영역을 유지하고, 해제 시 크기 제약을 적용하는지도 검사한다.
`windows-window-size.test.ts`의 별도 프로세스는 Win32 DLL을 대체하고 실제 FFI 창 콜백을 호출한다.
서로 다른 DPI와 해상도의 모니터로 이동하기 전에 전달된 제안 위치로 전체화면 대상을 선택하고,
화면 영역, 숨김 상태, 활성화 방지와 저장된 크기 제약을 유지하는지 검사한다. 실제 물리 모니터 이동 검증과는 구분한다.
일반 창의 복원 정보에 남은 최대화 이력은 제거하고 최소화한 창의 최대화 복원 이력은 유지하는지도 검사한다.
같은 격리된 DLL 대체 환경에서 최대화 요청을 무시하도록 해도 성공으로 반환하지 않고
네이티브 상태 확인 후 공개 `INTERNAL` 오류로 변환하는지 검사한다.
`lifecycle/window-operations.test.ts`는 정리 대기 중 중복 생성, 마지막 창 재생성 예약,
기존 문서 취소, 닫기 거절과 종료 경쟁을 검증한다. 미지원 destroy 호출이 실패해도
진행 중인 재생성은 새 창 생성까지 완료하는지도 확인한다. Windows 네이티브 실행기는
`windows-bun-window-api.ts`로 크기와 위치, 전체화면 복원, 확인 대화상자 거절과 승인,
창의 반복 재생성과 새로운 세션, 자기 창 재생성을 추가 검증한다.
닫기 확인을 설정한 창의 브라우저 프로세스를 종료해 확인 없이 닫히는지도 검증한다.
호출한 뷰의 세션이 종료되면 정리 대기 중인 생성 요청이 새 창을 열지 않는지도 확인한다.
`macos-bun.test.ts`는 정확한 origin과 포트, 실제 Bun Worker의 명령과 세션 폐기, 종료 수신 확인과 플러그인 정리를 검사한다.
UI 초기화 실패 검사는 UI 의존성만 대체하고 실제 Worker를 사용한다. UI 이벤트 처리 없이도
비동기 종료 훅을 기다리며, 종료 훅의 무한 루프는 5초 기한 뒤 강제 종료되는지 확인한다.
플러그인 초기화 중 창을 닫으면 정리를 완료한 뒤 정상 종료하고, 종료 요청 없이 Worker가
종료되면 코드가 0이어도 시작 실패로 처리하는지 확인한다.
macOS에서는 참조된 하위 프로세스와 `unref()`된 하위 프로세스, 플러그인 종료 기한 초과와
호스트 SIGKILL을 실제 프로세스로 검사한다. shell의 자식과 감시 프로세스까지 정리되고
다른 프로세스 그룹은 유지되는지 확인한다. 다른 OS의 시작 회귀는 macOS 그룹 소유권만 대체한다.
`windows-bun-storage.ts`는 임의 바이트, 빈 파일, 짧은 대체와 append, Unicode 텍스트 append,
바이트 읽기 상한과 링크 추종을 실제 Windows 파일 시스템으로 검사한다.
`windows-storage-metadata.ts`는 실제 WebView2에서 바이트 대체와 append, UTF-8 append 및
독립적인 텍스트 대체 권한 거부를 I/O Worker와 함께 검사한다.
이 검사들은 `mise run host:windows`에 포함하며 Linux 계약 검사와 구분한다.

`tests/lifecycle/run-native.ts`는 패키징과 테스트 실행 순서를 조정한다.
macOS 전용 설정과 리소스 경계 페이지도 `fixtures/desktop/host/`에 둔다.
`host:macos`는 C 컴파일 없이 Bun compiled 앱으로 실제 WKWebView 회귀를 실행한다.
같은 실행기의 `macos-webview-regressions.ts`는 실제 AppKit 창의 초기 크기 보정,
최소, 최대 제약과 제한 해제, WebKit UI delegate의 미디어 권한 거부를 확인한다.
미디어 검사는 설치된 delegate와 네이티브 decision block을 사용하며 실제 장치를 열지 않는다.
`macos-webview-recreate.ts`는 테스트 훅으로 첫 load를 정책 허용 뒤 멈춘 상태로 만들고 시계를 건너뛰어,
재시도 3회 뒤 뷰가 한 번 교체되어 페이지가 호스트에 한 번만 도달하는지, 창에 뷰가 하나만 남고
user script가 중복되지 않는지, 교체된 뷰의 delegate에 뒤늦게 호출해도 문서 완료와 세션 폐기와 로그가 변하지 않고
정책 결정은 한 번 거부로 답하는지, 교체한 뷰도 멈추면 `webview-load-stalled`를 한 번만 보고하고 다시 교체하지 않는지 확인한다.
`lifecycle/macos-desktop.ts`는 `run-native.ts`가 등록하는 실제 AppKit 실행기로 `quit-veto`,
`last-window`, `keep-alive`, `close-lifecycle`, `session-end`, `session-end-quit-reason`, `session-end-reply`, `sigterm`
시나리오에서 Quit 명령과 `beforeQuit` 취소, 수명주기 훅 순서, Dock 재활성화, 창 수명 이벤트와 닫기 요청,
세션 종료를 검사한다. `session-end-reply`는 별도 프로세스(`fixtures/macos-desktop/quit-event-sender.ts`)가
응답을 기다리며 quit Apple event를 보내, 응답이 앱 정리 뒤 `SESSION_END_WAIT_MS` 안에 오는지 확인한다.
`session-end`와 `session-end-quit-reason`은 종료 요청 뒤에도 UI 스레드의 타이머가 도는지를 드라이버가 쓰는
`main-tick-after-terminate` 줄로 확인한다. 훅이 가벼우면 정리와 프로세스 종료가 그 타이머보다 먼저 끝날 수 있어,
픽스처 앱의 stop hook은 `stopHook`을 기록한 뒤 이 줄이 쓰일 때까지(최대 1초) 정리를 붙잡는다.
따라서 이 두 시나리오에서 `stopHook` 줄은 정리 시작을 뜻하고, 정리 완료는 `onQuit`이 나타낸다.
macos-native CI에서 실행하며 실제 로그아웃, 재시작, 시스템 종료와 사용자의 Dock 클릭,
Cmd+Q 입력은 확인할 수 없어 알림, 자기 자신에게 보낸 Apple event와 `NSApp terminate:`로 대신한다.
`macos-desktop-host.test.ts`, `macos-desktop-requests.test.ts`, `macos-open-urls.test.ts`,
`macos-quit-reason.test.ts`, `macos-backend-shutdown.test.ts`와 `macos-window-lifecycle.test.ts`는
Linux에서 실행하는 계약 검사다.
콜드 런치(앱이 실행 중이 아닐 때 `open` 명령, Finder, URL scheme으로 시작)의 전달은
번들과 LaunchServices 등록이 필요해 native에서 검증하지 않는다. 대신
`macos-desktop-host.test.ts`의 "macOS cold-launch open requests delivered before the first pump
reach onOpenUrls after onReady and the initial onOpen"가 fake AppKit에서 첫 pump와 desktop-config
전에 열기 요청을 전달해 `onReady`, 초기 `onOpen`, `onOpenUrls` 순서를 확인한다.
`macos-open-urls.test.ts`는 정규화 뒤 URL 총 크기가 64 KiB를 넘으면 요청 전체를 `too-large`로
거부하는지와 `invalid-file-path` 거부를 검사한다. `macos-desktop-requests.test.ts`는 종료 중인
큐가 다음 요청을 꺼내지 않는지도 확인한다. `desktop.test.ts`는 준비 뒤 OS URL 요청의 표시가
실패해도 실패를 보고하고 `onOpenUrls`를 계속 호출하는지, `macos-desktop-host.test.ts`는 백엔드
종료 중 도착한 요청이 `open-urls-dropped`(`reason: "ending"`)로 버려지는지 검사한다.
`macos-desktop-fixture.test.ts`는 같은 픽스처 앱을 가짜 호스트에 연결해 시나리오 스크립트가 첫 `onOpen` 뒤
백엔드 문맥에서 `driver.drive`를 호출하는지, 호출 실패의 코드와 details가 `script-failed:` 로그에 남는지 검사한다.
`macos-bun.test.ts`는 `executeUI`가 없는 UI 스레드 플러그인이 백엔드 호출에서 `execute`로 실행되는지,
일반 오류가 호출자에게는 `INTERNAL`로만 전달되고 호스트 로그에는 작업 이름과 원인이 남는지도 확인한다.
`macos-window-api.ts`는 실제 compiled 호스트와 WKWebView를 연결해 창 하나의 표시와 포커스 조회,
최소화와 최대화 같은 상태 전환, 중복 생성의 `BUSY`, 반복 재생성과 새 세션을 검사한다.
`visible: false`와 `showWhenReady: "sdk"`의 숨김 생성, `getReadiness`,
미지원 생성 옵션의 `UNSUPPORTED` 거부와 기존 창 유지, `showInactive`가 포커스를 바꾸지 않는지도 확인한다.
`setContentProtection`, `isContentProtected` 전환도 확인한다. 자기 재생성이 새 세션으로
완료되며 마지막 닫기에서 호스트가 한 번 종료되는지 확인한다. 영속 프로필은 검사하지 않는다.
브리지에 최상위 `Date`, 객체와 배열 안의 `Date`를 보내도 앱이 종료되지 않고,
잘못된 메시지를 거부한 뒤 정상 메시지를 계속 수신하는지 확인한다.
4KB 응답 24,000개를 실제 페이지에 전달한 뒤 호스트 메모리 증가를 검사하고,
런타임 세대를 바꿔 다시 창을 만들 때 영구 저장 리소스 규칙이 하나로 유지되는지 확인한다.
공용 기능 목록 검사는 Windows 창 API의 `supported`와 macOS의 `unsupported`를 요구한다.

`desktop.test.ts`는 앱 열기 입력, 단일 인스턴스 전달과 시작 큐, 종료 취소,
실패 복구, 제어 패킷 경계와 창 없는 시작의 실행 유지 조건, 잘못된 desktop 설정의 진단을 확인한다.
`windows-windowless.ts`는 실제 Windows HWND, 트레이와 WebView2로 빈 창 선언,
지연 생성과 첫 창의 트레이 생성, 숨김과 최소화 및 최대화 복원, 마지막 창 닫기 뒤
백엔드 유지와 새 세션, 트레이 Quit 취소와 재시도를 확인한다. 트레이 입력은 실제
소유 HWND에 콜백 메시지를 게시하며 물리 마우스 클릭 검증과 구분한다.
`tray-hidden`은 아이콘을 숨긴 채 마지막 창을 닫아도 트레이 HWND와 백엔드가 유지되고 종료 확인이 없으며,
`show()`가 새 창을 만들고 숨긴 아이콘은 그대로이며 다시 표시한 값이 기록되는지 확인한다. Explorer가 그리는 숨김 상태는 읽지 않는다.
창 없는 상주 앱과 트레이 앱의 CLI 중단, 대기 중인 beforeQuit 우회와 StopHook 정리도 검사한다.
강제 종료에서는 StopHook을 보장하지 않으며 실제 Job 자식 프로세스와 HWND 종료를 확인한다.
실행 결과는 `build/windows-windowless/<scenario>-report.json`에 기록한다.
Windows 실행기의 `windows-desktop.ts`는
실제 창을 숨긴 뒤 백엔드 타이머가 계속 동작하는지, 두 번째 실행으로 복원되는지,
종료 취소 뒤 같은 창과 세션을 유지하고 다시 종료할 수 있는지 확인한다.
`boot-forward-lifecycle` 시나리오는 코어 부팅 중 단일 인스턴스 파이프로 보낸 요청을 접수 표식까지 부팅을 대기시켜 인박스에 보관시키고,
요청 한 건에 대해 `onReady`, 초기 `onOpen`, 두 번째 `onOpen` 순서를 확인한다.
`windows-desktop-web.ts`는 복원 뒤에도 원래 구독으로 이벤트를 받고 같은 세션에서
명령을 호출하는지 확인한다. IPC의 5초 기한은 요청이나 응답 조각을 계속 보내도 연장되지 않는다.
기한 검사에서는 큰 인자의 전달과 연결 종료에 따른 pipe 오류도 처리하며 요청과 응답이 각각 기한을 채웠는지 확인한다.
Windows PowerShell 실행기 테스트는 한글 파일과 URL 인자 및 호출자의 cwd 보존을 확인한다.
`--`, PowerShell 공통 매개변수 이름, 따옴표, 끝의 역슬래시와 빈 인자도 확인한다.
한글 파일명 128개와 256개도 실제 실행기로 전달해 JSON 인코딩 뒤 명령줄 길이 초과가
발생하지 않는지 확인한다. 표준 입력의 크기 제한, 잘못된 JSON과 5초 기한도 검사한다.
Windows 데스크톱의 dev-veto, dev-hide, dev-pending 시나리오는 CLI 중단이 종료 취소,
트레이 숨김과 대기 중인 종료 훅을 우회하며 플러그인 정리를 실행하는지 확인한다.

공개 창 API와 데스크톱 종료 설정을 함께 쓰는 회귀도 확인한다. `windows.close`의
마지막 창 종료 취소는 기존 세션을 유지하고, 자기 창 재생성은 `beforeQuit`를 호출하지 않는다.
트레이 숨김 설정에서는 API로 닫은 뒤에도 같은 요청 컨텍스트로 창을 다시 표시할 수 있어야 한다.

## 네이티브 빌드와 배포 회귀

`packaging/tool-output.test.ts`는 실제 자식 프로세스의 stdout과 stderr가 일반 파일인지
확인하고 종료 코드, 진단과 프로세스 생성 실패 뒤 임시 파일 정리를 검사한다.
DMG 생성은 DiskImages helper가 pipe 출력에서 멈추는 경우를 피하기 위해 이 캡처를 사용한다.
CI는 `BUNAWAY_DMG_DIAGNOSTICS=1`로 fixture 안에서만 실제 hdiutil을 관찰한다.
파일 descriptor, 고유 경로, fixture 파일을 연 프로세스, 해당 fixture의 disk image 목록과
verbose 출력을 `build/macos-packaging-diagnostics/`에 보관한다. 기존 일반 파일 출력을
상속하고 실제 종료 코드를 전달하며 진단 fixture는 재시도나 다른 볼륨의 detach를 수행하지 않는다.
패키저의 `hdiutil create`만 stderr/stdout의 `Resource busy`에 대해 최대 3회(대기 1s, 2s) 재시도한다.
다른 실패는 즉시 전달한다. 외부 probe는 생성 명령이 끝난 뒤 실행해 DiskImages 서비스를 미리 초기화하지 않는다.
실제 DMG 검증, 읽기 전용 마운트와 서명된 앱 내용 검사 및 실패 시 이전 산출물 보존은
기존 `macos-distribution.test.ts`에서 계속 확인한다.

Windows native CI는 전체 호스트 검사 뒤 `windows-geometry.test.ts`를 새 프로세스에서
세 번 실행한다. 모든 실행이 성공해야 하며 전체 계약 검사의 같은 회귀도 유지한다.
show state와 fullscreen 복원 실패가 프로세스 내부의 이전 검사 상태에 의존하는지
확인하기 위한 검사다. 로그는 `build/windows-native-logs/geometry-*.log`에 보관한다.
전체 계약 검사에서도 같은 native assertion을 소유한 자식 프로세스에서 실행한다.
자식은 10초 실행 기한을 가지며 이전 검사의 Win32 thread 상태를 상속하지 않는다.
부모는 자식의 완료와 로그를 수집하고 성공한 종료 코드를 요구한다. 상태를 수리하거나
메시지를 추가로 pump하지 않으며 geometry와 show-state assertion은 그대로 유지한다.

`windows-size-constraints.test.ts`는 전체 계약 검사의 같은 프로세스에서 계속 실행한다.
fullscreen 경계 비교 구간에서는 복원, 제약과 크기 변경, fullscreen 진입, 표시 상태와 DPI
변경 직후의 최근 여덟 상태를 보관한다. 실제 outer 좌표와 placement, 최소화 여부를 함께
기록하며 창 상태 변경 순서와 기존 assertion은 유지한다.
Windows 계약 CI는 전체 검사 뒤 같은 파일을 새 Bun 프로세스에서 한 번 실행해 결과를 비교한다.
기존 표시, 포커스, DPI, 전체화면 assertion과 30초 기한을 유지하며 재시도하지 않는다.
`BUNAWAY_SIZE_CONSTRAINTS_DIAGNOSTICS=1`이면 숨김 요청, 입력 창 포커스 지정, 제약 갱신,
DPI 변경과 전체화면 진입 및 종료 뒤의 마지막 8개 상태를 출력한다. HWND 소유 프로세스와
스레드, 시작 show command도 기록하며 native 상태를 변경하거나 메시지를 pump하지 않는다.
전체 검사 결과는 작업 로그에, 단독 실행 로그는 `windows-matrix-diagnostics` artifact에 남긴다.
단독 통과만으로 전체 검사 실패의 원인이나 제품 수정 완료를 판단하지 않는다.
이어서 단축키 단독 및 menu, tray 동시 UI Worker 검사와 같은 크기 제약 검사를 한 Bun
프로세스에서 실행한다. UI 자원 정리 직후의 표시 상태를 비교하며 원래 assertion과
기한을 유지한다. 결과는 `windows-matrix-diagnostics`의 `ui-services-size-constraints.log`에
남긴다. 이 비교의 통과도 앞선 전체 검사 실패를 덮어쓰지 않는다.

`api/opener-selected-app.test.ts`는 지정 앱 opener의 strict Zod 입력, 독립 권한,
호출 컨텍스트와 오류를 확인한다. Windows의 `lifecycle/windows-opener-selected-app.test.ts`는
실제 앱과 대상 파일 검사, 링크로 가린 앱 확장자 거부를 확인한다(파일 symlink를 만들 수 있는 러너에서만 실행). `windows-opener-job.test.ts`는
Explorer와 compiled helper로 파일 및 HTTP/HTTPS URL 하나의 argv 보존과 Job 밖의 실행,
앱 종료 뒤 helper 생존을 확인한다. 두 검사와 기존 opener STA 검사는 `host:windows`에도 포함한다.
`api/opener-url-handler.test.ts`는 `opener.getUrlHandler`의 strict Zod 입력, 독립 권한과 호출 컨텍스트를
확인한다. `api/opener-url-handler-query.test.ts`는 주입한 `AssocQueryStringW` 결과로 HRESULT 실패,
빈 값, 상한 초과, 제어 문자와 크기 변경 재시도가 모두 `null`이 되는지 확인한다. Windows의 `lifecycle/windows-opener-url-handler.test.ts`는 https 조회가 `null` 또는
`{ name, path }` 구조인지, 연결이 없는 scheme이 `null`인지, 잘못된 URL 거부와 dispose 뒤 호출 취소를
`host:windows`에서 확인한다. 처리 앱의 종류는 러너마다 다르므로 값은 검증하지 않는다.
`api/opener-file-icon.test.ts`는 `opener.getFileIcon`의 strict 입력(경로 또는 확장자 하나, 크기 열거값, 확장자 문자 규칙),
PNG 출력 상한, RGBA PNG 인코더의 행 배치, BGRA에서 RGBA로의 변환과 AND 마스크 투명도 복원, 경로와 확장자를 함께 준 호출의 클라이언트 거부, 독립 권한을 확인한다. Windows의 `lifecycle/windows-opener-file-icon.test.ts`는
`host:windows`에서 확장자와 실제 파일(텍스트 파일, 실행 파일)의 셸 아이콘이 RGBA PNG로 반환되고 보이는 픽셀이 있는지,
`small`부터 `large`까지 해상도가 줄지 않는지, 없는 파일과 디렉터리 거부, 종료 뒤 호출의 `CANCELLED`를 확인한다.
아이콘의 실제 모양은 검증하지 않으며 육안 확인은 수동 검증이다.
`lifecycle/windows-opener-recent.test.ts`는 `opener.addRecentDocument`와 `opener.clearRecentDocuments`의
입력 거부와 dispose를 항상 확인한다. 사용자의 셸 최근 항목 전체를 지우는 실제 add와 clear는
`BUNAWAY_OPENER_RECENT_MUTATE=1` 또는 GitHub 호스팅 러너(`RUNNER_ENVIRONMENT=github-hosted`)에서만
실행하고(self-hosted 러너는 명시적으로 지정해야 한다), 그렇지 않으면
경고를 남긴다. 최근 항목 기록이 정책으로 꺼진 러너에서는 바로가기 검사를 생략하며 add와 clear 결과가
검증되지 않는다는 경고를 남긴다. `SHAddToRecentDocs`는 opener의 I/O STA에서 직접 호출하며 Electron과
같이 프로세스에 MTA가 남을 수 있다. 이 테스트는 그 상태에서도 기존 opener 작업이 정상이고 dispose가
어댑터 자신의 COM 초기화만 해제하며 재초기화가 되는지 같은 프로세스에서 확인한다. COM 불변식은
"I/O 스레드가 명시적 초기화 없이 시작하고 dispose에서 자신의 초기화를 균형 있게 해제한다"이며,
`windows-opener.test.ts`는 `CoGetApartmentType`의 암묵적 MTA qualifier로 이를 구분해 테스트 순서와
무관하게 통과한다.
Linux의 계약 검사에서 건너뛴 Windows 테스트를 실제 실행 결과로 판단하지 않는다.

`api/path.test.ts`는 Windows 문자열 경로 규칙과 명시적 base, per-drive 상대 경로 거부를 검사한다.
보충 문자의 UTF-16 입력과 합성 출력 상한을 확인하며 실제 WebView2에도 같은 경계 회귀를 적용한다.
`windows-path.test.ts`는 실제 current-user Known Folder를 조회하고 .NET의 독립적인
표준 폴더 조회 결과 및 여러 어댑터의 DLL 수명과 비교한다.
`windows-path.ts`는 실제 WebView2와 I/O Worker에서 폴더 조회, 문자열 helper와
작업별 권한 거부를 확인하며 `mise run host:windows`에 포함한다.
실제 사용자 폴더 redirection 설정 변경과 다른 사용자, 머신 검증은 포함하지 않는다.

`api/autostart.test.ts`는 로그인 자동 실행 플러그인의 정책, 공개 helper, 앱 ID 분리와
Windows 명령줄 제한, 숨김 등록의 트레이 요구 조건을 검사한다.
`windows-desktop.ts`의 autostart 시나리오는 실제 HWND와 WebView2에서 일반 및 숨김
초기 실행, SDK 준비 뒤 표시 억제, 숨김 두 번째 요청의 표시 상태 유지, 수동 재실행의 복원과
같은 UI 세션 유지 및 정상 종료 정리를 검사한다. 로그인 실행 출처는 인증하지 않으며
실제 로그아웃과 로그인, 사용자 시작 앱 UI 조작은 별도 대화형 검증이다.
`lifecycle/windows-autostart.test.ts`는 실제 사용자
Run 값의 등록, 조회, 경로 갱신과 반복 해제를 확인한다. 임시 앱 ID에만 승인 테스트 값을
써서 비활성화 선택을 보존하는지 확인하며 실제 작업 관리자 조작과는 구분한다.
저장 명령줄을 CreateProcessW로 실행해 compiled EXE와 개발 Bun의 공백, Unicode,
따옴표, 빈 문자열과 끝의 역슬래시 argv를 검사한다. 실제 로그인 자동 실행은 별도
대화형 로그인 검증이 필요하다. 테스트는 다른 앱의 등록을 변경하지 않는다.
`cli/autostart.test.ts`는 로컬 tarball의 isolated 설치, manifest와 I/O 어댑터 발견,
정책 승인과 browser 번들에서 FFI가 제외되는지도 확인한다.

`windows-safe-storage.test.ts`는 실제 DPAPI로 Unicode와 임의 바이트, 크기 상한, 손상 입력,
보충 문자의 UTF-16 상한 왕복과 초과 입력 거부,
반복 dispose와 독립 어댑터, 저장된 암호문의 새 프로세스 복호화를 검사한다.
`windows-safe-storage.ts`는 실제 WebView2와 I/O Worker에서 동시 요청, UI 타이머 진행,
손상 입력을 확인하며 `mise run host:windows`에 포함한다.
다른 사용자나 머신, Windows 키 복구 및 물리 입력 검증은 포함하지 않는다.

`mise run host:windows`와 `mise run host:macos`는 Bun으로
`tests/lifecycle/run-native.ts`를 실행한다. CLI의 의존성 준비와 네이티브 빌드를
거친 뒤 플랫폼별 실제 호스트 fixture를 만들고 검증한다.
`--skip-tests`는 fixture 생성까지만 수행하며, macOS의 `--app`은 ad-hoc 서명 앱
검증과 `tests/packaging/macos-distribution.test.ts`의 배포 회귀를 추가한다.
배포 회귀는 `bun:test`로 실제 DMG와 PKG, 실패 시 이전 산출물 보존을 확인한다.
서명 fixture도 Bun으로 compile하며 C 컴파일러를 사용하지 않는다. compiled 앱 입력과
서명, JIT와 FFI entitlement, 롤백과 정리를 검증한다.
macOS의 기본 테스트 실행에도 포함되며, 실제 Bunaway 앱 검증은
`BUNAWAY_DISTRIBUTION_APP`에 지정한 앱을 사용한다. 다른 OS에서는 건너뛴다.
Apple 공증 서비스와 도구 실패는 테스트 자식 프로세스의 PATH에만 놓는 Bun fixture로
검증한다. Python이나 별도 셸 실행기는 필요 없다.

`api/storage-transfers.test.ts`는 두 endpoint, 추가 옵션 거부와 독립적인 전송 권한을 검사한다.
`api/storage-files.test.ts`는 공통 어댑터를 임시 폴더에서 직접 실행해 복사(기존 파일, 디렉터리, 링크와
대상 없는 링크를 POSIX에서 거부(Windows는 링크를 따라 새 파일을 만들어 검사하지 않음), 없는 원본과 없는 parent, 크기 상한 없음)와 이동 규칙(기존 대상 보존, 자기 하위 거부)을 확인한다.
이 파일은 Linux와 Windows의 테스트 실행에서 모두 돌고, 링크를 만들 수 없는 러너에서는 링크 부분만 건너뛴다.
`api/storage-files.test.ts`는 `readBytes`의 범위 읽기(중간, 파일 끝을 넘는 범위, 끝 이후, 기본값, 전체 읽기 상한을 넘는 파일의 범위),
`readText`의 512 KiB 파일 상한과 JSON 인코딩 768 KiB 상한(NUL 반복), 4 MiB를 넘는 복사를 확인한다.
`windows-bun-storage.ts`는 실제 Windows 파일 시스템에서 여러 chunk의 임의 바이트,
빈 파일, 기존 대상 보존, 5 MiB가 넘는 복사, 링크를 거친 대상과 같은 parent 및 다른 parent의 파일과 디렉터리 이동을 확인한다.
소스와 빌드된 어댑터 각각에서 write/copy/append/move를 32회 수행하며 없는 대상의
오류 분류, 기존 대상 충돌과 원본 보존도 확인한다. 각 move 전에 GC를 실행해
FFI 반환값 할당이 네이티브 오류 상태에 영향을 주는 경로를 검사하며 작업을 재시도하지 않는다.
다른 볼륨 이동은 `UNSUPPORTED`이며 식별 가능한 경우에만 검사한다.
같은 파일은 260자를 넘는 경로와 `\\localhost\C$\...` 경로의 범위 읽기를 시도해 결과를 `PROBE` 줄로 출력하지만 통과 조건으로 삼지 않는다. GitHub Actions `windows-2022`에서는 409자 경로와 UNC 경로가 모두 성공했다. 러너의 긴 경로 설정은 확인하지 않았다.
`windows-storage-metadata.ts`는 실제 WebView2와 I/O Worker에서 copy/move와 원본 및 복사본,
일반 쓰기 권한 거부를 검사하며 `mise run host:windows`에 포함한다.

`cli/native-build.test.ts`는 한글과 공백이 포함된 캐시 경로에서 Bun ZIP과 SDK의
압축 해제 위치를 확인하고, 잘못된 ZIP의 실패가 호출자에게 전달되는지 검사한다.
Windows 네이티브 CI는 이 검사를 호스트 빌드 전에 실행하며 전체 실행 로그도 보관한다.
macOS 배포 회귀는 날짜와 바이너리 데이터를 포함한 추가 plist 메타데이터가
서명과 DMG, PKG 조립 후에도 타입과 값 그대로 남는지 확인한다.

`lifecycle/windows-ui-lifecycle.test.ts`는 실제 UI Worker와 창 어댑터에서 모든 살아 있는
창의 복원, 시작 controller 오류의 fatal 보고와 정리, 실행 중 생성 실패의 정리를 검사한다.
Win32와 WebView 콜백 경계는 제어 가능한 fixture로 대체하며 실제 Windows 실행 검증과 구분한다.

`api/storage-directories.test.ts`는 생성의 기본값, 작업별 권한과 결과 전송 상한을 확인한다.
`api/storage-files.test.ts`는 목록의 이름 정렬과 종류, 256개 상한, 생성의 멱등성과 파일이 막은 경우,
삭제(링크 자체 삭제, 비어 있지 않은 디렉터리 거부)와 재귀 삭제(트리 안의 링크 미추적, 취소 시 무변경),
용량 계산(이름별 합산, 링크 제외, 항목과 깊이 상한, 취소, 어댑터 해제)을 확인한다.
`windows-bun-storage.ts`는 실제 Windows 파일 시스템에서 여러 batch의 이름과 junction이 `link`로 나오는 것,
junction을 디렉터리 경로로 따라가는 것, 재귀 생성, 파일 및 빈 디렉터리 삭제, 큰 목록 실패, 링크 추종과 ACL 거부를 확인한다.
`windows-storage-metadata.ts`는 실제 WebView2와 I/O Worker에서 목록, 생성과 빈 폴더 삭제,
독립적인 텍스트 쓰기 권한 거부를 검사하며 `mise run host:windows`에 포함한다.

`windows-storage-directory-size.ts`는 실제 Windows 파일 시스템으로 빈 디렉터리, 중첩 합계, hardlink의
이름별 합산, junction과 파일 symlink 미추적(만들 수 없는 러너에서는 건너뜀), 링크를 루트로 준 경우의 추종,
항목 및 깊이 상한, 시작 전과 순회 중 취소, 순회 중 어댑터 해제, deny ACE(icacls)를 건 하위 디렉터리의
`PERMISSION_DENIED`(icacls를 쓸 수 없는 러너에서는 건너뛰고 정리 때 ACE를 제거), 파일 및 없는 경로 거부를 확인한다.
`windows-storage-copy-directory.ts`는 실제 Windows 파일 시스템으로 유니코드 중첩 트리, 빈 디렉터리와 빈 파일, 바이트 일치,
기존 대상 거부, 없는 상위와 파일 원본 거부, 대소문자가 다른 이름을 포함한 자기 하위 복사 거부, junction을 거친 자기 하위 대상의
실제 경로 비교 거부, 루트 링크 추종, 트리 안 junction 거부와 대상 불변(만들 수 없는 러너에서는 건너뜀), 시작 전 취소와 어댑터 해제를 확인한다.
`windows-storage-directory-page.ts`는 실제 Windows 파일 시스템에서 대소문자와 보충 문자가 섞인 이름의
UTF-16 순서, 페이지 크기별 커서 이어 읽기가 `readDirectory`와 같은 결과를 내는지, 256개를 넘어 `readDirectory`가
거부하는 디렉터리를 페이지로 빠짐없이 읽는지 확인한다.
`windows-storage-recursive-list.ts`는 실제 Windows 파일 시스템에서 깊이 우선 순서(디렉터리가 자기 내용 바로 앞, 형제는
UTF-16 순서), 페이지 크기별 커서 이어 읽기가 한 번에 읽은 결과와 같은지, 바깥 junction과 상위로 돌아가는 junction과
파일 symlink가 `link`로만 나오고 들어가지 않는지(만들 수 없는 러너에서는 건너뜀), 256개를 넘는 트리를 빠짐없이 읽는지,
파일과 없는 경로의 거부를 확인한다.
`windows-storage-metadata.ts`는 실제 I/O Worker에서 허용된 호출의 합계와 파일 경로 거부를 확인한다.

`windows-storage-long-path.ts`는 실제 Windows 파일 시스템에서 400자를 넘는 경로에 쓰기(상위 폴더 생성 포함), 읽기, 존재와 stat,
목록(접두사 없는 이름), directorySize, 복사, 덮어쓰지 않는 이동, 자기 하위로의 이동 거부, 삭제와 removeRecursive를 확인한다.
`LongPathsEnabled`를 끈 환경은 러너 설정에 의존하므로 확인하지 않는다.

`windows-storage-create-new.ts`는 실제 Windows 로컬 파일 시스템에서 별도 프로세스 6개가 같은 시각에 같은 대상으로
`copyFile`(16 MiB 원본)을 호출하는 경합을 5회 반복한다. 모든 자식이 시작 시각 전에 준비됐고 매 회 패자 중 하나 이상이 승자의
복사가 끝나기 전에 거절됐는지(순차 실행이 아님)를 확인하며, 정확히 하나만 성공하고 나머지는
`INVALID_ARGUMENT`("Storage destination already exists.")로 실패하는지, 대상 파일이 성공한 원본과 바이트 단위로 같은지(여러 복사본이
섞이지 않음)를 확인한다. `FILE_FLAG_DELETE_ON_CLOSE`로 삭제를 요청했지만 같은 프로세스의 핸들이 열려 있는 삭제 대기(delete-pending)
이름으로 복사하면 `PERMISSION_DENIED`이고, 마지막 핸들을 닫은 뒤에는 같은 이름으로 복사된다는 것도 확인한다.
네트워크 파일 시스템, 볼륨 종류(NTFS와 ReFS), POSIX 방식 삭제, 다른 프로세스가 연 핸들로 인한 삭제 대기는 확인하지 않는다.

`windows-storage-remove-recursive.ts`는 실제 Windows 파일 시스템으로 유니코드 중첩 트리와 빈 디렉터리 삭제 및 형제 유지,
1500개 항목 삭제, 읽기 전용 파일과 디렉터리 삭제, 루트가 파일인 경우,
hardlink의 이름만 삭제를 확인한다. 읽기 전용 hardlink를 지울 때 다른 이름의 속성이 바뀌는지는 확인하지 않는다. 트리 안의 junction, 디렉터리 symlink와
파일 symlink(만들 수 없는 러너에서는 건너뜀)가 어댑터, `fs.promises.rm`, `rmSync` 모두에서 링크만 지워지고 대상은
남는지, 링크를 루트로 줘도 같은지 확인한다. 가상 디스크(diskpart)를 트리 안의 폴더에 볼륨 마운트 지점으로 붙이고
삭제한 뒤 마운트된 볼륨의 파일이 남는지 미리 붙여 둔 두 번째 마운트 폴더로 읽어 확인한다(diskpart를 쓸 수 없는 로컬 환경에서는 건너뛰고, `CI`가 설정된 환경에서는 실패).
시작 전 취소는 아무것도 지우지 않고, 시작한 삭제는 취소해도 끝까지 가며,
해제한 어댑터와 없는 경로는 거부한다.
확인하지 않는 범위: 삭제 중 사라지거나 교체되는 항목, OneDrive 같은 클라우드 동기화 폴더의 삭제(로그인한 동기화 공급자가 필요),
다른 프로세스가 삭제 공유 없이 연 파일, ACL로 삭제를 막은 항목, Worker 경로의 권한 거부(별도 뷰가 필요해
계약 테스트의 독립 권한으로만 확인), 기한(deadline)의 호스트 경로, 10만 개 항목의 실제 순회 시간.

`api/storage-windows-path.test.ts`는 Windows 경로 형식(드라이브와 UNC 허용, 상대 경로와 `.`과 `..`와 예약 이름과
끝의 점과 금지 문자 거부, 장치와 NT 접두사 거부)을 Linux에서도 검사한다.

`api/storage-macos-path.test.ts`는 macOS 경로 문법(절대 경로와 `/tmp` 같은 별칭 허용, 상대 경로와 `.`과 `..`와 빈 요소와
NUL과 줄바꿈과 짝 없는 서로게이트와 길이 초과 거부)을 Linux에서도 검사한다.
`macos-storage.ts`는 실제 macOS 파일 시스템으로 텍스트와 바이트 왕복, symlink와 부모 링크와 hardlink의 추종,
FIFO 거부, chmod 0 파일의 `PERMISSION_DENIED`, 4 MiB를 넘는 복사, 기존 대상(파일, 링크, 대상 없는 링크, 디렉터리)을
덮어쓰지 않는 복사와 이동, 디렉터리와 다른 폴더로의 이동, 자기 하위로의 이동 거부, 링크가 든 트리의 용량 계산과
재귀 삭제(링크의 대상 유지), 재시작과 fd 정리를 확인한다.
`macos-storage-directories.ts`는 목록의 UTF-16 정렬과 링크 및 hardlink 종류, 256개 경계, 생성 계약, 링크 추종,
파일과 링크와 빈 디렉터리 삭제를 확인한다.
`macos-storage-names.ts`는 합성형과 분해형 이름, 대소문자만 다른 이름이 볼륨의 조회 결과와 어댑터에서 일치하는지와
목록이 만든 때의 표기를 유지하는지를 확인한다. CI의 macOS 러너는 기본 APFS(대소문자 무시)라 대소문자를 구분하는
볼륨은 이 검사로 실행하지 않는다. 기존 native workflow가 source fixture를 compile하고 ad-hoc 서명한 뒤 실행한다.
`macos-storage-host.ts`와 browser fixture는 실제 packaged WKWebView에서 디렉터리 목록과
생성, 이동과 삭제, 독립 권한과 재시작을 검증하며 `mise run host:macos`에 포함한다.
확인하지 않는 범위: 다른 볼륨 이동(`EXDEV`)과 `RENAME_EXCL`을 지원하지 않는 파일 시스템(`ENOTSUP`),
삭제 중 사라지거나 교체되는 항목, 접근 거부된 하위 디렉터리를 가진 트리의 용량 계산.
Linux에서 Darwin fixture를 건너뛰는 결과는 실제 macOS 실행 근거가 아니다.

`api/zod-promise.test.ts`는 ESM과 CommonJS의 실제 Worker에서 Zod의 형제 검사 실패,
끝나지 않는 검사, 정상 변환 횟수와 when, abort 동작을 확인한다.
`cli/zod-distribution.test.ts`는 새 프로젝트에 원본 Zod와 배포 패키지를 설치하고
설치된 CLI의 제품 및 개발 앱 번들에서 동일한 SDK 입력과 출력 회귀를 실행한다.
이 검사는 Win32, WebView2나 WKWebView의 실제 네이티브 실행을 대신하지 않는다.

`api/clipboard-formats.test.ts`와 `lifecycle/clipboard-codecs.test.ts`는 RGBA 상한과
canonical base64, 다중 형식의 JSON 예산, CF_HTML byte offset과 잘못된 UTF-8,
DIB의 행 방향과 padding, alpha 및 잘못된 profile, mask, 크기를 확인한다.
`clipboard-resources.test.ts`는 다중 HGLOBAL의 준비 실패와 부분 등록에서 소유권과
정리가 유지되는지 격리된 Win32 바인딩으로 확인한다. 실제 `windows-clipboard.test.ts`는
`mise run host:windows`에 포함되며 공통 SDK와 UI Worker에서 텍스트, HTML, RTF,
파일 목록과 이미지, 지원 형식 발견을 왕복한다. 테스트는 CI 데스크톱 clipboard를
변경하고 원래 Unicode 텍스트만 복원한다. WebView2 페이지나 다른 앱의 붙여넣기,
물리 장치 검증을 뜻하지 않는다.

`api/window-monitors.test.ts`는 음수 화면 원점, 32비트 rectangle overflow, 개별 조회 권한,
취소와 모니터 서비스 미지원 계약을 검사한다. `windows-monitors.test.ts`는 실제 Win32
디스플레이 열거와 MONITORINFOEXW rectangle, 주 모니터, 점과 rectangle 선택, 최소화 전
모니터 및 반복 callback 정리를 검사한다. `windows-bun-window-api.ts`는 실제 WebView2의
명령 컨텍스트에서 같은 조회와 권한 거부를 검사한다. 두 네이티브 검사는
`mise run host:windows`에 포함한다. `windows-bun-window-api.ts`는 `windows.center`에 현재 모니터의 공개 ID를
넘겨 작업 영역 중앙 배치와 상태 보존을 확인하고, 연결되지 않은 ID가 `INVALID_ARGUMENT`로 거부되며
창 위치를 바꾸지 않는지도 검사한다. `api/window-geometry.test.ts`는 `monitorId` 스키마와 어댑터 전달,
`center` 미지원 시 `UNSUPPORTED`를 검사한다. CI의 디스플레이 구성에서 실행하며 실제 다중 물리
모니터의 hotplug, 혼합 DPI와 회전 또는 사용자 커서 조작 검증을 대신하지 않는다.


`api/window-monitor-events.test.ts`는 versioned snapshot과 이벤트 스키마, 독립 조회 권한,
취소와 선택적인 snapshot 서비스 미지원을 검사한다. 잘못된 protocol error가 포함된 snapshot은
`safeParse`와 `safeParseAsync`에서 예외 대신 Zod 오류를 반환하는지도 확인한다. `lifecycle/windows-monitor-events.test.ts`는
초기 replay 부재, id별 변경과 알림 병합, 배열 순서 변경 억제, 오류 중 마지막 유효 목록 보존,
오류 정제와 복구 및 반환 snapshot의 복사 격리를 검사한다. 같은 파일의 Windows 전용 검사는
실제 숨겨진 HWND에 WM_DISPLAYCHANGE, WM_SETTINGCHANGE와 WM_DEVICECHANGE를 보내고
제어한 모니터 값으로 메시지 처리 뒤 병합, 변경 억제와 정리를 확인한다.

`lifecycle/windows-monitor-events.ts`는 실제 Win32와 WebView2, UI Worker, Core 및 SDK를
연결한다. 테스트 번들에서만 실제 디스플레이 열거에 합성 이름 변경과 조회 실패를 추가한다.
실제 알림 HWND에 합성 메시지를 보내 이벤트 전달, 이벤트 또는 조회 권한 누락, 초기 replay 부재,
오류 복구, 구독 해제 뒤 snapshot 복구, 탐색과 창 재생성 및 종료 정리를 검사한다.
두 Windows 전용 검사는 `mise run host:windows`에 포함한다. 실제 모니터 구성이나 OS 설정을
변경하지 않으며 물리 장치 hotplug, 혼합 DPI, 회전 검증을 대신하지 않는다.

`api/power.test.ts`는 배터리의 0과 unknown, 배터리 없음, DWORD tick 순환,
독립 blocker ID와 128개 상한, 부분 활성 실패 및 반복 정리를 검사한다.
`power-cleanup.test.ts`는 플러그인 정의의 SDK factory와 실제 어댑터, 두 handle 소유자를 번들해 격리된 Win32 바인딩에서
public 요청 해제와 활성 rollback 해제가 함께 실패해도 모든 handle을 재시도하고,
미해제 handle이 있는 동안 DLL을 유지하며 두 단계의 오류를 보고하는지 검사한다.
`cli/power.test.ts`는 isolated tarball 설치와 UI 어댑터 발견, browser의 FFI 제외를 검사한다.
`windows-power.test.ts`는 실제 GetSystemPowerStatus와 session idle query, PowerCreateRequest,
system/display 활성 및 GetHandleInformation으로 명시 해제와 종료 시 handle 정리를 확인한다.
`windows-power-ui.test.ts`는 빌드한 공개 power API에서 실제 UI Worker까지 상태와 idle,
독립 ID, 개별 권한 거부, 명시 해제와 종료 정리를 확인한다.
`power-status-events.test.ts`는 전원 상태 변경 감시가 baseline 한 번 읽기, 상태 변경 알림과 resume의
재조회, 동일 값 생략, 무관한 신호 무시, 읽기 실패 시 baseline 유지와 반복 가능한 해제를 검사하고,
`api/power.test.ts`는 `power.statusChanged`의 portable schema가 상태 schema와 일치하며 이벤트 정책과
읽기 권한을 모두 가진 경로에만 전달되는지 검사한다. `power-cleanup.test.ts`는 구독 해제 실패에도
blocker와 DLL 정리를 계속하고 재시도할 수 있는지 함께 검사한다.
`windows-power-events.test.ts`는 실제 숨은 알림 HWND에 합성 전원 방송을 보내 재조회, 변경 게시, 해제 뒤
HWND 파괴와 미전달을 확인한다. `mise run host:windows`에 포함하며 물리 배터리 전환, 화면 꺼짐과 idle 절전 또는
Modern Standby 및 사용자 절전 후 요청 종료의 하드웨어 검증을 대신하지 않는다.

`appearance.test.ts`는 선호의 null, 색 형식과 개별 operation 권한, 호출 컨텍스트를 확인한다.
CLI의 같은 이름 검사는 로컬 tarball의 isolated 설치, 네이티브 I/O 어댑터 발견과 browser
번들의 FFI 제외를 검사한다. `windows-appearance.test.ts`는 실제 Windows 고대비,
client-area animation, screen reader 설정 플래그 및 시스템 색과 비교하고 두 어댑터의
DLL 수명과 종료 후 거부를 확인한다. `mise run host:windows`에 포함한다.
`macos-appearance.test.ts`는 밝고 어두운 일반 및 contrast appearance를 앱에 지정하고
실제 AppKit의 effectiveAppearance에 대한 best-match 테마와 sRGB 색, NSWorkspace 플래그를 비교한다.
drawing appearance 복원,
1,000번 조회와 독립 어댑터의 반복 정리를 확인한다. 사용자 OS 설정은 바꾸지 않는다.
새 프로세스의 배포 플러그인이 직접 AppKit를 로드하고 독립 어댑터의 수명을 유지하는지도 확인한다.
별도 프로세스에서 동기 GC 압력을 높인 1,000회 조회도 같은 30초 기한으로 검사한다.
`macos-appearance-theme.test.ts`는 `setTheme`가 실제 `NSApplication.appearance`를 Aqua, DarkAqua와 nil(system)로
바꾸는지, 창 ID와 신뢰되지 않은 호출의 거부, 어댑터 종료 때의 nil 복원을 확인한다.
`macos-appearance.ts`는 로컬 빌드한 플러그인과 실제 WKWebView, backend Worker를
ad-hoc 서명 compiled 앱에 연결해 plugin setup의 backend 권한과 직접 및 앱 명령을 통한
뷰 권한의 독립 허용 및 거부,
엄격한 입력과 색 범위, 네 번의 앱 실행 및 정상 종료를 검사한다.
`run-native.ts`의 macOS 경로와 기존 macOS native CI에 포함한다.
사용자 테마 변경과 실제 보조 기술 또는 WebView 접근성 트리 검증을 대신하지 않는다.

`system-events.test.ts`는 선택 OS 알림 HWND의 지연 생성, 중복 해제, 조회 실패 후 복구,
WTS 등록 실패, 상태 알림 합치기, lifecycle 순서와 큐 초과를 검증한다. 복귀 뒤 사용자
활동 알림이 다른 pump 배치 또는 설정 알림 뒤에 도착해도 resume이 중복되지 않는지 검사한다. 조회 권한과
현재 이벤트 route를 모두 가진 수신자에게만 전달하는 계약도 검사한다.
`windows-system-events.test.ts`는 실제 Windows 숨김 HWND, 메시지 pump와 WTS 등록을
사용한다. 메시지는 합성 입력이며 실제 하드웨어 절전이나 사용자 세션 잠금 검증을
대신하지 않는다. Linux에서는 이 네이티브 회귀를 건너뛴다.

`api/image.test.ts`와 `lifecycle/image-resources.test.ts`는 선택 image 플러그인의
Zod 계약과 canonical base64, 빈 이미지, operation 권한, ID 해제와 앱 종료,
count와 메모리 quota 및 생성 취소의 정리를 확인한다. `image-resources.test.ts`는
macOS 공통 probe에 가짜 codec을 주입해 모든 OS에서 직접 호출, 권한과 취소 검사를
실행한다. 소스, 설치 패키지와 compiled probe는 같은 플러그인 진입점과 fixture의
호스트 권한 검사를 사용하며, 실제 WKWebView 권한은 `macos-image-host.ts`에서 검증한다.
`windows-image.test.ts`는
`host:windows`에 포함하며 공통 SDK와 실제 UI Worker, WIC에서 PNG와 data URL의
RGBA alpha 왕복, JPEG와 BMP, 잘못된 encoded 입력과 decode 크기, 최대 PNG,
정책 거부와 결과 전달 전 취소를 확인한다. 실제 파일 경로 접근, WebView 표시,
다른 앱의 가져오기, 색상 관리와 최소 Windows 버전 검증은 포함하지 않는다.

`image-crop.test.ts`는 offset rectangle과 행 복사, alpha, 소스 보존, 잘못된 영역,
생성 취소와 새 ID를 확인한다. `image-resize.test.ts`는 nearest resize의 출력 중심 선택,
축소와 비정수 비율, 투명 RGB와 반투명 채널의 정확한 복사, 소스 보존과 크기 상한을 확인한다.
`windows-image.test.ts`는 실제 UI Worker의 nearest resize와 WIC linear resize,
linear filtering의 투명 edge, crop과 빈 소스 및 quota 오류를 추가로 검사한다.
이 transform 검사도 `host:windows`에서 실행하며 소스 리소스는 변경하지 않는다.

`api/os.test.ts`는 독립 작업 권한과 metadata 계약을 검사한다. `lifecycle/windows-os.test.ts`는
실제 Kernel32 언어 설정 조회와 Bun 실행 정보를 생성 어댑터에서 검사하며 `host:windows`에 포함된다.
사용자 언어 설정 변경이나 translation 하드웨어 검증은 포함하지 않는다.

`api/process-plugin.test.ts`는 local `.exe` argv 계약과 독립 실행 권한을 검사한다.
`lifecycle/process-run.test.ts`는 실제 Bun 자식의 특수 인자, binary stdin/stdout/stderr, 합계
출력 제한과 내부 실행 작업의 취소 후 직접 자식 종료를 확인한다. `windows-process.test.ts`는 생성 Windows
어댑터의 timeout, capacity와 폐기를 실제 `.exe`로 확인한다. 실제 core/client 공개 호출에서 취소
전달을 보류해 공개 Promise 거부 시 자식이 아직 살아 있음을 확인하고, 전달 후 어댑터의 정리와
자식 종료를 확인한다. 공개 Promise 거부는 종료 완료를 보장하지 않는다. 두 검사는 `host:windows`에 포함되며
`process-run.test.ts`는 Windows에서 취소, timeout, 출력 초과와 루트 종료 후 호출별 손자 정리도
검사한다. 내부 호출이 끝난 즉시 보관한 process handle의 종료 상태를 확인하며, 실패에는 종료 방식과
루트 또는 손자의 PID를 표시한다. 출력 초과 오류는 정리 실패와 구분한다. 제삼자 도구의 부수 효과는 검증하지 않는다.
자식은 PID 파일 쓰기를 완료한 뒤 rename으로 준비를 알린다. 두 생존 검사는 파일 생성과 쓰기 사이의
경합으로 빈 PID를 읽지 않고, 취소 전에 실제 자식의 Windows process handle을 잡는다.

`api/process-spawn.test.ts`는 `process.spawn` 계열의 연산 등록, 독립 권한, 입력 검증과 핸들 계약을
Bun 자식으로 검사한다. stdin/stdout/stderr 왕복과 종료 상태, 종료 한 번 보고 뒤 해제, 다른 호출자의
핸들 거부, 동시 read/write 거부, 대기 시간, 취소, 동시 핸들 상한, 읽지 않은 파이프의 배압, 종료 후
보존 기한과 폐기를 포함한다. Win32 Job과 파이프는 실행하지 않는다.
`lifecycle/windows-process-spawn.test.ts`는 Windows에서만 실제 `.exe` 자식으로 `kill`과 루트 종료가
손자까지 끝내는지, 가득 찬 stdin 파이프의 write 취소, 대기 중인 write와 `kill`, 읽지 않은 출력의
배압, 반복 spawn과 `kill` 뒤 핸들 수, 폐기 시 손자 종료를 확인하며 `host:windows`에 포함된다.

`api/network.test.ts`는 URL, header, bytes 상한과 독립 작업 권한을 검사한다.
`lifecycle/windows-network.test.ts`는 생성 Windows와 macOS 어댑터 및 실제 loopback HTTP/WebSocket 서버로
redirect 거부, binary 보존, timeout, 취소, 폐기와 용량을 검사한다. `host:windows`에 포함되며
외부 proxy나 OS 인증, 물리 네트워크 설정 검증은 포함하지 않는다.

`lifecycle/macos-network.ts`는 `host:macos`에서 compiled WKWebView, SDK, Core와 async UI
어댑터를 실제 loopback 서버에 연결한다. 뷰 grant와 앱 명령의 출처 유지, backend grant,
HTTP binary 및 UTF-8, redirect와 WebSocket handshake 거부, decompressed body 상한,
text/binary 메시지, timeout과 SDK deadline, 취소 뒤 실제 TCP 정리와 종료 중 pending 요청 정리를
확인한다. 결과는 `build/macos-native-logs/network-results.json`이며 기존 네이티브 CI artifact에 포함된다.
실패 시 child를 종료하고 pipe를 수집한 뒤 host 로그, stdout/stderr와 요청 및 socket 관측값을
`build/macos-native-logs/network-diagnostics/`에 보존한다. report가 있으면 미완성 파일도 원본으로
보존하며 임시 package를 제거하기 전에 기존 macOS native artifact 경로에 기록한다.
`macos-network-diagnostics.test.ts`는 살아 있는 실제 child의 pipe 수집과 package 제거 뒤
진단 보존, 실행 전 실패와 이전 report 정리를 검사한다. 기존 assertion은 유지하고, 느린 macOS runner를
고려해 단계별 대기(WKWebView report, HTTP abort cleanup)는 45초(기존 20초), host 프로세스 제한은
120초(기존 30초)로 늘렸다. timeout 메시지와 진행 로그에는 단계, 경과 시간과 기한이 기록된다.
`api/network-resolve-host.test.ts`는 `network.resolveHost`의 권한, 호스트 이름 검증, 주소 매핑과 제한, 취소와
기한을 가짜 리졸버로 검사하고 `localhost`는 실제 리졸버로 조회한다.
`api/network-resolve-host-query-type.test.ts`는 `queryType`의 허용 값, 주소족 필터와 중복 제거, 리졸버에 주소족을
직접 요청하는지, 그 주소족이 없을 때 리졸버 실패의 전달을 가짜 리졸버로 검사하고 `localhost`와 `127.0.0.1`은 실제 리졸버로 조회한다.
`lifecycle/windows-network-resolve-host.test.ts`는 생성 Windows와 macOS 어댑터로 `localhost`를 조회한다.
`api/network-download.test.ts`는 `network.download`의 입력 한도, 권한, Windows와 그 밖의 시스템 경로 규칙, 로컬 서버로
저장, 상태 코드와 redirect 반환, 대상 존재와 `overwrite`, 길이 선검사와 `maxBytes` 초과, 중간 끊김, 유휴 기한, 진행률 조회의
출처 범위, `cancelDownload`와 호출 취소, 동시 4개 한도, 어댑터 정리 뒤 임시 파일 삭제를 검사한다.
`lifecycle/windows-network-download.test.ts`는 생성 Windows와 macOS 어댑터가 실제 파일 시스템에서 저장, 덮어쓰기, 폴더 거부,
진행 중 취소와 임시 파일 삭제를 하는지 검사한다.
`api/network-upload.test.ts`는 `network.upload`의 입력 거부(메서드, 전송 관리 header, ID), 로컬 서버가 받는 메서드와 길이와 본문,
chunked 본문을 보내지 않음, 서버가 읽지 않을 때 읽기가 멈추는지, 파이프 거부, 느린 응답 본문의 무진행 기한 갱신, 빈 파일, redirect와 오류 상태 반환, 응답 본문 한도, 없는 파일과 폴더와 상대 경로 거부, 진행 중 파일이
줄어들면 실패, 늘어난 부분은 보내지 않음, 진행률 조회의 출처 범위, `cancelUpload`와 호출 취소, 무진행 기한과 전체 기한,
동시 4개 한도, 어댑터 정리를 검사한다.
`lifecycle/windows-network-upload.test.ts`는 생성 Windows와 macOS 어댑터가 실제 파일 시스템에서 전송, 취소와 정리 뒤 파일 삭제를 검사한다.
`api/network-resolve-proxy.test.ts`는 `network.resolveProxy`의 권한, 입력과 결과 스키마, 프록시 목록과 예외 목록 해석,
자격 증명 제거, 루프백 직접 연결, 자동 구성 단계의 순서와 기한, 취소와 정리를 가짜 WinHTTP로 검사한다.
`lifecycle/windows-network-resolve-proxy.test.ts`는 생성 Windows 어댑터의 실제 WinHTTP 호출 형태와, 임시 PAC 파일을 쓰는 실제 WinHTTP 바인딩을 검사한다.
`cli/network.test.ts`는 isolated tarball 설치의 두 OS native export에서 실제 HTTP를 실행하고
browser 번들에 Bun 전송 구현이 포함되지 않는지 검사한다. TLS, 외부 proxy와 OS 인증은 검증하지 않는다.

`lifecycle/windows-trash.test.ts`는 실제 Windows I/O STA에서 파일을 휴지통으로
보내고 해당 `$I` 메타데이터와 `$R` 파일 내용을 확인한다. HTML 연결 폴더 보존,
파일 소실, 부모 고정과 삭제 공유 중 파일 교체 거부를 검사한다. 테스트는 해당
파일의 휴지통 항목만 정리하며 전체 휴지통을 비우지 않는다. 셸이 유지하는 COM Worker가
다른 초기화 회귀에 영향을 주지 않도록 별도 Bun 프로세스에서 실행한다. `host:windows`에
포함한다. `lifecycle/windows-trash-limits.test.ts`는 셸이 설정을 프로세스 단위로 유지하므로 호출마다
새 Bun 자식 프로세스에서 현재 사용자(HKCU)의 휴지통 설정을 바꾸고 확인한다. 정책 비활성화와 볼륨 영구
삭제 설정은 `UNSUPPORTED`로 실패하고 파일이 제자리에 남으며 휴지통에 사본이 없어야 하고, 레지스트리 값은
되돌린다. 용량 초과와 영구 삭제 경고 UI는 응답할 사용자가 없어 검증하지 않는다.

`api/global-shortcut.test.ts`는 전역 단축키 권한, 등록 rollback, 중지와 재개 및 이전 메시지 폐기를 검사한다.
`api/global-shortcut-macos.test.ts`는 가짜 Carbon 드라이버로 macOS 어댑터의 키 표, 등록 충돌과 rollback,
press와 release 짝, 중지와 재개 때 ID 교체, dispose를 검사한다.
`lifecycle/macos-global-shortcut.ts`는 macOS native 잡에서 실제 Carbon 핫키를 호스트 이벤트 루프 위에 등록해
중복 등록 거부와, 이벤트 큐에 넣은 누름과 뗌 이벤트의 전달, 중지와 제거 뒤의 무시를 확인한다.
실제 키 입력(CGEventPost)도 시도해 탭별 결과를 로그로 남기지만 호스티드 러너에서는 전달되지 않아 검증 범위가 아니다.
`lifecycle/windows-global-shortcut.test.ts`는 실제 RegisterHotKey와 경쟁 HWND, SendInput, 중지와 정리를 확인한다.
`windows-global-shortcut-ui.test.ts`는 단축키 단독 실행과 menu, tray 동시 실행을 실제 UI
Worker에서 검사한다. 메뉴, 사용자 정의 아이콘, 단축키와 입력 대기가 함께 살아 있는 상태에서
종료하고 단축키 및 트레이 HWND가 모두 해제되는지 확인한다.
`mise run host:windows`에 포함되며 물리 키보드와 키보드 레이아웃별 검증을 대신하지 않는다.

`api/menu.test.ts`는 메뉴 리소스 제한, 트리 검증, 개별 권한과 변경 실패 보존을 검사한다.
`lifecycle/windows-menu.test.ts`와 `windows-menu-ui.test.ts`는 실제 HMENU 및 UI Worker의 창 없는 트레이와 자원 정리를 확인한다.
`mise run host:windows`에 포함되며 사용자 클릭과 키보드 메뉴 조작의 수동 검증을 대신하지 않는다.

`api/tray.test.ts`는 ICO 범위, UTF-16 tooltip, 권한과 입력 대기의 정리를 검사한다.
`lifecycle/windows-tray-controls.test.ts`와 `windows-tray-ui.test.ts`는 실제 shell 업데이트와 synthetic mouse/TaskbarCreated 메시지, UI Worker와 HWND 정리를 확인한다. `windows-tray-ui.test.ts`는 `tray.destroy`와 `tray.create`도 확인한다: 제거 뒤 HWND 소멸, keep-alive 종료 메시지 창 유지, 제거 중 `UNSUPPORTED`, 재생성 뒤 새 HWND와 입력 재수신, 중복 `create`의 `INVALID_ARGUMENT`.
물리 마우스나 실제 Explorer process 재시작은 별도 검증이다.
`lifecycle/tray-cleanup.test.ts`는 실제 Tray 소유자를 별도 프로세스에 번들하고 Win32
해제 실패를 주입해 핸들 소유권, 재시도와 종료 중 콜백 차단을 확인한다.
`windows-ui-lifecycle.test.ts`는 실제 UI Worker에 트레이 해제 실패를 주입해 원래 오류가
유지되고 어댑터, COM, 창과 apartment 정리가 계속 실행되는지 확인한다. 실패한 트레이
자원이 남아 있으면 DLL 바인딩을 닫지 않는다. 이 실패 검사는 모의 네이티브 경계를 사용한다.

`lifecycle/macos-io-host.ts`는 `host:macos`의 실제 compiled WKWebView에서 공통
I/O Worker의 실행, 백엔드 setup과 뷰 출처, 파싱 전 정책 검사, UI/I/O 지원 목록,
동기 I/O 중 AppKit 왕복, 취소와 문서 폐기, 초기화 실패와 5초 종료 기한을 검사한다.
테스트 어댑터는 실제 파일을 쓰며 개별 제품 플러그인의 macOS 지원 검증과 구분한다.
`build/macos-io-results.json`에는 OS, CPU, Bun revision과 시나리오별 종료 결과를 남긴다.
공통 Worker와 메인 호스트를 사용하는 `macos-bun.test.ts`의 I/O 파싱 취소 검사는
Linux에서도 실행하며 실제 AppKit은 대체한다.

`macos-bun.test.ts`는 진행 중인 백엔드 I/O의 abort를 기다리는 StopHook도 실제
Worker로 검사한다. 종료 요청이 I/O 취소를 먼저 전달하고 코어 훅 뒤에 어댑터를
폐기해 강제 종료 없이 끝나는지 확인한다. 실제 WKWebView fixture도 같은 순서를 검사한다.

`lifecycle/macos-image.test.ts`는 macOS arm64의 실제 ImageIO, CoreGraphics와 vImage로
PNG alpha 및 투명 RGB 왕복, grayscale과 palette PNG, JPEG/BMP, malformed와 큰 decode 입력,
transform, 독립 어댑터 ID, quota, 취소와 반복 종료를 검사한다. 다른 OS에서는 건너뛴다.
`cli/image.test.ts`는 image tarball의 isolated 설치와 플랫폼 출력 분리를 검사하며 macOS arm64에서
설치된 codec을 실제로 실행한다. `.github/workflows/ci.yml`의 `macos-native` 작업은 이 두 파일과
기존 entitlement로 ad-hoc 서명하고 strict 검증한 compiled codec fixture를 각각 한 번 실행한다.
CI의 공통 계약 작업은 두 파일을 제외하며, 로컬 `mise run check`는 계속 전체 계약을 실행한다.
세 OS의 계약 작업과 Windows, macOS 네이티브 작업을 합쳐 CI 작업 수는 다섯 개다.
`macos-native-diagnostics` artifact는 `build/macos-image-logs/`의 native 및 compiled 로그와
`build/macos-image-results.json`을 7일간 보관하며 실패한 작업에서도 업로드한다.
이 단독 codec 검사는 공통 SDK와 실제 호스트 연결, WKWebView 표시나 다른 앱의
가져오기 검증과 구분한다.

`lifecycle/macos-image-host.ts`는 actual compiled 호스트와 WKWebView 명령에서 공개
backend SDK의 image I/O 호출과 setup, codec, crop/resize, 동일 ID의 작업별 뷰 권한,
해제 및 정상 종료를 검사한다. 실제 image 어댑터가 ID를 할당한 뒤 I/O Worker를 동기적으로
지연시켜, 결과 전달 전 취소가 미전달 ID를 해제하는지 확인한다. 할당 marker는
매 poll마다 새 `Bun.file()`로 확인해 파일 생성 전의 부재 상태를 재사용하지 않는다.
`build/macos-image-host-results.json`을 기록하며 성공을 요구한다. `run-native.ts`의
macOS 실행에 포함하며 실제 contextual I/O dispatch를 사용한다. 같은 `macos-native` 작업에서
`run-native.ts --app`이 이 호스트 검증을 한 번 실행한다. 결과 JSON과
`build/macos-native-logs/host.log`도 같은 artifact에 보관한다.
단독 compiled codec과 signed WKWebView 호스트는 서로 다른 실행 경로를 검사한다.

## iOS 내장 Bun

`mise run host:ios -- <booted Simulator UUID>`는 macOS arm64와 Xcode에서 설치된 CLI로
Simulator 앱을 빌드하고 실행한다. 실제 WKWebView의 SDK, Core, 정책, 이벤트, 큰 UTF-8 응답과
파일 import, 두 번의 백엔드 Worker 교체 및 상태 초기화를 검사한다.
Swift 로그의 제어 파이프 분리, 문서 오류 회수, 이전 nonce 입력과 없는 자산의 탐색 실패,
루트 자산 경로 및 Xcode bundle ID 변경도 실제 호스트에서 검사한다.
현재 provisional 탐색의 실제 취소 후 재연결과 후속 탐색 보존도 검사한다.
이미 교체된 탐색의 취소와 오류는 새 문서 연결 후 fixture가 delegate 콜백을 직접 전달한다.
600KB 슬래시 문자열 왕복과 필드, 타입, 크기, 깊이 등을 위반하는 입력 10종을 검사해
문서만 닫히고 새 문서의 Core 명령이 정상 실행되는지 확인한다.
해시 할당과 링크, 실제 캐시 복원 후 새 SDK 연결, 느린 WebView로 160개 이벤트의 순서,
200개 원시 입력으로 문서 쓰기 큐 포화, 없는 home의 복구 제한과 재시도 버튼도 검사한다.
fixture가 실패한 탐색을 직접 복구하지 않으며 실제 호스트의 복구를 기다린다.
일반 Simulator 대상의 arm64 빌드도 별도로 실행한다.
최종 `.app`에 포함된 Bun, libffi 라이선스와 프레임워크 고지 4개 파일을 원본과 바이트 단위로 비교한다.
기본 HTTPS 포트 `:443`을 명시한 home이 정규화되어 실제 앱이 시작되는지 검사한다.
`ios-build-cancel.fixture.ts`는 설치된 CLI의 출력 해시 계산 중 실제 SIGINT를 보내
빌드 실패, 기존 출력 보존, staging 정리와 잠금 재획득을 확인한다.
`tests/cli/ios.test.ts`는 네이티브 도구 없이 설정과 동기화 보존, Worker 세대 교체를 검사한다.
`tests/lifecycle/ios-bridge.test.ts`는 실제 bridge와 SDK transport로 nonce 격리, 닫힘과
캐시 pageshow의 재로드를 검사한다. WebKit 탐색 자체는 Simulator fixture의 범위다.
`tests/cli/mobile-project.test.ts`는 두 모바일 타깃의 잠금과 staging 정리,
실제 자식 CLI 프로세스의 SIGTERM 취소 후 잠금 재획득을 검사한다.
`tests/lifecycle/ios-backend-input.test.ts`는 입력 스트림이 닫힌 뒤 도착한 프레임에
Worker가 성공 응답을 보내지 않고 오류로 종료하는지 검사한다.
기기 실행과 배포 서명, 스토어 제출은 별도 검증이 필요하다.

모바일 브리지의 WebSocket 연결과 fallback, 출력 버퍼 제한, 연결 후 재전송 금지는
`native/mobile/bridge.js`의 같은 구현을 사용한다. `loopback-channel.test.ts`는 HTTPS와
`bunaway://` 출처 모두에서 정확한 Origin, 일회용 토큰과 문서 회수를 검사한다.
iOS 실제 호스트 검사는 직접 WebSocket과 최초 연결을 강제로 거부한 Swift fallback을 각각 실행한다.
각 경로에서 세 Worker 세대와 기존 문서 수명 회귀를 확인하고 Swift를 통과한 SDK hello 수로
실제 사용 경로를 구분한다. iOS Worker 계약 검사도 정책의 HTTPS와 WebKit의 자산 Origin을
구분하고 잘못된 출처를 거부한 뒤 정상 연결과 회수를 확인한다.

`lifecycle/macos-webview-diagnostics.test.ts`는 창별 64개 기록 상한과 미등록 NSError
domain 제거, signed code를 검사한다. 실제 macOS arm64에서는 NSError의 -999 code를
FFI로 읽는 ABI도 확인하며 기존 macOS native 실행기에 포함한다.
`action-policy`와 `response-policy`는 정책 결과를 기록하고, 각각의 `-returned` 단계는
네이티브 decision handler 호출이 반환한 뒤 기록한다. 허용 결정과 호출 완료를 구분하며
이 기록만으로 WebKit의 이후 탐색 진행을 보장하지 않는다.
`macos-network.ts`의 성공 결과에는 고정 WebView 단계 기록을 함께 보관한다.
실패한 실행은 기존 catch가 출력한 호스트 로그를 기존 CI artifact의 host.log에서 확인한다.
#170의 raw report, counter와 pipe 보관 작업을 이 변경에 복제하지 않는다.
기존 19개 assertion과 기한은 유지하며 통과한 단일 실행으로 과거 startup timeout의
원인이 해결됐다고 판단하지 않는다.

Windows 호스트의 `webview-creation`은 환경 요청, 반환과 완료, 각 창의 환경 수신,
컨트롤러 요청, 반환과 완료 및 설정 완료를 기록한다. 창 ID, 단조 시계의 전체 및 현재
단계 경과 시간과 대기 중인 생성 수로 지연 구간을 구분한다. `webview-creation-timeout`은
기존 30초 준비 기한을 넘긴 시점의 단계와 UI 준비, 시작 요청, 창 수명 상태를 기록한다.
`webview-ready`는 컨트롤러 획득 시의 기존 기록이며 설정 완료나 SDK 준비를 뜻하지 않는다.
콜백, 메시지 pump, 기한과 준비 완료 조건은 변경하지 않는다.

`lifecycle/macos-webview-readiness.test.ts`는 실제 controls 웹 fixture와 SDK를 browser
번들로 만들고 별도 Bun 자식에서 arrival 응답을 보류한다. arrival과 loading=false만으로
다음 탐색을 시작하지 않으며, 해당 문서의 held 명령 시작과 loading=false를 모두
확인하는지 검사한다. 이전 문서의 held 수가 남아 있는 두 번째, 세 번째 연결도 포함한다.
네이티브 controls fixture는 같은 준비 절차를 사용하고 단계별 wait 기한은 45초,
호스트 캡처 기한은 120초다. 시간 초과 메시지와 progress 기록에 단계와 경과를 남긴다.
이 검사는 fixture의 명령 시작 순서를 검증하며 WKWebView 실행은 기존 native CI에서 확인한다.
실패 artifact의 `controls-progress.json`은 backend Worker가 동기식으로 교체한 마지막
준비 대기 단계와 arrival, held, cancelled 수를 보관한다. 대소문자 URL 탐색의 호출 전후,
실패 후 진단 상태 조회의 전후도 기록하므로 UI 로그가 멈춰도 대기 지점을 구분할 수 있다.
이 기록만으로 네이티브 호출이 멈췄다고 판단하지 않는다.

Windows 자산 probe는 두 Worker의 결과와 종료를 모두 확인한 뒤 프로세스를 마칩니다.
프로세스 종료 직후 Windows의 이미지 핸들 해제가 지연될 때는 해당 임시 폴더의 정리만
정해진 횟수 안에서 재시도합니다. 기능 검증이나 테스트 실행은 재시도하지 않습니다.
앱 재로드 fixture는 완성한 JSON 보고서를 rename으로 교체해 폴링 중인 독자가
쓰기 도중의 빈 파일을 읽지 않게 합니다. Android backend 추출 검사는 컴파일과
harness의 기존 15초 제한을 각각 유지하며 출력과 경과 시간, 종료 상태를
`build/windows-matrix-logs/android-backend-assets/`에 보존합니다.
PR #191과 같은 native child observer 및 notification 진단을 사용하고 Windows stderr를
원본 파일로 수집해 PowerShell의 CLIXML 해석 오류가 실제 실패 출력을 가리지 않게 합니다.

`lifecycle/windows-window-menu.test.ts`는 실제 HMENU의 창별 소유, 중첩 선택, 다른 트리 선택 거부,
동적 교체, 콘텐츠 크기와 창 파괴 전 분리를 검사한다. 시스템 및 사용자 정의 타이틀바에서
`skipTaskbar` 변경 뒤 단일 행과 여러 행 메뉴의 콘텐츠 크기가 보존되는지도 검사한다.
실제 UI Worker fixture는 요청 취소, 컨텍스트 폐기, 세션 실패와 종료 패킷으로
TrackPopupMenuEx 모달 루프를 끝내고 핸들을 해제한다. 메뉴 막대 진입 전 종료 경합도 포함한다.
사용자 포인터 메뉴 선택, 물리 키보드 탐색과 혼합 DPI 검증을 대신하지 않는다.
같은 파일은 auto-hide 메뉴바도 검사한다. 창 프로시저로 보낸 Alt 키 메시지가 HMENU를 연결하고 떼는지,
Alt와 다른 키의 조합과 Esc, 비활성화, 항목 실행, 메뉴 모드 종료, 메뉴 교체를 다룬다.
`lifecycle/windows-menu-auto-hide.ts`는 실제 WebView2 페이지를 클릭해 활성화한 뒤 SendInput으로 보낸 Alt와 Esc
키가 컨트롤러 accelerator 이벤트로 도착해 메뉴바를 붙이고 떼는지 검사한다. 클릭 시도마다 클릭 지점의 창 클래스와
클릭 전후 포그라운드 상태를 로그로 남기고, 페이지가 일반 키를 받고 그 키가 메뉴바를 바꾸지 않는지 먼저 확인한다. 입력 데스크톱이 필요하다. 창 틀에서 Alt 뒤에 Windows가 여는 메뉴 모드의 실제 동작은 검증하지 않는다.

`api/dialog.test.ts`는 실제 작업 정의로 입력, 개별 권한, 정확한 창 출처, 사용자 취소와
호출 실패, 정리를 검사한다. 이후 tick에서 Close가 수락되면 앞선 Close 실패보다 우선해
취소로 처리하는지도 검사한다. `lifecycle/windows-dialog.test.ts`는 실제 UI STA와 COM 파일
대화상자에서 파일, 폴더와 저장 경로, 네이티브 OK/Cancel 명령, 직렬 실행, abort와 shutdown을
검사한다. 메시지 대화상자는 abort 뒤 복구, 취소 버튼이 없을 때 무시되는 IDCANCEL, 주입한
Escape와 Enter 키 메시지도 검사하며 `host:windows`에 포함한다. 물리 입력과 overwrite UI, 다중 선택 UI 및 실제 소유 창
파괴는 별도 검증이다. `worker-packets.test.ts`는 검증한 모달 제어 패킷의 의도 관측이 즉시
실행되고 일반 dispatch와 자원 변경은 Promise 작업으로 지연되는지 검사한다.

`lifecycle/appearance-controller.test.ts`는 Windows 프레임의 앱 기본값, 창 override, 고대비 우선,
OS snapshot 중복 제거, 조회와 적용 오류 복구, 구독 해제 및 HWND 수명 분리를 검사합니다.
`lifecycle/windows-appearance.test.ts`는 실제 DWM 속성 readback으로 두 HWND의 독립 설정,
기본 system 선호와 정리를 검사합니다. 사용자 설정은 변경하지 않으며 실제 테마 전환과
고대비 렌더링의 시각 검증을 대신하지 않습니다.

`api/notification-toast.test.ts`는 toast 입력, XML escape, 작업별 권한, 이벤트 수신 권한,
교체와 지연 callback 차단, 64개 소유권 상한과 실패 후 정리를 검사한다. 격리된 FFI
fixture는 실제 JSCallback vtable로 Invoke와 지연 Release를 실행한다.
`lifecycle/windows-toast.test.ts`는 실제 Windows UUID 바로가기와 popup/소리 억제 알림으로
Show, XML, 교체와 개별 clear 및 종료 후 history 제거를 검사한다. 별도 STA/MTA 검사는
실제 COM marshaling, callback 실행 스레드와 지연 Release를 확인한다. `host:windows`에
포함하며 실제 사용자 클릭, popup 렌더링과 cold-start activation 검증은 아니다.

`lifecycle/windows-aspect-ratio.test.ts`는 `WM_SIZING` 사각형의 비율 보정 계산을 검사합니다.
Linux에서도 실행하는 순수 계산은 가장자리별 기준 축과 고정 모서리, 프레임 제외, DPI 변환한 크기 제약,
시스템 추적 크기와의 교차 및 정수 반올림 경계를 확인합니다. 실제 HWND 검사는 Windows에서만 실행하며
`host:windows`가 별도 프로세스로 돌립니다. 합성 `WM_SIZING`을 `SendMessageW`로 보내 8개 가장자리의 보정,
설정 시 현재 크기 불변, 크기 제약과 시스템 최대 크기 처리, `null` 해제 뒤 사각형 보존을 확인합니다.
실제 마우스 드래그, 혼합 DPI와 다중 모니터는 검사하지 않습니다.

`lifecycle/windows-resizable-maximize.test.ts`는 `resizable: false` 창(`WS_THICKFRAME` 없음)을 실제 HWND로
검사합니다. 크기 조절 가능했을 때의 가장자리 hit(`HTLEFT`)가 사라지는지, 앱의 시스템 명령 정책이 `SC_SIZE`를 무시해 크기가 바뀌지 않는지,
`maximizable` 설정에 따라 `SC_MAXIMIZE`가 동작하거나 무시되고 `SC_RESTORE`가 원래 bounds로 되돌리는지,
프로그램 호출 `maximize`가 설정과 무관하게 동작하는지 확인합니다. Snap(Win+방향키, 가장자리 끌기)은
셸 기능이라 검사하지 않습니다. `host:windows`가 별도 프로세스로 돌립니다.

`lifecycle/windows-display.test.ts`는 기본 style 보존과 실제 Windows의 custom caption,
네이티브 resize hit test, topmost/tool-window flag, content 크기와 전체화면 복원을
검사합니다. 작업 표시줄 attention 요청이 창을 활성화하거나 표시하지 않는지,
소멸한 창을 거부하는지도 실제 HWND로 확인합니다. 잘못된 FLASHWINFO가 last-error로 보고되는지
검사하고, 작업 표시줄 shell이 있으면 HSHELL_FLASH 알림이 도착하는지도 확인합니다.
콘텐츠 보호는 생성 시 적용과 런타임 전환 뒤의 display affinity를 독립적인 `GetWindowDisplayAffinity`
호출로 확인합니다. `lifecycle/macos-bun.test.ts`는 macOS가 `contentProtection` 선언을 받아들이는지 검사하고,
실제 `sharingType` 동작은 macOS 네이티브 실행의 `lifecycle/macos-window-api.ts`가 확인합니다.
`lifecycle/windows-webview-titlebar.ts`는 실제 WebView2의 Settings9 설정, CSS drag/no-drag
문서와 탐색 후 재구성, 전체화면 복원, 미지원 COM 인터페이스 및 자원 정리를 검사합니다.
같은 문서에서 DevTools 프로토콜의 `Accessibility.getFullAXTree`로 drag 영역 안 버튼이 접근 가능한
이름의 button 노드로 남는지, 프로토콜 키 이벤트(Tab, Enter, Space)가 포커스를 그 버튼으로 옮기고
활성화한 뒤 Tab으로 벗어나는지 확인합니다. 키 이벤트는 렌더러에 직접 넣고 포커스 에뮬레이션을 켜므로
호스트 창의 키 입력 라우팅과 WebView 포커스 전달은 이 검사의 범위 밖입니다.
Windows native 실행기에 포함하며 결과는 `build/windows-webview-titlebar-results.json`에 기록합니다.
물리 마우스 드래그, 우클릭 메뉴 조작, 다중 모니터 DPI 이동과 UI Automation 클라이언트(screen reader)
연결 검증은 별도입니다.

`cli/measure-baseline.test.ts`는 `scripts/measure-baseline.ts`의 측정 정의를 가짜 실행기로 검사합니다.
중앙값, 최소, 최대 요약, 프로세스 트리 합산(재사용된 pid 포함), PowerShell 프로세스 표 해석,
메모리 표본 뒤에만 probe를 풀어 주는 순서, 응답이 없거나 결과가 잘못되었을 때와 실행 파일이 표에 없을 때
앱을 반드시 종료하는지를 Linux에서 확인합니다. `lifecycle/windows-baseline.ts`는 기본 템플릿을 실제로
빌드해 5회 실행하고 시작 시간, 유휴 working set, 패키지 크기, 명령 왕복 지연을
`build/windows-baseline-results.json`에 기록합니다. 값은 기록만 하며 통과 기준으로 쓰지 않습니다.
Windows native 실행기에 포함하고, 결과 파일은 `windows-native-diagnostics` 아티팩트에 올라갑니다.

`api/window-input-events.test.ts`는 WM_APPCOMMAND의 명령 코드와 장치 비트 분리, 게시하지 않는 코드, 이름 목록의
도달 가능성, 부호 있는 화면 좌표와 키보드 호출(-1) 처리, 시스템 메뉴 영역 판별 및 두 이벤트의 스키마를 확인한다.
`lifecycle/windows-window-input-events.ts`는 실제 WebView2 문서가 구독한 상태에서 최상위 HWND에 합성한
WM_APPCOMMAND와 제목 표시줄 WM_CONTEXTMENU의 전달, 알 수 없는 코드, 클라이언트 영역, 키보드 호출과
게시되지 않는 것을 확인한다. Windows native 실행기에 포함한다. 최상위 창이 아닌 창을 가리키는 메뉴 메시지는 합성 시험을 두지 않았다.
실제 마우스 확장 버튼과 미디어 키가 WebView2 위에서 최상위 창까지 올라오는지, 사용자 정의 제목 표시줄의
오른쪽 클릭이 도착하는지는 합성 메시지로 확인할 수 없어 별도 GUI 확인이 필요하다.

`api/window-document-title.test.ts`는 `windows.documentTitleChanged`의 스키마(필수 필드, 1024 초과, 추가 필드)와 1024 UTF-16 단위 제한(서로게이트 쌍이 경계에 걸리면 통째로 제외)을 확인한다.
`api/window-audio-change.test.ts`는 `windows.waitForAudioChange`의 결과 스키마, 같은 상태를 다시 전달하지 않는 필터, 순서 번호와 커서 재개, 지원하지 않는 플랫폼의 `UNSUPPORTED`를 확인한다.
`lifecycle/windows-webview-audio.ts`는 실제 WebView2에서 음소거를 바꿀 때 변경 이벤트가 그 상태로 한 번씩 도착하는지도 확인한다.
`api/window-process-failure.test.ts`는 `windows.waitForProcessFailure`의 WebView2 종류 번호 대응(모르는 값은 `unknown-exited`), 결과 스키마, 순서 번호와 커서 재개, 지원하지 않는 플랫폼의 `UNSUPPORTED`를 확인한다.
`lifecycle/windows-process-failure.ts`는 실제 WebView2 렌더러를 강제 종료해 백엔드가 `renderer-exited`와 `reload`를 받고 뷰가 같은 창에서 다시 로드되는지 확인한다. Windows native 실행기에 포함한다.
`lifecycle/windows-document-title.ts`는 실제 WebView2 문서가 `document.title`을 바꿀 때마다 이벤트가 순서대로 도착하는지(한글, 이모지 경계, 1024 초과 제목 포함)와 네이티브 캡션이 그대로인지 확인한다. Windows native 실행기에 포함한다. 첫 로드의 제목은 구독 전에 도착할 수 있어 검증 대상에서 제외한다.

`lifecycle/windows-hidden-paint.ts`는 `visible: false`로 만든 창의 실제 WebView2 문서를 `windows.show()` 전후로 관찰한다. 숨김 상태에서 페이지 타이머가 돌고 `requestAnimationFrame`이 전달되며 `first-paint` 항목이 있는지, 네이티브 `isVisible`이 거짓이고 문서 준비가 `ready`인지 확인하고, 표시 뒤에는 `document.visibilityState`가 `visible`이고 프레임이 전달되는지 확인한다. 숨김 상태의 `visibilityState`는 단언하지 않고 보고서(`build/windows-hidden-paint/report.json`)와 로그에 남긴다. 실패해도 그 시점까지의 값은 보고서에 남는다.

`api/window-thumbnail-toolbar.test.ts`는 썸네일 툴바 입력 스키마(개수, id, 툴팁 길이, 플래그, 잘못된 ICO), 클릭 이벤트 스키마, 어댑터 전달과 macOS의 `UNSUPPORTED`, 호스트의 재검증, 7칸 구성과 `WM_COMMAND` 칸 번호의 id 변환(비활성, 숨김, 미등록, 알림 코드 불일치 제외)을 확인한다.
`lifecycle/windows-bun-window-api.ts`는 실제 `ITaskbarList3`로 개수를 바꾸는 연속 호출(0, 3, 1, 7, 0개)이 오류 없이 끝나는 것과 잘못된 ICO, 중복 id 거절을 확인하고(어느 vtable 슬롯을 불렀는지는 관찰하지 않는다), `lifecycle/windows-window-input-events.ts`는 최상위 HWND에 합성한 `THBN_CLICKED` `WM_COMMAND`가 등록한 버튼 id로만 전달되는지(비활성, 숨김, 미등록, 범위 밖, 메뉴 명령, 툴바를 줄이거나 비운 뒤의 이전 칸 제외)와 잘못된 ICO를 거절한 뒤에도 기존 칸이 같은 id로 눌리는 것을 확인한다.
사람이 작업 표시줄 썸네일에서 누르는 동작, Explorer 실제 재시작 뒤 재적용, 썸네일에 그려지는 모양은 자동 검증하지 않는다.

`lifecycle/windows-templates.ts`는 패키징한 CLI로 UI 템플릿(vanilla, vite, react, vue, svelte)을 하나씩
생성하고, 템플릿이 설정한 웹 빌드, 검증 도구의 doctor와 호스트 프로토콜 백엔드 실행, 웹 개발 서버 응답
(vanilla는 개발 서버가 없어 제외)을 차례로 확인합니다. 웹 빌드가 실패하면 그 템플릿의 나머지 단계는 건너뜁니다.
개발 서버는 이 파일이 직접 띄우고 프로세스 트리째 종료하며, 프로젝트 삭제 실패도 단계로 기록합니다.
한 단계가 실패해도 나머지 템플릿을 계속 돌리고 마지막에 실패 단계를 모아 실패하며, 단계별 결과는
`build/windows-templates-results.json`에 기록합니다. 네이티브 창과 WebView2 실행, HMR 편집 반영, 설치 파일
생성은 확인하지 않습니다. Windows native 실행기에 포함합니다.

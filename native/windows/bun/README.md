# Windows Bun 호스트

창 준비는 HWND 생성, 현재 최상위 문서의 NavigationCompleted와 SDK 협상 확인을 구분한다.
`window-readiness.ts`가 기존 windowId와 ViewBoundary 세대별 상태를 소유하고 UI Worker가
기존 native-event 경로로 권한이 있는 구독자에게 보낸다. 최초 네이티브 완료는 WebView2 생성 전에 발행한다.
`visible: false`와 `showWhenReady`는 HWND를 처음부터 숨겨서 만들며 준비 중 활성화하지 않는다.
공개 계약과 실패, 취소 및 기한은 [창 API](../../../docs/site/src/content/docs/reference/host/windows.mdx)를 따른다.

번들 Bun 1.4.2가 앱 진입점이다. 메인은 기존 `createCore`와 앱을 실행하고,
UI Worker 하나가 STA에서 `bun:ffi`로 Win32 창과 WebView2 COM을 직접 소유한다.
I/O Worker 하나가 승인된 Host API를 검사한 파일 핸들로 실행한다.
앱 호스트와 백엔드 사이의 프로세스 IPC는 없으며 WebView2 자식 프로세스는 유지된다.

## 파일별 책임

`boot.ts`는 실행 인자, 단일 인스턴스 확보와 앱 import를 담당하고,
`config.ts`는 패키지 설정과 정책을 검증하고 앱 데이터 경로를 결정한다.
검증한 앱 ID와 재실행 경로, 개발 모드의 절대 부팅 인자를 I/O Worker에 전달한다.
로그인 자동 실행 플러그인은 이 호스트 선택 경로를 사용하며 현재 개발 서버 주소와
DevTools 옵션은 영속 등록에 포함하지 않는다.
`package.ts`는 회귀 패키지를 빌드하고, `tests/lifecycle/run-native.ts`는 준비, 빌드와 테스트 실행을 조정한다.

`win32-bindings.ts`는 호스트가 여는 DLL 함수 바인딩을 제공한다. 공통 Win64 시그니처와
FFI 버퍼 보조 함수는 `@bunaway/plugin/win32`에서 가져오고, `win32-constants.ts`는 창 메시지,
시스템 명령, 표시 상태와 구조체 크기 같은 Win32 상수를 모아 둔다. `win32.ts`의 `Windows`는
창 클래스, HWND, 아이콘, 전체 화면 상태와 메시지 처리를 소유한다. 창별 작업 표시줄 설정
(진행률, 썸네일 클립과 툴팁, 오버레이 아이콘의 HICON 소유)은 `window-taskbar.ts`의
`WindowTaskbar`가 소유하며 `Windows`는 창이 살아 있는지만 확인하고 위임한다.
`taskbar-progress.ts`는 HWND별 작업 표시줄 버튼 준비와 마지막 성공 설정을 관리한다.
등록한 `TaskbarButtonCreated` 메시지 이후에만 설정을 적용하며 버튼 재생성 때 복원한다.
복원 실패는 진단으로 기록하며 이후 명시적 호출로 다시 적용할 수 있다.
`taskbar.ts`는 최초 호출에 ITaskbarList3를 만들고 독립적인 COM 바인딩을 소유한다.
WebView의 마지막 창 정리와 캐시 해제가 작업 표시줄 바인딩의 수명을 바꾸지 않는다.
호스트 종료 때 STA 해제 전에 COM reference와 바인딩 및 DLL 핸들을 회수한다.
`getBounds`는 content, outer와 일반 상태 복원용 normal 영역을 화면 물리 픽셀로 조회한다.
normal의 WINDOWPLACEMENT 작업 영역 좌표는 화면 좌표로 보정한다. 전체화면 중 조회는
저장된 placement를 복사해 현재 DPI와 크기 제약을 적용하며 복원 상태를 변경하지 않는다.
일반 상태의 생성과 이동 때 확인한 모니터를 창별로 보존한다. 작업 영역 좌표로
모니터를 다시 선택하지 않으므로 두 모니터 경계에 걸친 창도 올바른 화면 위치를 반환한다.
최소화, 최대화와 전체화면에서는 이 정보를 유지하고 창을 파괴할 때 함께 정리한다.
전체화면이 아닌 창에서 모니터 분리로 보존한 핸들이 무효가 되면 디스플레이 변경 메시지와 조회 시 normal placement에 가장 가까운 유효 모니터를 다시 선택한다. 분리 중 조회하지 않아도 재연결 후 Windows가 옮긴 복원 위치를 유지한다. 일시적으로 유효 모니터를 조회할 수 없으면 캐시를 유지하고 다음 메시지나 조회에서 재시도하며, 공개 조회 실패는 INTERNAL로 반환한다.
전체화면의 대체 모니터는 해당 조회에만 사용한다. 핸들이 무효이면 보존한 원래 모니터의 화면 영역으로 유효 모니터를 찾으므로 같은 위치에 재연결된 모니터의 핸들이 바뀌어도 그 모니터의 작업 영역 오프셋을 사용한다.
최대화한 창을 다른 모니터로 옮기거나 그곳에서 전체화면에 진입해도 원래 복원 위치의 오프셋을 사용한다.
`ui.ts`는 `NativeWindow.getBounds`와 `getDpi`를 연결하고 창 플러그인이 공개 단위 변환과
반올림, 입력 및 대상 창 권한을 검사한다.
`webview-version.ts`는 시작 때 WebView2Loader로 설치된 런타임 버전을 한 번 조회해 `ctx.app.runtime.webview`에 전달하며,
`wide-string.ts`는 이 조회에서 쓰는 NUL 종료 UTF-16 문자열 읽기를 제공한다. `webview-version.ts`는 조회에 실패하면 예외를 던지고, 기록과 `null` 처리는 아래 검사와 `entry.ts`가 한다.
`webview-version-check.ts`는 이 버전을 최소 런타임 버전과 비교하고 결과(`webview-version-unavailable`, `webview-version-too-old`, `webview-version-unparsable` 항목과 시작 실패)를 만든다.
`entry.ts`는 Worker를 시작하기 전에 이 검사를 하고 항목을 기록한 뒤, 최소보다 낮으면 시작을 실패시키며 해석할 수 없는 문자열은 기록만 하고 계속한다.
`com.ts`는 COM 참조와 콜백을, `webview.ts`는 WebView 생성과 종료를 관리한다.
`ui.ts`가 이 자원들의 초기화와 정리 순서를 조정한다. DLL은 창과 COM 정리가 끝난 뒤 닫는다.
UI 스레드의 수명주기(시작 요청, 시작 탐색, 대기 중인 quit 요청, 종료 확정, 정지)는
`ui-phase.ts`의 `UiPhase` 값 하나이며 `advance`만 바꾼다. 허용된 전이는
`tests/lifecycle/windows-ui-phase.test.ts`가 표로 단정한다.

인쇄 UI 작업은 `NativeWindow.showPrintUI`로 같은 UI 스레드의 ICoreWebView2_16
ShowPrintUI를 호출한다. optional QueryInterface는 E_NOINTERFACE만 미지원으로 반환하며
다른 HRESULT 실패는 기존 오류 경로를 유지한다. 현재 작업은 browser 또는 system UI의
시작 요청만 제공하고 프린터 선택과 실제 제출, 인쇄 완료는 사용자와 브라우저가 소유한다.

DownloadCleanupError는 해당 창의 취소 실패를 나타내며 UI pump의 전체 실패로 전달하지 않는다.
닫힌 소유자의 controller와 다운로드 참조를 유지하고 50 ms 간격으로 기존 35초 cleanup
예산 안에서 재시도한다. 다른 창의 메시지와 정리는 계속 처리한다. 기한이 끝나면 소유자를
정리 대기 상태로 유지하고 진단을 한 번 남긴다. 관찰한 broker 종료나 명시적 앱 종료는
참조를 안전하게 해제하거나 재시도하는 별도 경로이며 살아 있는 공유 broker를 종료하지 않는다.

`webview-downloads.ts`는 고정 SDK 1.0.4129.50의 ICoreWebView2_4 DownloadStarting과
DownloadOperation, Deferral을 소유한다. `downloads.ts`는 OS 자원 없는 승인과 수명 규칙을
관리한다. 기본 거부를 먼저 설정하고 deferral을 얻으며, 승인 결과와 무관하게 deferral을
완료하고 args 및 operation 참조를 정리한다. pending 승인의 기한과 기록 상한을 적용하고
새 탐색은 pending만, 창 종료는 승인된 작업도 취소한다. 이벤트 callback은 구독을 해제한
뒤 WebView의 기존 STA quiescence와 프로세스 정리 단계까지 유지한다.
관찰한 browser 프로세스 장애에서는 pending과 활성 COM 참조를 해제하고 완료나 취소를
죽은 broker에 보내지 않는다. 이 경우의 구독 해제 ERROR_INVALID_STATE만 수용하며
살아 있는 broker의 같은 오류와 다른 HRESULT는 기존 실패 경로를 유지한다.
파일 쓰기와 기본 저장 경로는 브라우저가 소유한다. 현재 API에는 임의 경로 입력이나
사용자 정의 스트림 출력이 없으며 backend 출처 검사로 renderer의 파일 접근을 확대하지 않는다.


창 플러그인의 기본 WebView 제어는 `NativeWindow.webview`를 통해 같은 UI 스레드의
controller와 WebView를 사용한다. 공개 URL 탐색도 기존 origin 검사와 NavigationStarting의
세션 폐기를 유지한다. loading은 현재 탐색 ID의 시작 및 완료에서 갱신하며 다른 탐색의
늦은 완료는 무시한다. history, reload와 stop은 ICoreWebView2의 기본 메서드,
zoom은 ICoreWebView2Controller의 double ABI를 사용한다. COM 슬롯은
고정 WebView2 SDK 1.0.4129.50의 WebView2.h를 따른다. DevTools 설정은 생성 시 호스트가
선택하며 작업 호출이 설정을 변경하지 않는다.
WebView audio는 ICoreWebView2_8의 IsMuted와 IsDocumentPlayingAudio를 같은 UI STA에서
조회하고 음소거를 변경한다. 각 호출이 획득한 COM interface는 성공과 실패 모두에서
해제한다. controller의 음소거는 문서 탐색을 유지하고 재생 상태는 물리 출력과 구분한다.
자동 재생과 장치 권한 정책은 기존 동작을 유지하며 상태 이벤트는 아직 제공하지 않는다.

창 플러그인을 등록하면 `Windows.observe`가 창별 상태와 물리 outer bounds의 변경을
비교한다. 활성화 관찰은 `WM_ACTIVATE` 뒤에 게시한 창 메시지에서 전경 HWND를 조회한다.
`WM_ENTERSIZEMOVE`와 `WM_EXITSIZEMOVE`는 시작과 최종 geometry를 비교해 별도 revision의
`moved`, `resized`를 발행한다. 순서와 snapshot 복구는 중간 move/resize와 같은 경로를 따른다.
동기 활성화 콜백이 끝나기 전에 이전 전경 HWND를 읽어 전환을 놓치는 것을 방지한다.
`window-events.ts`는 변경 이름과 순서를 결정하며 `ui.ts`는 현재 문서의
구독 관심과 route를 확인해 `native-event` 패킷을 보낸다. 메인은 동일한 route의
활성 Core 세션에 `emitNative`로 전달한다. observer는 SDK 구독 수와 관계없이 창별
하나이며 HWND 파괴 전에 제거한다. 전송 용량과 복구는
[공개 창 이벤트 계약](../../../docs/site/src/content/docs/reference/host/windows.mdx)을 따른다.

트레이 구현과 전용 상수는 `plugins/tray/src/platforms/windows-tray.ts`, Job 객체 상수는 `job.ts`에 둔다. 개발 CLI와 공유하는
종료 메시지와 창 클래스 접두어는 `runtime-bun/windows-control`의 단일 정의를 사용한다.
Worker 패킷은 `runtime-bun/worker-channel`의 공통 구현을 사용한다.
Win32 콜백에서는 `Channel.poll()`로 최대 128개의 Worker 메시지를 처리한다.
이동과 크기 변경의 네이티브 모달 루프가 Bun 이벤트 루프를 막아도 수신 확인과
서버 전달이 진행되며 중첩 poll은 무시한다. 자원을 바꿀 수 있는 나머지 패킷은
Bun 이벤트 루프가 재개된 뒤 처리해 Win32와 COM 콜백 안에서 재진입하지 않는다.
동기 전달은 즉시 수신 확인하고,
비동기 어댑터 작업은 완료 후 확인하는 기존 계약을 유지한다.
`channel.ts`는 이를 재노출하고 Windows UI 설정 타입을 정의하며 Win32 창 제어 값을 소유하지 않는다.
서버 메시지는 공유 FIFO 대기열에서 데이터 수신 확인을 기다린다. 미확인 데이터는
128개, 대기 서버 메시지는 16,384개로 제한한다. 이미 승인한 Host 작업의 결과도
같은 FIFO에서 전달하며 별도 대기 용량 128개를 유지한다. 대기열이 남아 있으면 새 Host API
요청은 BUSY로 거부한다. 대기열 포화는 해당 세션의 요청과 구독에 BUSY를 전달하고
컨텍스트를 정리한다. 취소, 세션 실패 통지와 종료 메시지는 별도 용량을 사용한다.
뷰 ID를 프로필 디렉터리 이름으로 바꾸는 순수 규칙은 `view-profile.ts`에 두어
테스트도 네이티브 DLL을 로드하지 않고 같은 매핑을 사용한다.

## 실행

```powershell
# 저장소: 의존성 검증, 패키지 빌드, 실제 GUI/보안/수명/CLI 회귀
mise run host:windows
# 의존성만 확인 (다운로드/추출하지 않음)
bun packages/cli/src/native-build.ts --target windows-x64 --verify-only
```

개발/빌드에는 Windows 기본 제공 tar와 고정 Bun이 필요하다.
실행에는 WebView2 Evergreen이 필요하다.
MSVC, CMake, Ninja와 사용자 C/C++ 또는 Rust DLL은 필요 없다. Microsoft의 공식
`WebView2Loader.dll`과 시스템 DLL은 사용한다. 생성 앱은 `bunaway.json`의
`build.app`에 **default export AppDefinition** 파일을 지정한다.
프레임워크가 이 앱 정의를 가져와 부팅하며 개발자가 별도 프로세스 진입점을 작성하지 않는다.

CLI 생성 앱의 `bun run build` 결과는 `dist/windows-x64/<appId>.exe`로 실행한다.
`app.executableName`은 실행 파일 이름, `app.icon`은 프로젝트 기준 ICO 경로다.
배포 빌드는 Bun, 앱/코어, UI/IO Worker, 웹 자산, 설정과 정책을 EXE에 내장한다.
첫 번들의 `asset` 출력도 컴파일 입력으로 전달한다. 앱과 Worker의 파일 import는
번들 후 경로 문자열이 되므로 두 번째 컴파일에서 자동으로 발견되지 않는다.
출력 확장자가 `.js`여도 파일 자산이면 내장한다.
앱 EXE는 콘솔 없이 시작하며 EXE 리소스의 아이콘을 창과 트레이에도 적용한다.
초기화 실패나 앱을 종료시키는 호스트 오류는 대화상자로 알리고 `logs/startup-error.log`에 기록한다.
앱 설정 확인 전의 로그는 확장자를 제외한 실행 파일 이름의 데이터 디렉터리에 기록한다.
데이터 경로를 찾거나 로그를 쓰지 못해도 오류 대화상자는 표시한다.
명령 호출 오류는 SDK 호출 결과로 전달하며 이 대화상자를 표시하지 않는다.
네이티브 크래시나 강제 종료까지 오류 대화상자를 보장하지는 않는다.
Microsoft WebView2Loader.dll과 라이선스는 EXE 옆에 배포한다.
웹 자산은 WebResourceRequested에서 내장 파일을 IStream 응답으로 제공하며 기존 HTTPS 출처를 유지한다.
정상 MIME, GET/HEAD, 단일 byte range와 404를 처리하고 설정이나 호스트 JS는 웹 경로로 제공하지 않는다.
개발 모드는 외부 JS와 폴더 매핑을 사용하며 CLI가 Bun을 직접 실행한다.
의존성 핀은 빌드 시, 배포 파일 해시는 패키징 전에 확인한다. 앱 시작 시 manifest/전체 해시 검사는 없다.
서명한 앱 EXE의 해시는 host.packagedSha256에 기록하며 서명 뒤 실행 파일을 패치하지 않는다.
win-store-msix는 패키지 활성화와 앱 데이터 동작을 검증하기 전까지 지원하지 않는다.
[패키징 안내](../../../packages/packaging/README.md).

같은 앱 데이터 디렉터리는 한 프로세스만 사용한다. 앱 import 전에 `host.lock`을
Windows 파일 핸들로 독점한다. 두 번째 실행은 기존 앱에 인자와 작업 디렉터리를
named pipe로 전달하고 종료한다. 앱 import, Worker, WebView 생성은 소유자만 수행한다.
기존 WebView 프로필과
저장 데이터는 유지한다. 잠금은 정상/강제 종료 때 OS가 해제하므로 남은 파일을 삭제할 필요가 없다.

STA의 bounded PeekMessage pump는 64개 처리 후 Bun에 제어를 돌려준다. OS 모달 중에는
UI Worker 메시지가 지연될 수 있으나 메인의 타이머, Promise, 네트워크는 계속 진행한다.
COM 콜백은 같은 OS 스레드에서 동기 HRESULT를 반환한다. `threadsafe: true`는 쓰지 않는다.
이벤트 분리, Close, HWND 파괴, 실제 프로세스 종료, COM 참조 0, 콜백 정지 이후 해제한다.
정상 WebView 정리는 30초, UI/메인 종료는 35/40초 제한을 갖고 초과는 실패다.

[실행 결과와 제약](../../../docs/architecture/windows-bun-results.md),
[실행 구조 ADR](../../../docs/decisions/0006-windows-bun-ui-worker.md).
기존 Windows C++ 호스트, probe, CMake와 전용 테스트는 삭제했다. macOS와 공유하는
앱, 화면 회귀 데이터는 `tests/fixtures/desktop/host/`에 있다.

명령 핸들러의 예기치 않은 예외는 stderr와 앱 로그의 `command-failed`에 명령 이름, 원래 메시지와 스택을 기록한다. WebView 응답에는 내부 오류를 넣지 않는다. 진단 기록 실패는 명령 응답에 영향을 주지 않는다.

CLI의 Windows 개발 산출물은 해시 inventory에 포함된 `assets/manifest.json`의 `app.developmentTools: true`와
`--devtools` 실행 인자를 모두 요구한다. 확인한 값은 UI Worker에 전달해 WebView2의
AreDevToolsEnabled와 AreBrowserAcceleratorKeysEnabled를 활성화한다. 일반 빌드는 둘 다 끈다.
F12 또는 Ctrl+Shift+I로 DevTools를 연다. 개발 모드는 서버 URL 설정이 없는 로컬 UI에도 적용된다.
백엔드 inspector는 `bunaway dev --inspect[=<port>]`로 선택하며 메인 Bun에만 실행 옵션을 추가한다.
개발 UI, 앱, 호스트와 Worker 번들에는 inline 소스맵을 생성한다. 자세한 사용법은
[디버깅 가이드](../../../docs/site/src/content/docs/guides/debugging.mdx)를 따른다.

CLI가 연결한 개발 IPC는 `app-reload.ts`가 소유하며 검증한 세대 디렉터리의 앱 번들을
로드한다. `development-app.ts`는 호환되는 앱 명령 구현만 교체하고 코어와 StateStore,
세션, 구독, 창과 Worker는 유지한다. 기존 요청은 기존 구현으로 완료한다.
SDK는 시작 시의 공통 번들을 재사용하며 계약, 플러그인 객체, 상태 초기값이나 실행 설정
변경은 전체 재시작한다. 일반 빌드는 교체 IPC를 연결하지 않는다.
공유 플러그인 모듈은 ES modules와 CommonJS의 default export와 이름 있는 export를 유지한다.

실패한 로그 기록은 다시 시도하지 않는다. 쓰기 실패는 해당 호출에만 전달하며 이후 기록은 계속 처리한다. drain()은 대기 중인 기록 처리가 끝날 때까지 기다린다.

## Public window operations

The CLI accepts one window definition in `app` and exactly one policy view.
상태 변경 `minimize`, `maximize`, `unmaximize`, `restore`, `toggleMaximize`와
조회 `isMinimized`, `isMaximized`, `isFullscreen`, `isVisible`, `isFocused`도 선택 창 플러그인이
제공한다. UI Worker의 실제 HWND를 사용하며 조회도 해당 operation 이름을 허용해야 한다.
최소화 전 최대화 복원, 숨긴 창 표시와 전체화면 중 변경 거부는
[공개 창 계약](../../../docs/site/src/content/docs/reference/host/windows.mdx)을 따른다.
`setFullscreenable`/`isFullscreenable`은 HWND별로 전체화면 진입 허용(기본 true)을 저장하고 파괴 시 지운다.
`win32.ts`의 `setFullscreen`이 진입을 `INVALID_ARGUMENT`로 거부하므로 어느 경로로 호출해도 우회되지 않는다.
이미 전체화면인 창은 유지되며 해제는 항상 허용한다.
`setOpacity`/`getOpacity`는 별도 상태 없이 OS의 layered window alpha를 읽고 쓴다. 1 미만일 때만
`WS_EX_LAYERED`를 켜고 `SetLayeredWindowAttributes(LWA_ALPHA)`로 적용하며 1이면 (click-through 중이 아닐 때) 스타일을 제거한다.
`window-input-events.ts`는 창 프로시저가 받은 `WM_APPCOMMAND`(명령 코드의 장치 비트를 떼어 고정 이름으로 바꾸고 목록에 없는 코드는 버린다)와 `WM_CONTEXTMENU`(키보드 호출 -1 제외)를 해석하고, `ui.ts`가 최상위 창 자신이 받은 메시지에 한해 `WM_NCHITTEST`가 `HTCAPTION`이나 `HTSYSMENU`일 때만 `windows.systemContextMenu`로 보낸다. 두 이벤트 모두 `DefWindowProc`의 기본 처리를 막지 않는다.
`thumbnail-toolbar.ts`는 썸네일 툴바의 순수 규칙을 맡는다. 버튼 입력을 다시 검증하고, 추가 호출이 창당 한 번이라 항상 7칸(쓰지 않는 칸은 `THBF_HIDDEN`)을 채워 `ThumbBarAddButtons`와 이후 `ThumbBarUpdateButtons`가 같은 칸 배열을 쓰게 하며, `WM_COMMAND`의 `HIWORD`가 `THBN_CLICKED`일 때만 칸 번호를 앱의 버튼 id로 바꾼다(숨김, 비활성, `noninteractive` 칸과 등록하지 않은 칸은 버린다). `window-taskbar.ts`가 HICON을 소유해 새 아이콘을 모두 만들고 셸이 받아들인 뒤에만 이전 아이콘을 해제하며, `TaskbarButtonCreated`에서는 추가 여부를 지우고 마지막 성공 목록을 다시 추가한다. `ui.ts`는 최상위 창이 받은 `WM_COMMAND`를 `windows.thumbnailToolbarClicked`로 보낸다. 클릭 경로에는 COM 호출이 없다.

`startDragging`/`startResizeDragging`은 `window-drag-input.ts`가 `ReleaseCapture` 뒤 `PostMessageW(WM_NCLBUTTONDOWN)`을 현재 커서 위치와 함께 보내 시스템 이동, 크기 조절 루프로 넘긴다(캡션은 `HTCAPTION`, 방향은 `HTLEFT`…`HTBOTTOMRIGHT`). 기본 버튼 상태는 `GetAsyncKeyState`로 읽고 마우스 버튼 바꿈(`SM_SWAPBUTTON`)이면 오른쪽 키를 본다. 상태 검사와 거부 메시지는 `window-drag.ts`의 순수 함수와 `win32.ts`가 맡고 최소화, 최대화, 전체화면, 이동 불가, 크기 조절 불가, 같은 최소 크기와 최대 크기로 고정된 축이면 `INVALID_ARGUMENT`로 거부한다. 루프는 OS가 소유하므로 취소 API는 없다.
`setHasShadow`/`hasShadow`는 `window-shadow.ts`가 `DwmSetWindowAttribute`로 `DWMWA_NCRENDERING_POLICY`를 쓰고 `DwmGetWindowAttribute`로 `DWMWA_NCRENDERING_ENABLED`를 읽으며(정책 속성은 쓰기 전용) 상태를 따로 두지 않는다. dwmapi는 호출마다 열고 닫는다.
`titlebar: "custom"` 창만 `DWMNCRP_DISABLED`로 그림자를 끄고(`DWMNCRP_USEWINDOWSTYLE`로 복구) 지오메트리는 그대로다. 그림자는 DWM이 GDI 화면 밖에서 합성해 화면 캡처로 보이지 않으므로 테스트는 DWM이 돌려주는 상태를 확인한다. 네이티브 제목 표시줄 창은 `hasShadow`가 항상 true이며 `setHasShadow(false)`는 `UNSUPPORTED`다.

`setRoundedCorners`/`hasRoundedCorners`는 `window-corners.ts`가 `DwmSetWindowAttribute`로 `DWMWA_WINDOW_CORNER_PREFERENCE`(33)를 쓴다(`true`는 `DWMWCP_DEFAULT`, `false`는 `DWMWCP_DONOTROUND`). DWM이 값을 읽어 주지 않으므로 `win32.ts`가 각지게 요청한 HWND만 집합에 두고(`destroy`에서 삭제) 조회는 그 집합을 본다. Windows 11 미만이 돌려주는 `E_INVALIDARG`는 효과 없음으로 보고 성공으로 처리하며 다른 실패 HRESULT는 던진다. `titlebar: "custom"` 창만 `false`를 받고 네이티브 제목 표시줄 창은 `UNSUPPORTED`다.

`setBackgroundMaterial`/`getBackgroundMaterial`은 `window-backdrop.ts`가 `DwmSetWindowAttribute`로 `DWMWA_SYSTEMBACKDROP_TYPE`(38)을 쓴다(`auto`/`none`/`mica`/`acrylic`/`tabbed`는 0/1/2/3/4). 조회는 Electron에 없는 확장이다. 22621 미만에는 DWM 쪽 값이 없으므로 `win32.ts`가 `auto`가 아닌 HWND만 맵에 두고(`destroy`에서 삭제) 조회는 그 맵을 본다. 빌드가 22621 미만이면 Electron의 사전 버전 검사처럼 DWM 호출을 건너뛰고, 그 이상에서 실패한 HRESULT는 던진다. 빌드 번호는 `window-corners.ts`의 `RtlGetVersion` 읽기를 함께 쓴다.

`backgroundColor`, `setBackgroundColor`/`getBackgroundColor`는 불투명 `#rrggbb`만 받는다. `window-background.ts`가 HWND별 색을 맵에 두고 `WM_ERASEBKGND`에서 `DC_BRUSH` stock 브러시를 `SetDCBrushColor`로 칠하므로 창 클래스 브러시는 그대로이고(`SetClassLongPtrW`는 클래스를 공유하는 모든 창에 영향) 해제할 GDI 객체가 없다. 맵 항목은 `destroy`에서 지운다. WebView2는 컨트롤러 완료 직후 `ICoreWebView2Controller2::put_DefaultBackgroundColor`(vtable 27)로 같은 색을 적용하고, 컨트롤러가 준비되기 전에 들어온 값은 보관했다가 그때 적용한다. 값을 넣은 직후 `get_DefaultBackgroundColor`(vtable 26)로 되읽어 비교하고(컨트롤러는 저장한 값을 그대로 돌려주므로 put/get 슬롯 불일치를 잡을 뿐 바이트 순서 오류는 잡지 못한다. 알파 바이트가 어긋나면 put이 0 또는 255가 아닌 알파를 거부한다), 다르면 실패한다(생성 중이면 창 생성이 실패하고, 실행 중 변경이면 예외가 난다). 되읽기만 실패하면 컨트롤러는 새 색을 가질 수 있으나 기억한 색과 창 색은 이전 값으로 남는다. 테스트는 메모리 DC로 보낸 `WM_ERASEBKGND`가 칠한 픽셀과 창별 격리를 확인하며, WebView2가 실제로 그린 픽셀은 확인하지 않는다.
`setIgnoreMouseEvents`/`isIgnoreMouseEvents`도 상태를 따로 두지 않고 `WS_EX_TRANSPARENT` 스타일을 읽고 쓴다. 켜면 `WS_EX_LAYERED`를
함께 설정(알파 255)하고, 끄면 불투명도가 1일 때만 layered를 제거한다. `setOpacity(1)`도 click-through 중에는 layered를 유지한다.
`startup: false` defers creation until `windows.create`. Window calls execute on
the UI STA through the explicitly installed and registered `@bunaway/plugin-windows`. Each operation checks its own name in the active caller's grants. The I/O Worker
reports registered operations as capabilities. `windows.recreate` reserves the view
until the old WebView and processes finish, then creates a fresh boundary and
WebView using the same profile. This also postpones last-window shutdown.
Retired views release their COM handlers before a replacement is created.

창 아이콘(`setIcon`, `hasCustomIcon`)은 `window-icon.ts`의 `WindowIconSet`이 HWND별 HICON 두 개(`SM_CXSMICON`, `SM_CXICON` 크기)를 소유하고 UI 스레드에서 `WM_SETICON`의 `ICON_SMALL`, `ICON_BIG`으로 지정한다. 두 HICON을 모두 만든 뒤에 창을 바꾸므로 거부된 이미지는 기존 아이콘을 유지하고, 이전 HICON은 새 아이콘을 지정한 뒤에 `DestroyIcon`한다. `null`은 두 값을 `0`으로 지정해 창 클래스 아이콘으로 되돌리고 만든 HICON을 해제하며, 창 파괴(`DestroyWindow` 뒤)와 호스트 종료(`dispose`)에서도 남은 HICON을 해제한다. 아이콘 크기는 설정 시점 DPI로 정하고 DPI 변경 때 다시 만들지 않는다. 테스트는 실제 HWND의 `WM_GETICON` 핸들 변화와 반복 호출 뒤 USER 개체 수를 확인하며 화면에 그려진 아이콘은 확인하지 않는다.

Show, hide, focus, client size, screen position and monitor fullscreen use Win32.
`Windows.setGeometry`는 content/outer 위치와 크기를 물리 픽셀로 적용한다.
일반 상태에서는 `SetWindowPos`, 최소화나 최대화 중에는 일반 복원 영역의
`SetWindowPlacement`를 사용하며 화면 좌표와 대상 모니터 작업 영역 좌표를 변환한다.
지정한 content 크기를 검사하고 제약으로 보정한 뒤 rectangle 경계를 검사하며,
숨김과 활성화 상태를 유지한다. bounds 설정 중에는 중간 이벤트 관찰을 보류하고
완료 후 실제 현재 outer bounds를 관찰한다. 공개 단위와 상태별 계약은
[창 API](../../../docs/site/src/content/docs/reference/host/windows.mdx)를 따른다.
Close confirmation uses a native Yes/No dialog with No selected by default.
WM_CLOSE and WebView close requests defer confirmation outside native callbacks.
Window close operations also honor close-to-tray and last-window quit vetoes.
Recreation bypasses those app quit controls while preserving close confirmation.
신뢰된 백엔드 `destroy`는 별도 권한으로 확인과 종료 취소를 우회한다.
Deferred and recreated windows inherit the verified development DevTools setting.
Shutdown bypasses confirmation.
Browser process failure also closes the affected window without confirmation.
`tests/lifecycle/windows-bun-window-api.ts` is
part of `tests/lifecycle/run-native.ts` and covers native geometry, close refusal and acceptance,
dynamic creation, fresh sessions and self-recreation. It passed in PR #40's
Windows CI run 37574470840. The full native job failed on the shared capability
fixture's old four-operation expectation, which now checks the complete catalog.

앱 정의의 `desktop.onOpen`은 초기 실행과 두 번째 실행의 인자, URL, 파일을 받는다.
`desktop.beforeQuit`는 마지막 창, 트레이, 앱의 종료 요청을 취소할 수 있다.
`desktop.closeBehavior: "hide"`와 `desktop.tray: { tooltip: "Memo" }`를 함께 지정하면
닫기 버튼으로 창을 숨기고 백엔드, WebView, 세션을 유지한다. 트레이 Open 또는
두 번째 실행은 새로 만든 창을 표시하며 Quit은 종료 검사를 거친다. 기본값은 마지막 창 닫기로 종료다.
URL scheme과 파일 확장자의 OS 등록은 제공하지 않으며 실행기에 전달된 인자를 처리한다.
GUI 실행 파일은 `-Wait`, `-- -draft.txt`와 `-Verbose`를 포함한 모든 인자를 그대로 전달한다.
배포 EXE는 인자와 작업 디렉터리를 직접 읽는다. Windows와 호출 셸의 명령줄 길이 제한을 따른다.
개발 CLI의 재시작과 종료는 종료 취소와 숨김을 우회하며 코어, 플러그인 StopHook과 Worker를 정리한다.
`app.startup: false`는 트레이 또는 `closeBehavior: "keep-alive"`를 요구한다.
keep-alive는 창을 실제로 정리한 뒤에도 백엔드를 유지한다. Open과 show는 창이 있으면
복원하고 없으면 새로 만든다. `startup: false`이면 시작할 때 창은 만들지 않는다.
트레이 없는 상주 앱은 숨긴 제어 HWND를 소유해 CLI 종료 메시지를 받고 정상 종료 때 정리한다.
[데스크톱 수명주기 결정](../../../docs/decisions/0013-desktop-lifecycle.md).

## 창 수명

앱은 창 정의 하나를 가진다. UI의 자원 Map, 닫기와 재생성 예약은 하나의 창 수명을 기준으로
관리하고 네이티브 ID는 HWND 수명마다 발급한다. 서버 응답은 인증된 컨텍스트로
ViewBoundary를 찾은 뒤 viewId와 문서 세대를 확인한다.

`webview.ts`의 소유자 그룹은 environment 하나와 창의 controller를 관리한다.
controller 정리는 브라우저 및 자식 프로세스 종료를 기다리고 그룹의 COM 참조와 DLL을 해제한다.
시작 창의 controller 생성 오류는 강제 닫기 예약보다 먼저 확인해 앱 시작 실패로 보고한다.
실행 중 생성 오류는 해당 창만 정리하고 호출자에게 반환한다.

## 모니터 조회

`monitors.ts`는 UI Worker의 per-monitor awareness에서 Win32 디스플레이를 조회한다.
`NativeWindowServices.monitors`와 `NativeWindow.getMonitor`를 창 플러그인에 제공하며
HMONITOR를 공개하지 않는다. id는 현재 MONITORINFOEXW의 장치명이며 영구 하드웨어 ID가 아니다.
모든 좌표는 물리 virtual-screen 좌표이고 workArea는 작업 표시줄을 제외한다.
rotation은 DEVMODE의 시계 반대 방향 각도다. CLI의 명시적 배포 목록에 모듈을 포함한다.
창 중앙 배치와 상태 저장은 이 조회 구현의 책임이 아니다.

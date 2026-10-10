# Windows Bun 호스트

창 준비는 HWND 생성, 현재 최상위 문서의 NavigationCompleted와 SDK 협상 확인을 구분한다.
`window-readiness.ts`가 기존 windowId와 ViewBoundary 세대별 상태를 소유하고 UI Worker가
기존 native-event 경로로 권한이 있는 구독자에게 보낸다. 최초 네이티브 완료는 WebView2 생성 전에 발행한다.
`visible: false`와 `showWhenReady`는 HWND를 처음부터 숨겨서 만들며 준비 중 활성화하지 않는다.
앱이 요청하는 splashscreen 전환은 주 창 표시 후 splash 닫기를 확정하므로 중간에 마지막 창이 사라지지 않는다.
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

`win32-bindings.ts`는 DLL 함수 바인딩과 FFI 버퍼 보조 함수를 제공하고, `win32.ts`의
`Windows`는 창 클래스, HWND, 아이콘, 전체 화면 상태와 메시지 처리를 소유한다.
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
`com.ts`는 COM 참조와 콜백을, `webview.ts`는 WebView 생성과 종료를 관리한다.
`ui.ts`가 이 자원들의 초기화와 정리 순서를 조정한다. DLL은 창과 COM 정리가 끝난 뒤 닫는다.

창 플러그인을 등록하면 `Windows.observe`가 창별 상태와 물리 outer bounds의 변경을
비교한다. 활성화 관찰은 `WM_ACTIVATE` 뒤에 게시한 창 메시지에서 전경 HWND를 조회한다.
동기 활성화 콜백이 끝나기 전에 이전 전경 HWND를 읽어 전환을 놓치는 것을 방지한다.
`window-events.ts`는 변경 이름과 순서를 결정하며 `ui.ts`는 현재 문서의
구독 관심과 route를 확인해 `native-event` 패킷을 보낸다. 메인은 동일한 route의
활성 Core 세션에 `emitNative`로 전달한다. observer는 SDK 구독 수와 관계없이 창별
하나이며 HWND 파괴 전에 제거한다. 전송 용량과 복구는
[공개 창 이벤트 계약](../../../docs/site/src/content/docs/reference/host/windows.mdx)을 따른다.

트레이 전용 상수는 `tray.ts`, Job 객체 상수는 `job.ts`에 둔다. 개발 CLI와 공유하는
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

The CLI accepts an `app.windows` catalog with one unique policy view per window.
상태 변경 `minimize`, `maximize`, `unmaximize`, `restore`, `toggleMaximize`와
조회 `isMinimized`, `isMaximized`, `isFullscreen`, `isVisible`, `isFocused`도 선택 창 플러그인이
제공한다. UI Worker의 실제 HWND를 사용하며 조회에도 대상 뷰의 `windows:control` 권한이 필요하다.
최소화 전 최대화 복원, 숨긴 창 표시와 전체화면 중 변경 거부는
[공개 창 계약](../../../docs/site/src/content/docs/reference/host/windows.mdx)을 따른다.
`startup: false` defers creation until `windows.create`. Window calls execute on
the UI STA through the explicitly installed and registered `@bunaway/plugin-windows`. The active caller's `windows:list` or scoped `windows:control` permission is checked. The I/O Worker
reports registered operations as capabilities. `windows.recreate` reserves the view
until the old WebView and processes finish, then creates a fresh boundary and
WebView using the same profile. This also postpones last-window shutdown.
Retired views release their COM handlers before a replacement is created.

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
Deferred and recreated windows inherit the verified development DevTools setting.
Shutdown bypasses confirmation.
Browser process failure also closes the affected window without confirmation.
`tests/lifecycle/windows-bun-window-api.ts` is
part of `tests/lifecycle/run-native.ts` and covers native geometry, close refusal and acceptance,
dynamic creation, fresh sessions and self-recreation. It passed in PR #40's
Windows CI run 37574470840. The full native job failed on the shared capability
fixture's old four-operation expectation, which now checks the complete catalog.
The browser-failure regression also passed locally on Windows on 2026-10-07.

앱 정의의 `desktop.onOpen`은 초기 실행과 두 번째 실행의 인자, URL, 파일을 받는다.
`desktop.beforeQuit`는 마지막 창, 트레이, 앱의 종료 요청을 취소할 수 있다.
`desktop.closeBehavior: "hide"`와 `desktop.tray: { tooltip: "Memo" }`를 함께 지정하면
닫기 버튼으로 창을 숨기고 백엔드, WebView, 세션을 유지한다. 트레이 Open 또는
두 번째 실행으로 복원하며 Quit은 종료 검사를 거친다. 기본값은 마지막 창 닫기로 종료다.
URL scheme과 파일 확장자의 OS 등록은 제공하지 않으며 실행기에 전달된 인자를 처리한다.
GUI 실행 파일은 `-Wait`, `-- -draft.txt`와 `-Verbose`를 포함한 모든 인자를 그대로 전달한다.
배포 EXE는 인자와 작업 디렉터리를 직접 읽는다. Windows와 호출 셸의 명령줄 길이 제한을 따른다.
개발 CLI의 재시작과 종료는 종료 취소와 숨김을 우회하며 코어, 플러그인 StopHook과 Worker를 정리한다.
`app.windows: []`와 모든 선언의 `startup: false`는 트레이 또는 `closeBehavior: "keep-alive"`를 요구한다.
keep-alive는 마지막 창을 실제로 정리한 뒤에도 백엔드를 유지한다. Open과 show는 살아 있는 창을
복원하거나 첫 사전 선언 창을 생성한다. 빈 선언 배열이면 창은 만들지 않는다.
트레이 없는 상주 앱은 숨긴 제어 HWND를 소유해 CLI 종료 메시지를 받고 정상 종료 때 정리한다.
[데스크톱 수명주기 결정](../../../docs/decisions/0013-desktop-lifecycle.md).

---
status: accepted
---

# macOS에서 desktop 수명주기와 창 닫기 계약을 AppKit에 연결한다

2026-10-23 후속 결정: [ADR 0026](./0026-single-webview-single-window.md)에 따라 `windows.lifecycle`은 백엔드에 전달되고 수신 권한은 ADR 0020과 같이 `windows.getSnapshot`이 된다. macOS 어댑터는 `getSnapshot`을 구현하고 WebView는 영속 프로필 하나를 쓴다. 창 없는 시작은 계속 `UNSUPPORTED`다.

결정일: 2026-10-16
갱신일: 2026-10-16 (OS 열기 요청과 재활성화 결정을 설계안에서 확정으로 바꿈)

[ADR 0013](./0013-desktop-lifecycle.md)과 [ADR 0020](./0020-close-and-quit-lifecycle.md)의 계약을
macOS Bun FFI 호스트([ADR 0015](./0015-macos-bun-ffi.md))에 연결한다.
[ADR 0010](./0010-windows-first-platform-model.md)에 따라 Windows의 공개 계약은 바꾸지 않고
같은 앱 정의가 macOS에서도 동작하도록 어댑터를 맞춘다.

## 배경

macOS 호스트는 `desktop` 옵션 전체를 `UNSUPPORTED`로 거부했다. 그래서 `beforeQuit`, 수명주기 훅,
세션 종료, 창 수명 이벤트와 닫기 요청을 쓸 수 없었다. AppKit은 종료와 창 닫기의 판단을 동기
delegate 메서드로 요구하지만, `beforeQuit`는 앱이 비동기로 답한다. 또한 Windows와 달리 앱 메뉴의
Quit, Dock의 Quit, Dock 아이콘 클릭이라는 macOS 고유의 진입점이 있다.

## 결정

### 지원 범위

`desktop`을 macOS에서 지원하되 `tray`는 제외한다. 메뉴 막대 아이콘은 구현하지 않았으므로
`desktop.tray`를 지정하면 "macOS menu bar extras (desktop.tray) are not implemented."의
`UNSUPPORTED`로 시작에 실패한다. 복원 경로가 트레이뿐인 `closeBehavior: "hide"`도 같은 이유로
지원하지 않는다. 지원하는 값은 `"quit"`(기본)과 `"keep-alive"`다.
창 없는 시작도 계속 `UNSUPPORTED`이며 앱 정의를 읽기 전에 설정 검증이 거부한다.
Windows는 트레이 또는 `closeBehavior: "keep-alive"`가 있으면 시작 창 없이 실행을 유지하지만,
macOS는 `keep-alive`여도 모든 창이 `startup: false`이거나 `app.windows`가 비어 있으면 호스트가
시작할 때 `UNSUPPORTED`로 거부한다. 두 플랫폼에서 같은 앱 정의가 동작하려면 시작 창을 하나 이상
선언해야 한다.

지원하는 훅은 `onReady`, `onOpen`(초기 실행만), `onOpenUrls`, `onReopen`, `onAllWindowsClosed`
(`keep-alive`), `beforeQuit`, `onWillQuit`, `onQuit`과 `ShutdownReason`이다. 순서는 ADR 0020과 같다. `beforeQuit`, 종료 확정,
`onWillQuit`, Core 정지와 플러그인 StopHook, 네이티브 정리, `onQuit` 순서이며 종료 확정 뒤에는
수명 이벤트와 닫기 요청을 내지 않는다. `onWillQuit`과 `onQuit`의 기한은 각각 3초다.

시작이 끝나기 전(백엔드가 준비를 보고하기 전)에 창 닫기나 Quit이 승인되거나 시그널, 세션 종료가
종료를 확정하면 `onReady`와 초기 `onOpen`은 실행하지 않는다. 이때도 `beforeQuit`(닫기와 Quit일 때),
`onWillQuit`과 이어지는 정상 종료 순서를 따르며 호스트 실패가 아닌 정상 종료다. 호스트는 시작이
끝나기를 기다리지 않고 바로 정리 단계로 들어간다. 근거는 ADR 0020이다.

백엔드는 종료를 확정하는 즉시(승인된 종료, 또는 메인 스레드가 알린 원인) `windows.lifecycle`과
`windows.closeRequested` 같은 네이티브 이벤트를 앱에 전달하지 않는다. 메인 스레드가 확정을 알기
전에도 마찬가지이며 Windows와 같다.

### 구조

`DesktopLifecycle`은 백엔드 Worker가 소유하고 메인 스레드(AppKit)는 패킷으로 협력한다.
메인 스레드는 `closeBehavior`를 받은 뒤에야 닫기와 종료를 판단하므로, 그 전에 들어온 마지막 창
닫기와 Quit은 대기시켰다가 옵션이 도착하면 처리한다. 메인 스레드가 먼저 정하는 종료(시그널,
세션 종료, 창 생성 실패)는 `closing`으로 백엔드에 알리고, 백엔드가 승인한 종료는
`shutdown-committed`로 메인에 알린다. 네이티브 정리는 백엔드의 앱 수준 정리(`cleaned`)가 끝난 뒤에
시작하고 `onQuit`은 그 뒤에 실행한다. Windows의 구성과 같은 계약을 쓰며, 패킷 이름과 필드는
구현 세부로 두고 이 ADR에서 고정하지 않는다.

강제 종료 기한은 5초에 `onWillQuit`과 `onQuit` 기한 3초씩을 더한 11초다. 기한이 더 짧으면 호스트가
앱 훅이 끝나기를 약속한 시간 안에 Worker를 끊게 된다.

### 앱 종료 요청과 `quit-command`

공개 `QuitReason`에 `"quit-command"`를 추가한다. macOS의 Quit 명령(앱 메뉴의 Quit과 Cmd+Q,
Dock의 Quit, 로그아웃, 재시작, 시스템 종료 이유가 없는 quit Apple event)을 뜻한다.
`"tray"`처럼 진입점을 나타내는 값이며 Windows는 발행하지 않는다.
`QuitReason`을 `switch`로 완전하게 처리하는 앱은 새 값을 처리해야 하므로 이는 타입 수준의 확장이다.
기존 값을 재사용하지 않은 이유는 `"last-window"`가 창 닫기, `"api"`가 앱 코드의 호출이라는
뜻을 이미 가지고 있어 사용자의 명시적 Quit과 구분되지 않기 때문이다.

Quit을 받으려면 앱에 Quit 항목이 필요하므로 "Quit <프로세스 이름>"(Cmd+Q)만 있는 최소 메인 메뉴를
설치한다. 다른 메뉴는 메뉴 기능(TODO-macos 07)의 몫이다.

`applicationShouldTerminate:`는 `terminate:`가 불린 경우(앱 메뉴의 Quit, Cmd+Q, 코드의 호출)에 항상
`NSTerminateCancel`을 반환하고 호스트가 비동기 `beforeQuit`를 직접 실행한다. Dock의 Quit과
`osascript`처럼 세션 종료 이유가 없는 quit Apple event는 호스트가 직접 받아 Quit 명령과 같이
`beforeQuit`를 묻는다(아래 세션 종료 참고).

AppKit의 종료 응답을 `NSTerminateLater`로 미루는 방식은 쓰지 않는다. 이 값을 반환하면
`terminate:`가 FFI 호출 안에서 이벤트를 처리하는 중첩 실행 루프를 돌아, Bun JS 스레드(정리 처리,
4초 대체 타이머, 강제 종료 기한)가 실행되지 못하고 응답을 보내지 못할 수 있다. 취소가 정상 경로인
`beforeQuit`에서는 응답을 보류한 채 다른 창과 Dock을 상태가 모호한 앱으로 두는 문제도 있다.
Cancel은 호스트가 승인한 시점에만 종료하므로 취소 뒤 창, 세션, 백엔드를 그대로 유지하며 Windows의
종료 취소와 같다. 승인된 종료는 호스트의 정상 종료 절차가 프로세스를 끝낸다.

`applicationShouldTerminateAfterLastWindowClosed:`는 `NO`를 반환한다. 마지막 창을 닫을 때 앱이
종료할지는 AppKit이 아니라 호스트가 `closeBehavior`로 정한다. `quit`에서 마지막 창은 `beforeQuit`가
승인할 때까지 세션과 함께 열려 있고, 거부하면 모두 유지한다. 승인한 뒤에만 창을 닫는다.
창을 먼저 닫고 종료를 묻는 AppKit의 기본 순서는 취소 뒤 복원할 수 없기 때문에 쓰지 않는다.

SIGINT와 SIGTERM은 `"interrupted"`로 `beforeQuit`를 우회한다. 사용자 결정 없이 마지막 창이
자동으로 사라지는 경우(창 생성 실패)에 `quit`이면 `"window-destroyed"`다.

### OS 열기 요청과 재활성화

macOS에서 Finder, `open`, URL scheme으로 전달되는 파일과 URL은 새 훅 `onOpenUrls`로, Dock 클릭 같은
재활성화는 새 훅 `onReopen`으로 앱에 알린다. `OpenRequest`와 `onOpen`의 의미(실행 인자)는 바꾸지
않는다. 파일과 URL을 `OpenRequest.source`에 합치는 안(`"os-open"` 추가)은 `argv`가 없는 요청을
`onOpen`에 섞어 인자 기반 의미를 흐리므로 택하지 않았다.

#### onOpenUrls

`onOpenUrls(urls, context)`는 URL과 파일을 함께 받는다. 파일은 절대 경로를 정규화한 `file:` URL이고
나머지는 정규화한 절대 URL(`new URL(x).href`)이다. 빈 목록으로는 호출하지 않으며 배열은 동결한다.
`onReady`, `onOpen`과 같은 직렬 큐에서 실행하고, 훅이 던지거나 reject해도 보고만 하고 앱은 계속
실행한다.

Windows는 초기 실행과 두 번째 실행의 실행 인자에서 URL을 만든다. 기존 단일 인스턴스 파이프
(`native/windows/bun/instance.ts`)가 두 번째 실행의 인자를 이미 전달하므로 단일 인스턴스 범위에
들어가며 새 전달 경로는 없다. `openArguments: "files-and-urls"`일 때만 만들고 `"raw"`는 argv를
해석하지 않으므로 URL이 없다. 한 번의 실행에 대한 순서는 (두 번째 실행이고 숨김이 아니면 표시) 뒤
`onOpen(OpenRequest)`, 그 뒤 URL이 있으면 `onOpenUrls`다. `onOpen`의 `argv`, `files`, `urls` 의미는
그대로다. `onOpen`이 실패해도 `onOpenUrls`는 실행한다. 인자 해석이 실패하면(잘못된 URL) 보고하고
둘 다 실행하지 않는다.

macOS는 `application:openURLs:` delegate로 받는다. 이 메서드를 구현하면 AppKit이 kAEGetURL(`GURL`)과
`odoc`(Finder, `open`)를 모두 이 경로로 전달한다. 구형 `application:openFiles:`는 구현하지 않는다.
호스트가 직접 설치하는 Apple event 핸들러는 quit 이벤트(`aevt`/`quit`)로 한정하므로 `GURL`과 `odoc`은
AppKit의 기본 핸들러가 처리한다. 앱 실행 인자가 아니므로 `openArguments`와 무관하다.

메인 스레드가 요청을 검증한다. 요청 전체는 항목 256개 또는 64 KiB를 넘으면 거부한다. 64 KiB는 원시 입력과
정규화한 URL 각각의 UTF-8 합계에 적용하며, 퍼센트 인코딩으로 길어져 정규화 뒤 넘어도
요청 전체를 거부한다(`too-large`). 항목 단위로는
잘못된 URL, 로컬이 아닌 호스트의 파일 URL, 인코딩된 구분자(`%2F`)나 NUL이 있는 항목을 진단과 함께
버리고, 파일 URL은 정규형으로 바꾼다. 검증은 ADR 0013의 규칙과 같은 한도를 쓴다. 입력은 앱이 검증할
데이터이며 Host API의 권한을 더하지 않는다.
준비 뒤 도착한 요청은 Windows의 두 번째 실행처럼 앱을 먼저 표시(`show()`와 같음)한 뒤 `onOpenUrls`를
호출한다. 다만 표시가 실패하면 실패만 보고하고 `onOpenUrls`는 그대로 호출한다. OS는 요청을 한 번만
전달하므로 표시 실패로 URL을 잃지 않기 위해서다. Windows 두 번째 실행의 `onOpen` 경로는 기존대로
표시 실패를 `onOpen` 실패로 다룬다. 종료가 확정된 뒤 도착한 요청은 `onOpenUrls` 없이 버리고
`open-urls-dropped` 진단(`reason: "ending"`)을 남긴다.

#### 준비 전 요청은 호스트가 보관한다

준비 전에 도착한 OS 열기 요청을 앱이 조회하는 API(`getInitialOpenUrls` 같은)는 만들지 않고 호스트가
보관했다가 순서대로 전달한다. 훅은 정적 앱 정의에 선언되고 호스트는 앱 정의를 읽은 뒤에야 OS
요청을 받으므로, 훅을 늦게 등록해서 요청을 놓치는 경합이 없다. Electron은 `open-url`과 `open-file`을
`will-finish-launching` 전에 등록해야 한다([Electron app 문서](https://www.electronjs.org/docs/latest/api/app)).
Tauri의 deep-link 플러그인은 `getCurrent()`와 `onOpenUrl`을 함께 써야 하고 앱이 초기 URL과 실행 중
URL의 중복을 직접 제거해야 한다([Tauri deep-linking](https://v2.tauri.app/plugin/deep-linking/)).
보관 방식은 전달 경로, 순서, 직렬 큐를 하나로 유지하고 앱이 두 경로를 맞출 필요를 없앤다.

순서 계약은 ADR 0020/0021의 `onReady`, `onOpen` 순서를 잇는다. `onReady`, 초기 `onOpen`, 초기 실행의
`onOpenUrls`(Windows 인자), 보관한 OS 요청(도착 순서), 이후 요청 순이다. 보관한 요청은 앱을 표시하지
않는다. 시작 창이 이미 열리는 중이기 때문이다. 보관 한도는 64개로 열기 큐 한도와 같고 넘치면
보고한다. macOS는 메인 스레드가 백엔드가 옵션을 보고할 때까지 요청을 먼저 잡아 두었다가 한 번에 하나씩
보내며, 이때 대기 요청은 최대 16개이고 넘치는 요청은 진단을 남기고 버린다. 준비 전에 종료가 확정되면 보관한 요청은 버리고 훅을 실행하지 않는다. `onReady`와 초기
`onOpen`을 실행하지 않는 기존 규칙과 같다.

#### onReopen

`onReopen({ hasVisibleWindows }, context)`는 macOS 전용이며 `applicationShouldHandleReopen:hasVisibleWindows:`
(Dock 클릭, reopen Apple event)마다 플래그와 함께 호출한다. 등록하지 않으면 기존 동작을 유지한다.
표시 중인 창이 없을 때 `DesktopContext.show()`와 같게 처리하고 창이 있으면 아무것도 하지 않는다.
등록하면 호스트는 창을 표시하지 않고 앱이 정한다(예: `context.show()`). 등록했을 때 준비 전의
reopen은 버린다. 시작 창이 이미 열리는 중이기 때문이다. Windows는 호출하지 않는다. Windows의 재실행은
두 번째 실행이므로 `onOpen`과 `onOpenUrls`로 간다. delegate의 반환값은 계속 `NO`다.
메인 스레드는 reopen을 열기 요청과 같은 도착 순서 큐에 넣고 한 번에 하나씩 백엔드에 보내 수락을 기다린다.
아직 보내지 않은 reopen이 큐 끝에 있으면 최신 `hasVisibleWindows`로 합치고, 백엔드도 아직 시작하지 않은
대기 reopen을 최신 값 하나로 합친다.
Dock 클릭은 `OpenRequest`로 표현할 입력이 없어 `onOpen`은 호출하지 않는다.

#### 후속 작업

- macOS 패키징은 아직 Info.plist의 `CFBundleURLTypes`와 `CFBundleDocumentTypes`를 만들지 않는다.
  설치된 앱은 scheme과 문서 형식이 LaunchServices에 등록되지 않으므로 OS가 앱으로 열어 주지 않는다.
  Windows 패키징에는 이미 `associations`가 있다.
- macOS는 LaunchServices가 열기 요청을 실행 중인 앱으로 보내므로 단일 인스턴스 장치가 필요 없다.
- AppKit 전달의 실제 동작은 macos-native CI에서만 검증한다.

### 세션 종료

`keyAEQuitReason`이 `kAELogOut`(`logo`), `kAEReallyLogOut`(`rlgo`), `kAERestart`(`rest`),
`kAEShutDown`(`shut`)인 quit Apple event, 또는 `NSWorkspaceWillPowerOffNotification`은
`"session-end"`로 취소할 수 없는 종료를 확정한다. loginwindow는 세션이 끝날 때 이 네 값 중 하나를
이유로 담아 quit 이벤트를 보내며, `kAELogOut`은 사용자가 대화상자를 확인한 뒤의 로그아웃이다.
`kAEShowRestartDialog`(`rrst`)와 `kAEShowShutdownDialog`(`rsdn`)는 앱에 확인 대화상자를 표시하라고
요청할 뿐 세션을 끝내지 않으므로 일반 Quit 명령으로 처리한다.
`beforeQuit`를 호출하지 않고 대기 중인 거부는 무시한다. 닫기 요청도 버린다.

호스트는 `finishLaunching` 뒤에 quit Apple event(`kCoreEventClass` `aevt`, `kAEQuitApplication`
`quit`)의 핸들러를 `NSAppleEventManager`로 직접 설치해 AppKit의 기본 핸들러를 대체한다. 그래서 quit
이벤트는 `terminate:`에 닿지 않는다. 종료 이유가 `logo`, `rlgo`, `rest`, `shut`이거나
`NSWorkspaceWillPowerOffNotification` 뒤라면 핸들러는 취소할 수 없는 종료를 확정하고
`suspendCurrentAppleEvent`로 이벤트를 보류한 뒤 곧바로 반환한다. 호스트는 앱 정리(`onWillQuit`,
플러그인 StopHook, 하위 프로세스와 I/O 정리)가 끝나면, 또는 4초(`SESSION_END_WAIT_MS`) 뒤 중 먼저
오는 때에, 보류한 모든 이벤트를 `resumeWithSuspensionID:`로 재개한다. 응답은 오류가 아닌 성공이라
로그아웃을 취소하지 않는다. 애플리케이션 객체를 닫을 때도 재개한다.

핸들러는 애플리케이션 객체와 별개인 프로세스 수명의 대상 객체에 등록하고 `close()`에서 제거하지
않는다. 공개 API로는 AppKit의 이전 핸들러를 복원할 수 없고, 제거하면 `close()` 뒤에 도착하는 quit
이벤트(예: 세션 종료의 나머지 구간)가 `errAEEventNotHandled`를 받아 loginwindow가 앱이 로그아웃을
취소했다고 볼 수 있다. 그래서 `close()` 뒤에는 살아 있는 애플리케이션이 없으므로 오류 없이 반환해
AppKit이 즉시 성공 응답을 보내게 한다.

`NSWorkspaceWillPowerOffNotification`은 AppKit이 프로세스 안에서 게시하는 알림이다. 호스트가 AppKit의
기본 quit 핸들러를 대체한 뒤에도 게시하는지는 Apple 문서에 없고, 이 저장소에서는 macOS와 웹 접근이
없어 확인하지 못했다. 따라서 세션 종료 계약은 quit Apple event의 `keyAEQuitReason`(`logo`, `rlgo`,
`rest`, `shut`)만으로 성립한다. 알림은 더 이른 시점에 오는 추가 신호일 뿐이며, 정확성은 알림이
오는지에 의존하지 않는다.
이후 호스트의 정상 종료 절차가 프로세스를 끝내지만 운영체제가 응답 직후 끝낼 수 있으므로
`onQuit`과 마지막 네이티브 정리는 보장하지 않는다.
이는 Windows `WM_ENDSESSION` 처리와 같은 4초 예산과 같은 보장 범위다.
`NSTerminateLater`를 쓰지 않는 이유는 위와 같고, 취소를 반환하면 사용자의 로그아웃을 중단시키므로
`applicationShouldTerminate:`의 Cancel에도 맡기지 않는다.

### 창 수명 이벤트와 닫기 요청

`windows.lifecycle`(`created`, `ready`, `closed`, `destroyed`)과 `windows.closeRequested`,
`windows.respondClose`는 ADR 0020과 같은 규칙으로 macOS에서 동작한다. 호출 창 제한, `INVALID_ARGUMENT`,
대기 중 `windows.close`와 `windows.recreate`의 `BUSY`, 반복 사용자 닫기 무시, 취소 조건, 자동 기한
없음, 이벤트 수신 권한(이벤트와 `windows.listInstances`)이 같다. `respondClose`를 macOS 작업으로
등록했으므로 macOS 정책에 넣어도 시작이 실패하지 않는다.

macOS의 사용자 닫기는 타이틀바의 닫기 버튼, `performClose:`, 공개 `windows.close`다.
WebView의 `window.close()`는 처리하지 않는다. 닫기 확인(`setCloseConfirmation`)과 `windows.destroy`가
macOS에서 계속 `UNSUPPORTED`이므로 그에 관한 규칙은 적용되지 않는다.

### `relaunch()`

`DesktopContext.relaunch()`는 ADR 0020의 시그니처와 오류 규칙을 그대로 쓴다. 종료 순서는 `quit`과 같고
원인 `"api"`로 `beforeQuit`, `onWillQuit`, 정지 훅, `onQuit`을 거친다. 세션 종료와 시그널(`interrupted`),
호스트 실패, `exit()`에서는 재실행하지 않는다(`DesktopLifecycle`이 공유하는 규칙).

- **시작 시점.** 백엔드가 마지막 패킷 `exit-code`에 `relaunch` 표시를 실어 보내면 메인 스레드가
  하위 프로세스 정리와 프로세스 그룹 정리를 마친 뒤 `host-stopped` 기록 직전에 새 프로세스를 시작한다.
  macOS에는 단일 인스턴스 잠금이 없어 잠금 대기로 선행 프로세스의 종료를 알 수 없다. 그래서 `/bin/sh`가
  이전 pid가 사라질 때까지(최대 30초, 0.1초 간격) 기다린 뒤 `exec`으로 앱 실행 파일을 시작한다. 30초가 지나도
  이전 프로세스가 남아 있으면 아무것도 시작하지 않고 끝난다.
- **인자.** 실행 파일 경로와 인자는 호스트가 시작할 때의 `launch.executablePath`와 `launch.args`이고, 셸 문자열이
  아니라 `exec "$@"`의 별도 인자로 전달해 인용 문제와 명령 주입이 없다. 작업 디렉터리와 환경 변수는 시작 시점
  값을 유지한다. 번들 앱도 `open -n`이 아니라 번들 안의 실행 파일을 직접 시작해 파일, URL 열기 요청과 구분한다.
- **argv.** macOS 앱은 실행 인자를 받지 않는다(`OpenRequest.argv`는 항상 `[]`). 앱이 볼 수 없는 인자를 조용히 버리지
  않도록 비어 있지 않은 `argv`는 종료하기 전에 `INVALID_ARGUMENT`로 거부한다.
- **프로세스 그룹.** 호스트는 자기 프로세스 그룹을 만들고, 정리와 죽음 감시 프로세스는 그 그룹만 신호한다. 새
  프로세스는 `detached`로 새 세션을 만들어 그 그룹 밖에 있으므로 정리에 걸리지 않고, 호스트 스트림과 연결되지
  않으며 호스트의 종료를 막지 않는다.
- **개발 실행.** macOS에는 CLI가 호스트를 다시 시작하는 개발 경로가 없으므로 개발 실행도 같은 방식으로
  직접 재실행한다.
- **실패.** 새 프로세스를 만들 수 없으면 호스트 로그에 `relaunch-failed`를 남기고 요청한 종료 코드로 끝난다.

선례: Electron `app.relaunch()`와 Tauri `process.relaunch`는 모두 같은 실행 파일을 다시 시작한다. 여기서는 이전
프로세스의 종료를 기다린 뒤 시작해 두 호스트가 겹쳐 실행되지 않게 한다.

### 아직 지원하지 않는 것

- 메뉴 막대 아이콘(`tray`)과 그에 의존하는 `closeBehavior: "hide"`, 창 없는 시작.
- `onOpen`의 인자 기반 요청. macOS의 `onOpen`은 초기 요청만 호출한다. 이 요청은
  `source: "initial"`, `launchReason: "manual"`, `argv: []`, 현재 프로세스의 작업 디렉터리이며 `files`와
  `urls`는 비어 있다. macOS 호스트는 앱 실행 인자를 받지 않는다. OS의 파일과 URL 열기는 `onOpenUrls`로
  받는다.
- 단일 인스턴스 잠금과 두 번째 실행 전달(LaunchServices가 대신한다), 앱 hide/show, 닫기 확인 메시지, `shown`과 `hidden` 이벤트.

## 영향

- `QuitReason`에 `"quit-command"`가 추가되어 완전한 `switch`를 쓰는 앱은 타입 오류를 받는다.
- 앱 정의의 `desktop`을 macOS에서 쓸 수 있다. 트레이, `"hide"`, 창 없는 시작은 기존처럼 거부한다.
- `windows.respondClose`를 macOS 정책에 넣을 수 있다.
- 세션 종료에서 macOS도 `onQuit`을 보장하지 않는다.
- `DesktopOptions`에 `onOpenUrls`와 `onReopen`, 공개 타입 `ReopenEvent`가 추가된다. Windows도 `onOpenUrls`를
  `files-and-urls` 모드의 실행 인자에서 호출하고, `onOpen`의 의미는 바뀌지 않는다.
- 준비 전 OS 열기 요청은 macOS 메인 스레드가 백엔드 설정 전에 최대 16개, 백엔드가 준비 전에
  최대 64개를 보관하고 넘치면 버린다.

## 검증

Linux에서는 종료 원인 분류(`quit-reason`), 세션 종료 대기, 백엔드 종료 순서, 요청 보류, 패킷
처리, 창 수명 규칙, OS 열기 요청의 검증과 보관, 한도와 `onOpenUrls`, `onReopen` 호출 순서를 단위와
계약 테스트로 확인한다. 재실행 명령의 구성, 이전 pid가 사라질 때까지의 대기, 인자의 무해한 전달은 실제 `/bin/sh`로
Linux에서 실행해 확인한다(`tests/lifecycle/macos-relaunch.test.ts`). 이 통과는 실제 AppKit 동작의 검증이 아니다.
실제 AppKit 동작은 macos-native CI에서 `tests/lifecycle/macos-desktop.ts`의 시나리오로 실행한다.
`tests/lifecycle/run-native.ts`가 이 실행기를 등록한다. 시나리오는 앱이 자기 자신에게 `GURL`,
`odoc`, reopen Apple event를 보내 `onOpenUrls`와 `onReopen`을 확인한다. `relaunch` 시나리오는 첫 프로세스가
`relaunch()`로 끝난 뒤 새 호스트 프로세스가 다른 pid로 시작하고, 시작 때 이전 pid가 이미 없으며, 두 번째 프로세스가
정상 종료하는지 확인한다.

CI에서 확인하지 못하는 항목이 있다. 실제 로그아웃, 재시작, 시스템 종료는 실행하지 않고
같은 알림과 quit Apple event를 주입한다. 사용자의 Dock 클릭은 자기 자신에게 보낸 reopen Apple
event로 대신한다. 실제 Cmd+Q 키 입력은 `NSApp terminate:`로, Dock의 Quit은 quit Apple event로 대신한다.

콜드 런치 전달은 native에서 검증하지 않는다. 번들과 LaunchServices 등록이 필요하기 때문이다. 대신 fake
AppKit host 테스트(`tests/lifecycle/macos-desktop-host.test.ts`)가 첫 pump와 desktop-config 전에 전달한 요청이
`onReady`, 초기 `onOpen`, `onOpenUrls` 순서로 도착하는지 확인한다.

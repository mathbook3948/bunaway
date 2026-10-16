---
status: accepted
---

# macOS에서 desktop 수명주기와 창 닫기 계약을 AppKit에 연결한다

결정일: 2026-10-16

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

지원하는 훅은 `onReady`, `onOpen`(초기 실행만), `onAllWindowsClosed`(`keep-alive`), `beforeQuit`,
`onWillQuit`, `onQuit`과 `ShutdownReason`이다. 순서는 ADR 0020과 같다. `beforeQuit`, 종료 확정,
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

### Dock 재활성화

표시 중인 창이 없을 때 `applicationShouldHandleReopen:hasVisibleWindows:`가 호출되면 호스트는
`DesktopContext.show()`와 같은 동작을 한다. 살아 있는 창을 표시하거나 첫 선언 창을 생성한다.
`onOpen`은 호출하지 않는다. Dock 클릭은 새 파일이나 URL을 전달하지 않는 활성화이므로 `OpenRequest`
(argv, files, urls)로 표현할 내용이 없다. Windows의 두 번째 실행은 인자를 실제로 전달하므로
`onOpen`을 호출한다는 차이가 있다. 반환값은 `NO`로 AppKit의 추가 동작을 막는다.

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

### 아직 지원하지 않는 것

- 메뉴 막대 아이콘(`tray`)과 그에 의존하는 `closeBehavior: "hide"`, 창 없는 시작.
- `onOpen`의 OS 파일, URL 열기. `application:openURLs:`와 `application:openFiles:`를 구현하지 않으므로
  초기 `onOpen`만 호출한다. 이 요청은 `source: "initial"`, `launchReason: "manual"`, `argv: []`,
  현재 프로세스의 작업 디렉터리이며 `files`와 `urls`는 비어 있다. macOS 호스트는 앱 실행 인자를
  받지 않는다. `openArguments`는 이 값에서 차이가 없다.
- 단일 인스턴스 잠금과 두 번째 실행 전달, 앱 hide/show, 닫기 확인 메시지, `shown`과 `hidden` 이벤트.

## onOpen 확장 설계안 (구현하지 않음)

이 절은 후속 작업을 위한 설계안이며 구현이 아니다. macOS에서 Finder나 `open`, URL scheme으로 파일과
URL이 전달될 때 `onOpen`에 어떻게 닿게 할지 정한다. Dock 재활성화는 어느 안에서도 `show()`로 둔다.

### 공통 요구

- 전달 지점은 `application:openURLs:`(macOS 10.13 이상의 권장 delegate)다. 구형
  `application:openFiles:`는 같은 경로로 합치며, 둘 다 구현하지 않는다.
- 검증은 ADR 0013을 따른다. 파일 URL은 POSIX 절대 경로로 변환하고, 인코딩된 구분자(`%2F`)와 NUL을
  거부한다. 그 외 URL은 정규화한 절대 URL로 `urls`에 담는다. 인자 최대 256개와 64 KiB의 입력 한도,
  앱 열기 작업 64개 한도, 실패 시 진단을 남기고 다음 요청을 계속하는 규칙을 같이 쓴다.
- 순서는 Windows의 초기 요청과 같다. AppKit은 `applicationDidFinishLaunching:` 전후에 열기 요청을
  줄 수 있으므로, 메인 스레드가 delegate를 설치한 직후부터 요청을 보관하고 `ready` 뒤 백엔드의
  `onOpen` 직렬 큐로 넘긴다. `onReady` 다음, 초기 `onOpen` 앞이나 뒤 중 하나로 고정해야 한다.
  OS 열기가 앱 실행을 일으킨 경우 이 요청이 초기 요청을 대신한다.
- 입력은 앱이 검증할 데이터이며 Host API의 저장 권한을 추가하지 않는다.

### 안 A: `OpenRequest.source`에 `"os-open"` 추가

`OpenRequest.source`를 `"initial" | "second-instance" | "os-open"`으로 넓히고
`application:openURLs:`의 항목을 `files`와 `urls`로 나누어 전달한다. `argv`는 `[]`, `cwd`는 프로세스
작업 디렉터리, `launchReason`은 `"manual"`이다.

- 공개 타입 변경: `packages/plugin-api/src/desktop.ts`의 `OpenRequest.source` 유니온에 값 하나를 더한다.
  필드 추가는 없다. `files`와 `urls`는 이미 `OpenRequest`에 있고 `openArguments: "raw"`에서는 `argv`가
  비어 있으므로 raw 모드는 OS 열기를 받지 못한다는 설명을 더해야 한다.
- 문서 변경: 앱 정의 문서의 OpenRequest 표와 `onOpen` 설명, 이 ADR의 지원 범위.
- Windows 영향: Windows는 `"os-open"`을 발행하지 않는다. Windows의 OS 연결은 실행기에 인자를 넘기므로
  기존 `initial`, `second-instance`가 그대로다. `source`를 `switch`로 완전하게 처리하는 앱은 새 값을
  처리해야 하며 `QuitReason`의 `"quit-command"`와 같은 종류의 확장이다.
- 장점: 파일과 URL을 이미 `OpenRequest`로 받는 앱 코드가 그대로 동작한다. 새 콜백과 새 옵션이 없다.
  `source`로 인자 기반 실행과 OS 열기를 구분할 수 있다.
- 단점: `argv`가 없는 요청이라 argv에 의존하는 앱은 이 요청에서 정보를 얻지 못한다. `source`가
  늘어날 때마다 완전 처리 앱의 타입 오류가 생긴다.

### 안 B: 별도 콜백 `onOpenUrls`와 `onReopen`

`DesktopOptions`에 `onOpenUrls?(urls, context)` 같은 콜백을 더하고 재활성화는 `onReopen(context)`로
알린다. `OpenRequest`는 바꾸지 않는다.

- 공개 타입 변경: `DesktopOptions`에 콜백을 두 개 더한다. 이름과 인자, 직렬 큐 공유 여부, 한도,
  `openArguments`와의 관계를 새로 정해야 한다.
- 문서 변경: 새 필드 행과 호출 시점 표, 각 콜백의 오류와 순서 설명.
- Windows 영향: Windows는 두 콜백을 호출하지 않는다. 두 번째 실행의 파일과 URL은 `onOpen`으로,
  macOS의 OS 열기는 `onOpenUrls`로 가므로 같은 의미의 열기 처리가 플랫폼별 콜백으로 갈라진다.
- 장점: `OpenRequest`의 의미(실행 인자)를 유지하고 재활성화를 앱이 감지할 수 있다.
- 단점: 앱이 같은 파일 열기 로직을 두 콜백에 연결해야 한다. 공개 API가 늘고 단일 앱 정의로 플랫폼을
  맞춘다는 ADR 0010의 방향과 어긋난다.

### 권장

OS 파일과 URL 열기에는 안 A를 권장한다. `OpenRequest`에는 이미 `files`와 `urls`가 있고 앱의 열기
로직이 한 곳에 모이며 공개 타입의 변경이 유니온 값 하나로 끝난다. Windows와 macOS에서 같은 앱
정의가 같은 콜백으로 파일을 받는다.
재활성화는 안 B의 `onReopen`을 만들지 않고 `show()`로 유지한다. 새 입력이 없는 활성화는 열기 요청이
아니며, 호스트가 창을 되살리면 앱이 따로 처리할 일이 거의 없다. 앱이 재활성화에 반응해야 하는 요구가
확인되면 그때 `onAllWindowsClosed`와 같은 수명주기 훅으로 별도 ADR에서 다룬다.

## 영향

- `QuitReason`에 `"quit-command"`가 추가되어 완전한 `switch`를 쓰는 앱은 타입 오류를 받는다.
- 앱 정의의 `desktop`을 macOS에서 쓸 수 있다. 트레이, `"hide"`, 창 없는 시작은 기존처럼 거부한다.
- `windows.respondClose`를 macOS 정책에 넣을 수 있다.
- 세션 종료에서 macOS도 `onQuit`을 보장하지 않는다.

## 검증

Linux에서는 종료 원인 분류(`quit-reason`), 세션 종료 대기, 백엔드 종료 순서, 요청 보류, 패킷
처리와 창 수명 규칙을 단위와 계약 테스트로 확인한다. 이 통과는 실제 AppKit 동작의 검증이 아니다.
실제 AppKit 동작은 macos-native CI에서 `tests/lifecycle/macos-desktop.ts`의 시나리오로 실행한다.
`tests/lifecycle/run-native.ts`가 이 실행기를 등록한다.

CI에서 확인하지 못하는 항목이 있다. 실제 로그아웃, 재시작, 시스템 종료는 실행하지 않고
같은 알림과 quit Apple event를 주입한다. 사용자의 Dock 클릭은 자기 자신에게 보낸 reopen Apple
event로 대신한다. 실제 Cmd+Q 키 입력은 `NSApp terminate:`로, Dock의 Quit은 quit Apple event로 대신한다.

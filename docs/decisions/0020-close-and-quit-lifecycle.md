---
status: accepted
---

# 창 닫기와 앱 종료의 수명주기 훅과 이벤트를 정의한다

2026-10-23 후속 결정: [ADR 0026](./0026-single-webview-single-window.md)에 따라 `windows.lifecycle`은 백엔드에도 전달되고(이벤트 수신은 Host API 호출이 아니므로 `backend.permissions` 검사 대상이 아니다) 문서 세션의 수신 조건 중 작업 권한 `windows.listInstances`는 `windows.getSnapshot`이 되고 정책 `events` 조건은 유지하며, 여러 창, 자식 확인, splashscreen 언급은 제거한다. `respondClose`는 입력에서 `view`와 `windowId`를 없애고 `requestId`를 창별 증가가 아니라 앱 실행 동안 유일하게 발급한다. `onAllWindowsClosed`는 이름을 유지하며 앱의 창이 닫혀 0개가 됨을 뜻하고, 본문의 `onAllWindowsClosed` 제외 조건(승인된 마지막 창의 종료, 종료 중, 창 없는 시작)도 그대로다.

결정일: 2026-10-16

[ADR 0013](./0013-desktop-lifecycle.md)을 확장한다. 0013의 `beforeQuit`, 닫기 동작과
trusted destroy 계약은 유지한다. Windows 호스트와 SDK가 이 계약을 구현하며
macOS는 [ADR 0021](./0021-macos-desktop-lifecycle.md)에 따라 같은 계약을 따른다.

## 배경

0013은 종료를 취소하는 `beforeQuit`만 제공했다. 앱은 종료가 확정된 뒤 정리 작업을 할
위치, 모든 창이 닫힌 시점, 창의 생성과 파괴 시점, 저장이 끝난 뒤에야 닫기를 허용하는
방법을 갖지 못했다. 또한 Windows 로그오프와 시스템 종료에서 앱이 어떻게 행동하는지
정해져 있지 않았다. 이 ADR은 네 부분을 하나의 계약으로 정한다. 앱 수명주기 훅,
세션 종료, 창 수명 이벤트, 닫기 요청이다.

## 앱 수명주기 훅

`DesktopOptions`에 `onReady`, `onWillQuit`, `onQuit`, `onAllWindowsClosed`를 추가하고
종료 원인 `ShutdownReason`을 `QuitReason | "window-destroyed" | "session-end" | "interrupted"`로
정의한다. `beforeQuit`는 기존과 같이 `QuitReason`만 받는다.
2026-10-16 변경: `QuitReason`에 macOS의 Quit 명령을 뜻하는 `"quit-command"`가 추가되어
`ShutdownReason`도 이 값을 포함한다. Windows는 발행하지 않는다.

- `onReady`는 Core와 백엔드가 준비되고 UI가 시작 창의 네이티브 생성을 시작했다고 보고한 뒤
  한 번 호출한다. 문서나 SDK 준비를 뜻하지 않는다. `onOpen`과 같은 직렬 큐에서 초기
  `onOpen`보다 먼저 실행하며 초기 `onOpen`은 그 완료 뒤 시작한다.
  `onOpenUrls`와 보관한 OS 열기 요청은 초기 `onOpen` 뒤에 이어진다([ADR 0021](./0021-macos-desktop-lifecycle.md)).
- `onAllWindowsClosed`는 앱이 계속 실행되는 상태에서 살아 있는 창이 0개로 바뀔 때마다 호출한다.
  `keep-alive`와 트레이 앱이 대상이다. 컨트롤러가 준비되어 `created`가 발행된 창만 살아 있는 창으로 센다.
  생성 중인 창은 세지 않으며, 생성이 실패해도 호출이 반복되지 않는다. 종료 중이거나 승인된 마지막 창의 종료, 창 없는 시작에서는 호출하지 않는다.
- `onWillQuit`은 종료가 확정된 직후 한 번 호출한다. Core 정지, 플러그인 StopHook, 창 정리보다 앞선다.
  결과는 무시하며 종료를 취소하지 못한다. 이 시점의 호스트는 이미 종료 중이므로 웹 세션은 더 이상 응답을 받지 못하고,
  `onWillQuit`은 Host API 범위 밖에서 실행하므로 이 훅 안에서 직접 부르는 창이나 클립보드 같은 호스트 작업은
  쓸 수 없고 `INVALID_ARGUMENT`로 실패한다. 앞서 명령이나 플러그인 `setup`이 시작한 작업의 호스트 호출은
  종료가 확정된 시점부터(`onWillQuit` 실행 중 포함) `CANCELLED`로 실패한다. 이 훅은 상태 저장과
  앱 자원 정리 같은 앱 내부 정리만 한다.
- `onQuit`은 Core와 Worker가 멈춘 뒤 호스트가 반환하기 직전에 한 번 호출한다.
- 종료는 UI 스레드가 먼저 알 수도 있고(`closing`, `session-end` 패킷) 메인 스레드가 먼저 정할 수도 있다
  (api, 트레이, 마지막 창 종료의 승인과 시그널). 후자는 메인 스레드가 UI에 `shutdown-committed` 패킷을
  `shutdown`보다 먼저 보내며, UI는 이를 받으면 이후 창 수명 이벤트와 닫기 요청을 내지 않고 대기 중인 닫기 요청을 취소한다.
- 시작 승인을 기다리는 동안 종료가 확정되면 초기 `onOpen`과 `onReady`는 호출하지 않고 정상 종료 경로로 이어 간다. 호스트 실패로 보지 않는다.
- 호스트 실패(시작 실패, UI Worker 중단)는 `onWillQuit`과 `onQuit`을 건너뛴다.
  앱이 정상적으로 정리할 수 있는 상태가 아니기 때문이다.
- 콜백이 예외를 던지거나 거부하면 진단을 남기고 앱 실행은 계속한다. 종료 훅은 `beforeQuit`와 달리 취소권이 없다.

`onWillQuit`과 `onQuit`은 각각 3초(`WILL_QUIT_DEADLINE_MS`)까지만 기다린다. 기한이 지나면
진단을 남기고 종료를 이어 간다. 종료 훅이 멈춰도 프로세스가 끝나지 않는 상태를 막기 위해서다.
`beforeQuit`는 사용자 결정을 기다리므로 0013대로 자동 기한이 없다. 이 차이는 의도적이다.
`beforeQuit`는 종료를 막을 수 있어 앱이 완료해야 하지만, 확정된 종료의 훅은 호스트가 기한을 정한다.

## 세션 종료

Windows 로그오프, 재시작, 시스템 종료와 Restart Manager의 앱 닫기는 `WM_QUERYENDSESSION`과
`WM_ENDSESSION`으로 전달한다. 앱 창, 제어, 트레이, 시스템 이벤트, 모니터 HWND를 포함한
UI 스레드의 모든 HWND가 하나의 처리기를 공유한다. 별도 클래스를 쓰는 플러그인 전용 창(클립보드)은 포함하지 않는다.

- `WM_QUERYENDSESSION`은 항상 TRUE로 응답한다. 대화상자, `beforeQuit`, 닫기 확인을 거치지 않는다.
  `beforeQuit`는 비동기이므로 동기 메시지 안에서 답할 수 없다. 사용자가 이미 시스템 종료를
  요청했으므로 앱이 이를 거부하지 않는다. 앱 데이터는 사용 중에 저장하는 것이 원칙이다.
- `WM_ENDSESSION(FALSE)`는 다른 앱이 종료를 취소했다는 뜻이므로 계속 실행한다.
- `WM_ENDSESSION(TRUE)`는 취소할 수 없는 종료를 `"session-end"` 원인으로 시작한다.
  `beforeQuit`를 호출하지 않고 대기 중인 `beforeQuit` 거부는 무시한다. 대기 중인 닫기 확인과 닫기 요청은 버린다.
- Windows는 창 프로시저가 반환한 뒤 프로세스를 끝낼 수 있고 앱에 주는 전체 시간은 약 5초다.
  UI 스레드는 최대 4초(`SESSION_END_WAIT_MS`)까지 창 프로시저를 붙잡아 `onWillQuit`과 Core 정지
  (플러그인 StopHook)가 끝나기를 기다린 뒤 반환한다. 두 단계가 이 4초를 나눠 쓰므로 `onWillQuit`이
  최대 3초를 쓰면 Core 정지에는 1초가 남는다. 남은 약 1초는 OS와 프로세스 전환 여유다.
  이후 프로세스가 끝날 수 있으므로 `onQuit`과 네이티브 정리는 보장하지 않는다.

`ShutdownBlockReasonCreate`로 종료를 지연시키는 방법은 쓰지 않는다. 사용자에게 종료가
막혔다는 화면을 보이고 앱이 임의로 시스템 종료를 지연시킬 수 있게 되며, 앱 정의가
차단 사유 문자열, 해제 시점과 실패 시 동작을 책임져야 하기 때문이다. 필요하다면 별도의 선택 API로
추가한다. 그때는 사유 문자열과 해제 규칙을 공개 계약으로 정하고 차단 중 UI 스레드의 메시지
처리와 `onQuit` 보장 범위를 다시 검토해야 한다.

## 창 수명 이벤트 `windows.lifecycle`

payload는 `{ windowId, viewId, phase }`이고 `phase`는 `created`, `ready`, `closed`, `destroyed`다.

- `created`는 네이티브 창과 WebView 컨트롤러가 생긴 시점이다. `ready`는 해당 windowId의 첫 문서가
  ready가 된 시점이다. `closed`는 닫기가 확정되어 세션을 철회한 시점이고, `destroyed`는 네이티브
  자원을 해제한 시점이다. 각 단계는 windowId마다 최대 한 번, 이 순서로 발행한다.
- 탐색은 `ready`를 다시 발행하지 않는다. 재생성은 이전 windowId의 `closed`, `destroyed`와
  새 windowId의 `created`, `ready`로 나타난다. 생성 실패는 이벤트를 만들지 않는다.
- 앱 종료나 세션 종료가 시작된 뒤에는 세션을 정리하는 중이므로 발행하지 않는다.
- 수신 뷰는 정책의 `events`에 `windows.lifecycle`이 있고 작업 권한 `windows.listInstances`가 있어야 한다.
  모든 창의 이벤트가 노출되므로 창 목록 조회와 같은 권한 경계를 적용한다.
  닫히는 창 자신의 세션은 먼저 철회되어 그 창은 자신의 `closed`, `destroyed`를 받지 못한다.
- 여러 창은 [ADR 0017](./0017-multiple-windows-per-view.md)의 windowId로 구분한다.

## 닫기 요청 `windows.closeRequested`와 `windows.respondClose`

비동기 저장 뒤에 닫는 흐름을 위해 선택 기능으로 제공한다. 대상 창의 현재 문서가
`windows.closeRequested`를 구독하고 그 뷰가 `windows.respondClose`를 호출할 수 있으면,
사용자 닫기(타이틀바, Alt+F4, `WM_CLOSE`, WebView의 `window.close()`, 공개 `windows.close`)는 그 창의
문서에 `{ windowId, viewId, requestId }`를 보내고 답을 기다린다. 구독하지 않으면 기존 동작이다.

- `windows.respondClose({ view, windowId?, requestId, allow })`는 `null`을 반환한다.
  `allow: false`는 창을 유지한다. `allow: true`는 그 창 자신의 닫기 확인만 건너뛰고 계속 진행한다.
  자식 창의 확인, 마지막 창의 `beforeQuit`, 닫기 자체는 기존 순서대로 실행한다.
  앱이 이미 저장 확인을 마쳤는데 운영체제 확인을 다시 묻지 않기 위해서다.
- `requestId`는 windowId 안에서 증가하는 양의 정수다. 이미 답했거나 취소된 요청에 답하면
  `INVALID_ARGUMENT`("No pending close request.")다.
- 대기 중 같은 창의 반복 사용자 닫기는 무시하고 공개 `windows.close`와
  `windows.recreate`는 `BUSY`다. 대기는 계속된다.
- 문서 탐색이나 세션 철회, 마지막 `windows.closeRequested` 구독의 해제, 이벤트를 전달할 수 없는 상태는
  요청을 취소하며 창은 열려 있다. 구독 해제 뒤 다음 사용자 닫기는 구독이 없는 경우와 같이 진행하고,
  새 구독은 새 요청을 받는다.
- `windows.respondClose`는 신뢰된 백엔드 또는 질문을 받은 창 자신의 문서만 호출할 수 있다.
  requestId는 작은 증가 정수라 추측할 수 있으므로, 인증된 문서 세션의 창이 대상 창과 다르면
  `PERMISSION_DENIED`다. 호스트 요청에서 호출 창을 확인할 수 없으면 거부한다.
- 강제 닫기, `windows.destroy`, 앱 종료와 세션 종료는 창을 닫고 대기를 끝낸다.
  대기가 없을 때의 재생성은 질문 없이 창을 닫는다.
  closeBehavior `hide`, 재생성, splashscreen 전환, 부모와 함께 닫히는 자식은 요청을 보내지 않는다.
- 자동 기한을 두지 않는다. 저장 시간은 앱이 정하며 신뢰된 destroy, 앱 종료, 세션 종료가 영구 대기를 막는다.
  기한을 두면 저장 중인 문서를 호스트가 임의로 닫거나 열어 두는 둘 중 하나를 골라야 한다.
- 한계: 구독을 유지한 채 답하지 않는 앱은 창을 계속 대기시킨다. 리스너가 실패해도 답하도록 앱이 책임진다.

사용자 닫기 한 번에 `beforeQuit`와 닫기 요청이 함께 있으면 순서는 닫기 요청, 닫기 확인, 마지막 창이면
`beforeQuit`, 닫기 완료다.

## 종료 코드, `exit`, `relaunch`

2026-10-17 변경: `DesktopContext`에 `quit(options?: { exitCode })`, `exit(exitCode?)`,
`relaunch(options?: { argv, exitCode })`를 추가한다. 신뢰된 앱 콜백만 쓸 수 있고 웹 세션과
명령 컨텍스트에는 노출하지 않는다.

- 종료 코드는 0에서 255 사이의 정수다. 그 밖의 값은 `INVALID_ARGUMENT`로 거부하고 종료하지 않는다.
  macOS와 Windows가 같은 범위를 보고할 수 있게 하려는 제한이다.
- `quit({ exitCode })`는 기존 순서(`beforeQuit`, `onWillQuit`, Core와 StopHook, `onQuit`)를 그대로 따른다.
  코드는 종료가 확정될 때 원인과 함께 기록하며 먼저 확정된 값이 이긴다. `beforeQuit`가 거부하면 지정한 코드도 버린다.
  `ShutdownReason`은 `"api"`로 바뀌지 않는다. 호스트는 `onQuit`까지 끝난 뒤 이 코드로 프로세스를 끝낸다.
  호스트 실패는 계속 코드 1이다.
- `exit(exitCode)`는 취소할 수 없는 종료다. `beforeQuit`, 닫기 확인, `onWillQuit`, `onQuit`을 건너뛰고
  대기 중인 `beforeQuit` 결과는 무시한다. Core, StopHook, Worker, Job 정리는 유지하며 기존 40초 백스톱이
  시간을 제한한다. 이미 확정된 `quit`의 코드와 `relaunch`는 `exit`가 대체한다. 두 번째 `exit`는 무시한다.
  UI는 기존 `shutdown-committed` 처리로 대기 중인 닫기 요청을 취소하므로 UI 스레드는 바뀌지 않는다.
- `relaunch({ argv, exitCode })`는 한 번의 호출로 종료와 재실행을 함께 요청한다. `quit`과 같은 순서를 따르며
  `beforeQuit`가 거부하면 `false`를 반환하고 재실행하지 않는다. 호스트 실패와 세션 종료에서는 재실행하지 않는다. 재실행이 확정된 뒤 `interrupted`(Ctrl+C, SIGTERM)가
오면 사용자가 프로세스를 끝내려는 뜻이므로 세션 종료처럼 재실행 요청을 지운다.
- 겹친 요청은 먼저 시작된 종료가 이긴다. 이 규칙은 `beforeQuit` 검사가 진행 중인 동안과 종료가 확정된 뒤에
  모두 적용한다. 앱의 `quit`, `relaunch` 요청이 진행 중이거나 확정된 요청과 종료 코드(생략은 0)와
  재실행 여부, `argv`가 모두 같으면 그 결과(promise)를 공유한다. 다르면 적용하지 않고 `false`를 반환하며
  먼저 시작된 종료는 그대로 진행한다. 호출자는 `true`일 때만 자신의 요청이 적용됐다고 볼 수 있다.
  `exit` 뒤에는 앱 훅이 실행되지 않으므로 같은 요청도 `false`를 반환한다. 정리가 40초를 넘기는 경우는
  호스트 실패로 보고 코드 1로 끝낸다.
  트레이 Quit이나 마지막 창 닫기처럼 호스트가 낸 요청은 요청 내용이 없으므로 항상 진행 중인 종료에 합류한다.
  `exit`는 이 규칙에서 예외로 항상 기존 요청을 대체한다.
- 재실행 인자 기본값은 최초 실행의 `OpenRequest.argv`(개발 스위치와 autostart 접두사 제외)다.
  `argv`를 주면 그것으로 대체한다. 문자열 256개 이하, NUL 금지(희소 배열 불가), JSON 64KiB 이하는
  [ADR 0013](./0013-desktop-lifecycle.md)의 실행 인자와 같은 상수(`MAX_LAUNCH_ARGUMENTS`,
  `MAX_LAUNCH_ARGUMENT_BYTES`)를 쓴다. 단일 인스턴스 pipe 프레임의 64KiB는 인자와 작업 디렉터리를
  합친 상한이라 별개의 한도다. Windows에서는 실행 파일, 개발 모드의 Bun 옵션과 스크립트, 개발 스위치를
  포함해 인용한 뒤의 명령줄이 `CreateProcessW`의 한도(32767자 미만)를 넘으면 `relaunch()`가
  종료를 확정하기 전에 `INVALID_ARGUMENT`로 거부한다. `bunaway dev`에서는 CLI가 인자를 넘기므로 이 검사가 없다.
  실행 파일 경로, 환경 변수, 작업 디렉터리는 재정의할 수 없다. 작업 디렉터리는 boot 시점 값을 유지한다.
  호스트가 새 프로세스에 내부 표지 환경 변수 하나만 더한다.

Windows 구현은 `runWindowsApp`이 `{ exitCode, relaunch? }`를 반환하게 하고 `boot.ts`가 적용한다.
새 프로세스는 `onQuit`과 인스턴스 pipe 정리가 끝난 뒤에만 만든다. `host.lock`은 프로세스가 끝나야 풀리므로
표지가 있는 새 호스트는 단일 인스턴스 검사 전에 잠금이 풀릴 때까지(최대 30초) 다시 시도하며,
기한이 지나면 일반 두 번째 실행처럼 실행 중인 인스턴스로 인자를 전달한다.
앱 Job은 닫힐 때 하위 프로세스를 함께 종료하므로 새 프로세스는 Job을 벗어나야 한다.
`Bun.spawn`은 이 플래그를 줄 수 없어 `job.ts`가 `CreateProcessW`를 `CREATE_BREAKAWAY_FROM_JOB`으로 부른다.
Job의 `BREAKAWAY_OK`는 이 호출 동안에만 켠다. 바깥 Job이 이탈을 거부하면 이 시점에는 종료가 확정되어
호출자에게 알릴 수 없으므로 `relaunch-failed` 진단을 남기고 요청한 코드로 종료한다.
`bunaway dev`에서는 호스트가 CLI에 IPC 메시지(`bunaway:relaunch-app`)를 보내고 CLI의 확인
(`bunaway:relaunch-ack`)을 최대 2초 기다린 뒤 요청한 종료 코드로 끝난다. CLI는 요청을 받은 뒤의 종료를
종료 코드와 관계없이 재실행으로 보고, 마지막으로 성공한 빌드로 새 호스트를 다시 띄워(재빌드 없음)
개발 세션을 유지한다. 마지막 전체 빌드 뒤에 앱 코드 리로드가 성공한 적이 있으면 그 빌드는 리로드 전
코드이므로, 재시작 컨트롤러로 재빌드해 소스 변경과 직렬화한 뒤 새 호스트를 띄운다. 새 호스트를 띄우지 못하면 오류를 출력하고 인자를 버리며, 앱 없이 세션이 이어져
다음 소스 변경에서 정상 재시작한다.
요청의 `argv`는 그 새 호스트에만 쓰고 이후 소스 변경 재시작에는 붙이지 않는다.
요청이 CLI에 도달하지 않으면 CLI는 일반 종료로 처리한다. 특수 종료 코드에는 의존하지 않는다.
macOS는 `quit`의 코드와 `exit`를 같은 `DesktopLifecycle`로 지원하고 코드는 `onQuit`까지 끝난 뒤 마지막에
`exit-code` 패킷으로 메인 스레드에 전달한다. `onQuit` 안의 `exit`도 최종 코드에 반영된다. `relaunch`의 macOS 구현은 [ADR 0021](./0021-macos-desktop-lifecycle.md)의 `relaunch()` 절을 따른다.

다른 프레임워크와의 비교. Electron의 `app.exit(code)`는 창을 닫지 않고 `before-quit`, `will-quit`,
`quit`을 내지 않고 즉시 끝낸다. `exit`가 이 훅 생략을 따른다. Electron의 `app.relaunch()`는 예약만 하고
`quit` 또는 `exit`를 따로 불러야 하므로 "재실행 예약" 상태가 남는다. 이 설계는 호출 한 번으로 종료와
재실행을 함께 하는 형태를 택해 그 상태를 없앴다.

## macOS

2026-10-16 변경: macOS도 이 계약을 구현한다. 네 훅, 세션 종료, `windows.lifecycle`,
`windows.closeRequested`와 `windows.respondClose`가 같은 규칙으로 동작하며 매핑과 차이는
[ADR 0021](./0021-macos-desktop-lifecycle.md)이 정한다. macOS의 Quit 명령을 위해 `QuitReason`에
`"quit-command"`를 더했다. `desktop.tray`, `closeBehavior: "hide"`, 창 없는 시작은 macOS에서
계속 `UNSUPPORTED`다. 이 문서의 닫기 확인과 `windows.destroy` 규칙은 macOS가 두 기능을
지원하지 않으므로 적용되지 않는다. `windows.respondClose`는 macOS 작업으로 등록되어 있어
macOS 정책에 넣어도 시작이 실패하지 않는다.

## 검증

Linux에서는 훅 순서와 기한, 세션 메시지 처리기, 이벤트와 작업 스키마, 권한, 오류 계약을 단위와
계약 테스트로 확인한다. 이 통과는 실제 Windows 동작의 검증이 아니다.
실제 Windows 동작은 windows-native CI에서 실행한다. `tests/lifecycle/windows-desktop.ts`의
`lifecycle`, `dev-lifecycle` 시나리오가 훅 순서와 종료 원인을 확인하고,
`boot-forward-lifecycle`이 부팅 중 전달된 요청의 순서를 확인하며,
`tests/lifecycle/windows-session-end.ts`의 `window`, `control`, `tray` 시나리오가 실제 HWND에
세션 종료 메시지를 보낸다. `tests/lifecycle/windows-multiple-windows.ts`는 여러 창의
`windows.lifecycle`을, `tests/lifecycle/windows-close-request.ts`는 닫기 요청 흐름을 실행한다.

macOS는 같은 단위와 계약 테스트를 Linux에서 실행하고, 실제 AppKit 동작은 macos-native CI의
`tests/lifecycle/macos-desktop.ts` 시나리오로 확인한다. 실제 로그아웃과 Dock 클릭은 CI에서 확인할 수 없어
알림과 Apple event로 대신한다. 자세한 범위는 ADR 0021을 따른다.

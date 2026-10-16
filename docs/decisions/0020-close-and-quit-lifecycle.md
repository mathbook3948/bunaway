---
status: accepted
---

# 창 닫기와 앱 종료의 수명주기 훅과 이벤트를 정의한다

결정일: 2026-10-16

[ADR 0013](./0013-desktop-lifecycle.md)을 확장한다. 0013의 `beforeQuit`, 닫기 동작과
trusted destroy 계약은 유지한다. Windows 호스트와 SDK가 이 계약을 구현한다.

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

- `onReady`는 Core와 백엔드가 준비되고 UI가 시작 창의 네이티브 생성을 시작했다고 보고한 뒤
  한 번 호출한다. 문서나 SDK 준비를 뜻하지 않는다. `onOpen`과 같은 직렬 큐에서 초기
  `onOpen`보다 먼저 실행하며 초기 `onOpen`은 그 완료 뒤 시작한다.
- `onAllWindowsClosed`는 앱이 계속 실행되는 상태에서 살아 있는 창이 0개로 바뀔 때마다 호출한다.
  `keep-alive`와 트레이 앱이 대상이다. 종료 중이거나 승인된 마지막 창의 종료, 창 없는 시작에서는 호출하지 않는다.
- `onWillQuit`은 종료가 확정된 직후 한 번 호출한다. Core 정지, 플러그인 StopHook, 창 정리보다 앞선다.
  결과는 무시하며 종료를 취소하지 못한다. 이 시점의 호스트는 이미 종료 중이므로 웹 세션은 더 이상 응답을 받지 못하고,
  `onWillQuit` 안의 창이나 클립보드 같은 호스트 작업은 항상 `CANCELLED`로 실패한다. 이 훅은 상태 저장과
  앱 자원 정리 같은 앱 내부 정리만 한다.
- `onQuit`은 Core와 Worker가 멈춘 뒤 호스트가 반환하기 직전에 한 번 호출한다.
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
- 대기 중 같은 창의 반복 사용자 닫기는 무시하고 공개 `windows.close`는 `BUSY`다.
- 문서 탐색이나 세션 철회, 마지막 `windows.closeRequested` 구독의 해제, 이벤트를 전달할 수 없는 상태는
  요청을 취소하며 창은 열려 있다. 구독 해제 뒤 다음 사용자 닫기는 구독이 없는 경우와 같이 진행하고,
  새 구독은 새 요청을 받는다.
- `windows.respondClose`는 신뢰된 백엔드 또는 질문을 받은 창 자신의 문서만 호출할 수 있다.
  requestId는 작은 증가 정수라 추측할 수 있으므로, 인증된 문서 세션의 창이 대상 창과 다르면
  `PERMISSION_DENIED`다. 호스트 요청에서 호출 창을 확인할 수 없으면 거부한다.
- 강제 닫기, `windows.destroy`, 재생성, 앱 종료와 세션 종료는 창을 닫고 대기를 끝낸다.
  closeBehavior `hide`, 재생성, splashscreen 전환, 부모와 함께 닫히는 자식은 요청을 보내지 않는다.
- 자동 기한을 두지 않는다. 저장 시간은 앱이 정하며 신뢰된 destroy, 앱 종료, 세션 종료가 영구 대기를 막는다.
  기한을 두면 저장 중인 문서를 호스트가 임의로 닫거나 열어 두는 둘 중 하나를 골라야 한다.
- 한계: 구독을 유지한 채 답하지 않는 앱은 창을 계속 대기시킨다. 리스너가 실패해도 답하도록 앱이 책임진다.

사용자 닫기 한 번에 `beforeQuit`와 닫기 요청이 함께 있으면 순서는 닫기 요청, 닫기 확인, 마지막 창이면
`beforeQuit`, 닫기 완료다.

## macOS

`desktop` 옵션 전체가 기존처럼 `UNSUPPORTED`이므로 네 훅은 macOS에서 동작하지 않는다.
macOS의 `windows.respondClose`는 `UNSUPPORTED`이고 `windows.closeRequested`와 `windows.lifecycle`은 발행하지 않는다.
세션 종료 처리도 구현하지 않는다. 기존 macOS 닫기와 종료 동작은 바꾸지 않으며 대응은 ADR 0010의 순서를 따른다.

## 검증

Linux에서는 훅 순서와 기한, 세션 메시지 처리기, 이벤트와 작업 스키마, 권한, 오류 계약을 단위와
계약 테스트로 확인한다. 이 통과는 실제 Windows 동작의 검증이 아니다.
실제 Windows 동작은 windows-native CI에서 실행한다. `tests/lifecycle/windows-desktop.ts`의
`lifecycle`, `dev-lifecycle` 시나리오가 훅 순서와 종료 원인을 확인하고,
`tests/lifecycle/windows-session-end.ts`의 `window`, `control`, `tray` 시나리오가 실제 HWND에
세션 종료 메시지를 보낸다. `tests/lifecycle/windows-multiple-windows.ts`는 여러 창의
`windows.lifecycle`을, `tests/lifecycle/windows-close-request.ts`는 닫기 요청 흐름을 실행한다.

---
status: accepted
---

# UI Automation 클라이언트 연결 변화 이벤트는 제공하지 않는다

결정일: 2026-10-28. 검토 기준: main `58ddd4ee`.

## 배경

`appearance.getAccessibilityState`의 `assistiveTechnologyActive`는 `UiaClientsAreListening` 결과를 한 번 조회해 돌려준다.
스크린 리더나 돋보기 같은 UI Automation 클라이언트가 붙거나 떨어질 때 앱에 알리는 이벤트를 따로 제공할지 정해야 했다.

- Electron은 `app`의 `accessibility-support-changed` 이벤트와 `app.accessibilitySupportEnabled`로 Chromium의 접근성 모드가
  켜지고 꺼지는 것을 알린다. 이 값은 Chromium 내부 상태이며 앱은 주로 렌더링 최적화를 줄일지 정하는 데 쓴다.
- Tauri v2와 wry는 접근성 지원 설정 API가 없고([ADR 0056](./0056-accessibility-support-control.md)), 접근성 모드 변화를 알리는 이벤트도 확인되지 않았다.
- Windows에서 연결 변화를 얻는 수단과 한계는 다음과 같다.

| 수단 | 얻는 것 | 한계 |
| --- | --- | --- |
| `UiaClientsAreListening` 주기 조회 | 현재 연결 여부 | 변화를 알려 주지 않아 주기마다 호출해야 하고, 주기 사이의 연결과 해제는 놓친다 |
| `UiaRegisterProviderCallback` | UI Automation 클라이언트가 provider를 처음 요청하는 시점 | 첫 요청만 알리고 클라이언트 종료는 알리지 않는다. 해제를 알 수 없어 연결 상태를 유지할 수 없다 |
| `IRawElementProviderAdviseEvents` | 앱이 구현한 UI Automation provider에 클라이언트의 이벤트 구독 추가와 제거 | 앱이 provider를 직접 구현해야 받을 수 있다. 이 플러그인은 provider를 구현하지 않고 WebView 접근성 트리는 Chromium이 만든다. 구독은 이벤트 종류별이라 클라이언트 연결 자체와 일치하지 않는다 |
| WebView2 접근성 트리 요청 | Chromium이 접근성 트리를 만드는 시점 | 공개 API가 없고 WebView2 내부 호출에 좌우된다. 클라이언트 연결과 일치한다고 보장되지 않는다 |
| `SPI_GETSCREENREADER` 변화 | 스크린 리더 설정 플래그 | 이미 `appearance.changed`가 알린다. 플래그는 실제 클라이언트 연결과 독립적이다 |

## 결정

1. UI Automation 클라이언트 연결 변화 이벤트를 제공하지 않는다. `appearance`에 이벤트를 더하지 않고 코어 계약도 넓히지 않는다.
2. 앱은 연결 상태가 필요한 시점에 `appearance.getAccessibilityState()`를 호출해 `assistiveTechnologyActive`를 읽는다.
   스크린 리더 설정 플래그의 변화는 기존 `appearance.changed`로 구독한다.
3. 사용처가 생기면 이 ADR을 대체하는 결정으로 다시 연다.

## 근거

- 위 표의 수단 중 호스트 앱이 추가 구현 없이 연결과 해제를 모두 알 수 있는 것은 없다. 알림 후보인 `UiaRegisterProviderCallback`은 종료를 알 수 없어
  이벤트로 쓰면 "연결됨" 뒤에 "해제됨"이 오지 않는다. 이벤트로 약속할 수 없는 계약은 두지 않는다.
- 폴링으로 이벤트를 만들면 주기 사이의 연결과 해제를 놓친다. 같은 정보는 조회 한 번으로 필요한 순간에 얻을 수 있다.
  호출 비용은 측정하지 않았으므로 결정 근거로 쓰지 않는다.
- Electron과 Tauri가 다르다. Electron의 이벤트는 Chromium의 접근성 모드 변화를 알리며, `assistiveTechnologyActive`가 읽는
  UI Automation 클라이언트 연결과 의미가 가깝지만 같은 값이라고 보장되지 않는다. 둘이 다를 때는 코어를 작게 두고
  쓰는 곳이 확인될 때 더한다.
- 보안 경계, 권한, 코어 계약 변경이 없다. 보조 기술 사용 여부는 민감한 정보라 조회가 이미 신뢰된 백엔드 전용이며, 이벤트를
  더하면 이 경계에 구독 권한을 새로 정해야 하는 부담도 생긴다.

## 대안

- `appearance`에 `accessibilityClientChanged` 이벤트를 두고 일정 주기로 조회해 바뀔 때 알린다. 주기 사이의 변화를 놓치며
  사용처가 없다.
- `UiaRegisterProviderCallback`으로 첫 연결만 알리는 이벤트를 둔다. 해제가 없어 상태를 유지할 수 없다.

## 영향

- 코드와 테스트 변경은 없다. `docs/TODO-windows.md`의 해당 항목을 결정 완료로 표시하고 appearance 문서의 연결 변화 이벤트 문단을 이 결정의 근거에 맞춰 고치고 이 ADR 링크를 더한다.

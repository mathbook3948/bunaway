---
status: accepted
---

# WebView 접근성 지원의 강제 활성화와 기능 선택 API는 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `e0813827`.

## 배경

Electron의 `app.setAccessibilitySupportEnabled`, `getAccessibilitySupportFeatures`, `setAccessibilitySupportFeatures`에 해당하는,
접근성 지원을 앱이 강제로 켜고 끄거나 기능을 고르는 API를 제공할지 정해야 했다.

- Electron은 Chromium의 접근성 모드를 앱 코드가 직접 바꾸게 한다. 보조 기술이 감지되기 전에도 접근성 트리를 만들게 하거나
  기능을 선택할 수 있다.
- Tauri v2에는 같은 API가 없다.
- 이 저장소의 `appearance.getAccessibilityState`는 읽기 전용이다. `assistiveTechnologyActive`로 UI Automation 클라이언트의
  연결을 알리며, WebView 접근성 트리를 강제로 켜는 기능이 아니다.
- [ADR 0030](./0030-launch-arguments-and-environment.md)은 앱 정의에 브라우저 switch를 두지 않기로 했다. 접근성 모드를 시작 시
  고정하는 switch도 같은 범위에 속한다.

## 결정

1. 접근성 지원을 강제로 켜거나 끄는 API, 지원 기능을 조회하거나 선택하는 API를 제공하지 않는다.
2. 접근성 지원 상태의 조회는 기존 `appearance.getAccessibilityState`로 한정한다.
3. 접근성 트리와 키보드 탐색의 실제 동작 검증은 별도 항목(WebView 접근성 트리와 사용자 타이틀바의 키보드 탐색 검증)으로 남기며
   이 결정이 대신하지 않는다.

## 근거

- Electron과 Tauri가 다르다. 코어를 작게 두고 기능은 필요가 확인될 때 더하는 기준에 따라 Tauri와 같이 제공하지 않는다.
- 시작 시 고정하는 방법은 브라우저 switch를 앱 정의에 노출해야 하고, ADR 0030이 이미 그 노출을 하지 않기로 했다.
- 앱이 접근성 트리를 강제로 만들게 해야 하는 사용처가 이 저장소에 없다.

## 대안

- Electron과 같은 3개 API를 제공한다. 사용처가 없고 Tauri에도 없다.
- 시작 시 접근성 모드를 고정하는 앱 설정을 둔다. ADR 0030의 switch 비노출과 부딪힌다.

## 영향

- 코드 변경은 없다. `docs/TODO-windows.md`의 해당 항목을 결정 완료로 표시하고 appearance 문서에 제공하지 않는다는 문단을 더한다.
- 사용처가 생기면 이 ADR을 대체하는 결정으로 다시 연다.

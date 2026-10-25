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
- 이 저장소의 `appearance.getAccessibilityState`는 읽기 전용이다. `assistiveTechnologyActive`로 UI Automation 클라이언트의
  연결을 알리며, WebView 접근성 트리를 강제로 켜는 기능이 아니다.
- [ADR 0030](./0030-launch-arguments-and-environment.md)은 앱 정의에 실행 인자, 환경 변수, switch 필드를 두지 않기로 했다.
  앱이 접근성 관련 switch를 시작 시 고정하려면 이 필드가 필요하다. 배포 앱의 프로세스 환경 변수
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 경로는 0030이 막지 않으므로 이 결정도 막지 않는다. 다만 0030 결정 4처럼 `bunaway dev` 호스트는 이 변수를 받지 않아 개발 실행에서
  시험한 결과가 배포 앱 동작을 대변하지 않는다.
- Tauri v2(`tauri` 2.12.5, `wry` 0.57.1 기준)에는 Electron의 접근성 지원 설정 API에 해당하는 공개 API가 없다. Windows에서
  창 생성 시 `additionalBrowserArgs`로 `--force-renderer-accessibility`를 넘기는 방법만 있고, macOS와 Linux에서는 이 인자도
  지원하지 않는다.
- WebView2에는 접근성을 켜거나 강제하는 문서화된 API가 없다. 렌더러 접근성은 스크린 리더가 감지되면 자동으로 켜지며, 강제하는
  `force-renderer-accessibility` 브라우저 플래그는 WebView2 문서가 개발용으로 안내하고 출시 앱에는 쓰지 말라고 한다. 이 플래그는
  환경 생성 시점에만 적용되므로 실행 중에 바꿀 수 없다.

## 결정

1. 접근성 지원을 강제로 켜거나 끄는 API, 지원 기능을 조회하거나 선택하는 API를 제공하지 않는다.
2. 접근성 지원 상태를 바꾸는 경로는 두지 않는다. 읽기는 기존 `appearance.getAccessibilityState`, `getPreferences`와 `appearance.changed`가 맡는다.
3. 접근성 트리와 키보드 탐색의 실제 동작 검증은 별도 항목(WebView 접근성 트리와 사용자 타이틀바의 키보드 탐색 검증)으로 남기며
   이 결정이 대신하지 않는다.

## 근거

- 앱이 접근성 트리를 강제로 만들게 해야 하는 사용처가 이 저장소에 없다. 코어를 작게 두고 기능은 필요가 확인될 때 더한다.
- Electron은 런타임 설정 API를 두지만 Tauri와 WebView2에는 대응이 없고, 보조 기술 감지에 따른 자동 활성화가 기본 동작이다. 따라서
  Electron의 API를 그대로 옮기려면 WebView2에 없는 런타임 제어를 만들어야 하며, 코어를 작게 두는 쪽으로 제공하지 않는다.
- 시작 시 고정하는 방법은 switch 필드를 앱 정의에 노출해야 하고, ADR 0030이 이미 그 노출을 하지 않기로 했다.

## 대안

- Electron과 같은 3개 API를 제공한다. 사용처가 없다.
- 시작 시 접근성 모드를 고정하는 앱 설정을 둔다. ADR 0030의 switch 비노출과 부딪힌다.

## 영향

- 코드 변경은 없다. `docs/TODO-windows.md`의 해당 항목을 결정 완료로 표시하고 appearance 문서에 제공하지 않는다는 문단을 더한다.
- 사용처가 생기면 이 ADR을 대체하는 결정으로 다시 연다.

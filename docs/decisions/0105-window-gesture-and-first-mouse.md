---
status: accepted
---

# Windows에서 first-mouse 설정과 창 gesture 이벤트를 제공하지 않는다

결정일: 2026-10-27. 검토 기준: main `c2ce1e44`.

## 배경

Electron의 `acceptFirstMouse`(비활성 창의 첫 클릭을 활성화와 함께 페이지에 전달할지)와 창 gesture 이벤트(`swipe`,
`scroll-touch-begin`, `scroll-touch-end`, `scroll-touch-edge`)에 대응하는 기능을 Windows에서 제공할지 정해야 했다.

현재 구현:

- 비활성 창의 첫 클릭은 Windows 기본 동작대로 창을 활성화하고 같은 클릭을 WebView에 전달한다.
  호스트가 `WM_MOUSEACTIVATE`를 직접 처리하는 경우는 `focusable: false` 창이 `MA_NOACTIVATE`를 돌려주는 한 곳뿐이다
  (`native/windows/bun/win32.ts`).
- 터치 pinch, pan, 휠 gesture는 WebView2(Chromium)가 페이지에 pointer, touch, wheel 이벤트와 스크롤, 확대로 직접 전달한다.
  호스트는 창 수준 gesture 이벤트를 만들지 않는다. 핀치 확대의 켬/끔은 WebView2 기본값을 따르고 호스트는 설정하지 않는다
  ([ADR 0064](./0064-webview-browser-default-ui.md), [ADR 0073](./0073-webview-zoom-level-and-limits.md)).

선례(Electron과 Tauri 공개 문서 기준이며 이 저장소의 테스트로 검증한 것은 아니다):

- Electron의 `acceptFirstMouse`는 macOS 전용 옵션이다. `swipe`와 `scroll-touch-*` 이벤트도 macOS 전용이다.
  Windows에서는 이 옵션과 이벤트가 동작하지 않는다.
- Tauri(wry)의 first-mouse 옵션(`accept_first_mouse`)도 macOS 옵션이다. Tauri는 창 gesture 이벤트를 제공하지 않는다.

## 결정

1. first-mouse 설정(`acceptFirstMouse`에 해당하는 창 옵션)을 Windows에서 제공하지 않는다. 비활성 창의 첫 클릭은
   Windows 기본 동작(활성화와 클릭 전달)을 따른다. 클릭을 활성화에만 쓰고 페이지에 전달하지 않는 옵션도 만들지 않는다.
2. 창 수준 gesture 이벤트(`swipe`, `scroll-touch-*`, pinch 이벤트)를 제공하지 않는다. 앱은 페이지의 pointer, touch, wheel
   이벤트와 CSS `touch-action`으로 gesture를 처리한다.
3. 새 공개 API, 이벤트, 권한, 스키마, 네이티브 코드를 추가하지 않는다. `focusable: false` 창의 `MA_NOACTIVATE` 처리와
   핀치 확대 기본값은 그대로 둔다.
4. 이 결정은 macOS 동작을 바꾸지 않는다. macOS의 first-mouse와 gesture는 macOS 항목에서 따로 정한다.

## 근거

- 두 선례 모두 Windows에서 이 기능을 제공하지 않는다. 같은 선례를 따른다.
- Windows는 비활성 창의 첫 클릭을 활성화와 전달에 함께 쓰는 것이 기본 동작이므로 `acceptFirstMouse: true`가 만드는
  결과와 이미 같다. 반대 동작(첫 클릭을 삼킴)은 `WM_MOUSEACTIVATE`에서 `MA_ACTIVATEANDEAT`를 돌려주는 방식인데, Windows
  앱 관례와 맞지 않고 사용자가 첫 클릭이 사라지는 것으로 느끼므로 요구하는 선례도 없다.
- 창 gesture 이벤트는 macOS 트랙패드 전용 개념이다. Windows 터치 입력은 WebView2가 페이지에 pointer 이벤트로 전달하고
  브라우저 기본 동작(스크롤, 핀치 확대)으로 처리한다. 호스트가 같은 입력을 다시 이벤트로 내보내면 페이지 처리와 이중이 된다.
- 입력 합성과 커서 제어를 제공하지 않는 이유([ADR 0047](./0047-input-injection-and-ime.md),
  [ADR 0042](./0042-cursor-control.md))와 같다. 코어는 작게 두고, 페이지가 받는 표준 웹 입력 이벤트로 같은 결과를 얻을 수 있다.
- 호스트가 gesture를 해석하려면 창의 입력 훅이나 `WM_GESTURE`, `WM_POINTER` 처리를 WebView2와 겹치게 추가해야 한다.
  이는 WebView2의 입력 경로와 충돌할 수 있고 CI의 합성 입력으로 실제 터치 장치 동작을 확인하기 어렵다. 확인하지 못한 채
  공개 API를 늘리지 않는다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 결정 완료로 표시한다.
- 이를 지원하려면 별도 결정이 필요하다. 그때는 WebView2가 전달하지 않는 Windows 입력이 실제로 있는지, 호스트 입력 훅이
  WebView2 처리와 충돌하지 않는지, 터치 장치 없이 CI에서 확인할 방법을 먼저 정한다.

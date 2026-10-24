---
status: accepted
---

# WebView history의 offset과 index 이동은 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `ca54708d`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

WebView history에서 `goBack`, `goForward` 외에 offset 이동과 index 이동을 제공할지 정해야 했다. 현재는 `windows.goBack`,
`windows.goForward`와 `windows.getWebViewState`의 `canGoBack`, `canGoForward`만 제공한다.

- Electron의 `webContents.navigationHistory`는 `goToOffset(offset)`과 `goToIndex(index)`를 제공한다. 이 이동은 Chromium
  탐색 컨트롤러의 항목 목록 안에서 일어나며, 범위를 벗어난 offset과 index는 무시한다. 같은 객체가 항목 조회
  (`getEntryAtIndex`, `length`, `getActiveIndex`)와 `canGoToOffset`도 제공하므로 이동 대상이 무엇인지 앱이 확인할 수 있다.
- Tauri 2와 wry의 WebView API에는 history 이동 API가 없다. 앱은 JavaScript `history.go`나 `history.back`을 직접 쓴다.
- WebView2의 `ICoreWebView2`는 `GoBack`, `GoForward`, `CanGoBack`, `CanGoForward`만 제공한다. 항목 목록이나 offset과
  index 이동 전용 메서드는 없다. 이 저장소의 Windows 호스트는 `CallDevToolsProtocolMethod` 바인딩을 이미 쓰므로 DevTools
  프로토콜의 탐색 history 메서드(`Page.getNavigationHistory`, `Page.navigateToHistoryEntry`)로 만들 수는 있다. 다만 이는
  WebView2의 안정된 API 계약이 아니라 Chromium 프로토콜에 기대는 경로다.
- 페이지 컨텍스트의 `history.go(n)`은 범위를 벗어난 값을 조용히 무시하고 결과가 비동기라 이동 성공 여부를 알 수 없다.
  이동을 시작했다는 `true`와 항목이 없다는 `false`를 구분하는 현재 `goBack` 계약과 맞지 않고, 오류 페이지처럼 스크립트를
  실행할 수 없는 문서에서는 동작하지 않는다.
- macOS 호스트(WKWebView)와 Android 호스트(WebView)의 기존 `goBack`, `goForward`도 같은 두 메서드만 노출한다. 네이티브
  WebView 쪽은 플랫폼마다 다르다. WKWebView는 항목 목록(`backForwardList`)과 항목 지정 이동을 제공하고, Android WebView는
  항목 목록과 함께 step 단위 이동(`goBackOrForward`)을 제공한다. 이 저장소는 둘 다 아직 쓰지 않는다.

## 결정

1. 호스트 API로 `goToOffset`, `goToIndex`, `canGoToOffset`을 추가하지 않는다. `getWebViewState`에도 history 길이나 현재
   index를 넣지 않는다. 이 결정은 Windows, macOS, Android 호스트 모두에 적용한다.
2. 여러 단계 이동이 필요한 앱은 `goBack`과 `goForward`를 반복한다. 호출은 이동을 시작했는지만 알려주므로, 앱은 탐색이
   끝난 뒤(`getWebViewState`의 `loading`과 `canGoBack`, `canGoForward`) 다음 호출을 한다.
3. 페이지가 직접 `history.go(n)`을 쓰는 것은 막지 않는다. 이는 렌더러 내부 동작이며 호스트 계약이 아니다.
4. 이동할 항목을 앱이 고를 필요가 있는 용도가 확인되면 history 조회와 함께 별도 결정에서 다룬다. 그때 플랫폼별 경로
   (WebView2는 DevTools 프로토콜, WKWebView는 항목 목록, Android WebView는 step 이동)를 함께 정한다.

## 근거

- 두 프레임워크가 다르다. Electron은 제공하고 Tauri는 제공하지 않는다. 쓰는 곳이 없는 기능을 위해 코어 API를 늘리지
  않는 쪽으로 Tauri를 따른다.
- 같은 범위의 동작을 제공하려면 플랫폼마다 다른 경로를 새로 만들어야 한다. WebView2는 DevTools 프로토콜, WKWebView는
  항목 목록, Android WebView는 step 이동이다. `history.go`만으로는 Electron과 같은 범위의 동작이 되지 않는다.
- 이 저장소에서 쓰는 곳이 없다. 기본 `goBack`과 `goForward`는 이미 이동 가능 여부를 정확히 반환하고, 여러 단계 이동은 이 두
  호출을 반복해 대신할 수 있다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 WebView 제어 문단에 offset과 index 이동이 없다는 점과 대안을 적는다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시한다. 탐색 history의 조회, 삭제, 초기화, 복원 항목은 이 결정 범위 밖이다.

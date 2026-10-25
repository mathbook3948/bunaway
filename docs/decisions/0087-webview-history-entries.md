---
status: accepted
---

# WebView 탐색 history의 조회, 삭제, 초기화와 복원은 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `01de66d6`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

WebView의 탐색 history 항목을 읽고, 지우고, 저장했다가 되살리는 API를 제공할지 정해야 했다. 현재는 `windows.goBack`,
`windows.goForward`와 `windows.getWebViewState`의 `canGoBack`, `canGoForward`만 제공한다. offset과 index 이동은
[ADR 0049](./0049-webview-history-offset-navigation.md)에서 제공하지 않기로 했다.

- Electron의 `webContents.navigationHistory`는 항목 조회(`getEntryAtIndex`, `getActiveIndex`, `length`), 전체 항목 조회,
  비우기와 복원을 제공한다. 복원은 저장해 둔 항목 배열과 활성 index로 탭 history를 다시 만든다.
- Tauri 2와 wry에는 history 항목 조회, 삭제, 복원 API가 없다. 앱은 자신이 알고 있는 URL을 기록해 둔다.
- WebView2의 `ICoreWebView2`는 `GoBack`, `GoForward`, `CanGoBack`, `CanGoForward`만 제공하며 항목 목록, 비우기, 복원
  메서드가 없다. 이 저장소의 Windows 호스트는 `CallDevToolsProtocolMethod` 바인딩을 이미 쓰므로 DevTools 프로토콜의
  `Page.getNavigationHistory`(항목 조회)와 `Page.resetNavigationHistory`(전체 비우기)로 조회와 전체 초기화는 만들 수 있다. 항목 하나만 지우는 메서드는 없다. 복원에
  해당하는 프로토콜 메서드는 없다. 항목을 순서대로 `Navigate`하면 항목마다 새 탐색이 쌓여 원래의 history 구조(항목별 스크롤
  위치, 폼 상태, POST 본문, 같은 문서 항목)를 되살리지 못한다.
- 조회가 필요한 앱은 UI(렌더러) 쪽에서 `location`과 탐색 이벤트로 항목 목록을 직접 쌓을 수 있다. 백엔드는 페이지 내 탐색을
  알리는 호스트 이벤트가 없으므로 UI가 기록해 필요하면 백엔드에 전달한다.
- macOS 호스트(WKWebView)는 `backForwardList`로 항목 조회를 지원하고 `interactionState`(macOS 12 이상)로 history를 포함한 상태를
  저장하고 복원할 수 있지만 비우기 API가 없고, 이 저장소는 아직 쓰지 않는다. Android WebView는 `copyBackForwardList`와 `saveState`, `restoreState`가 있지만 앱에 노출된 history API가 없다.
  플랫폼마다 가능한 범위가 달라 같은 계약으로 묶기 어렵다.

## 결정

1. 호스트 API로 history 항목 조회, 항목 삭제, 전체 초기화, 복원(저장과 되살리기)을 추가하지 않는다. `getWebViewState`에도
   history 길이, 현재 index, 항목 목록을 넣지 않는다. 이 결정은 `windows` 플러그인을 제공하는 Windows와 macOS 호스트에
   적용한다. Android는 앱에 노출된 history API가 없다.
2. 앱이 방문 목록을 보여 주거나 마지막 위치를 이어 가야 하면 자신이 URL을 기록한다(예: 저장소 플러그인에 마지막 URL을 쓰고
   다음 실행에서 `navigate`). 이렇게 복원한 화면은 새 탐색 하나이므로 이전 항목으로 돌아가는 `goBack`은 되살려지지 않는다.
3. 화면에 보이는 history와 별개인 브라우징 데이터(방문 기록 DB, 캐시, 쿠키)의 삭제는 이 결정 범위 밖이며 저장소 종류별
   삭제 결정에서 다룬다.
4. 항목 조회와 복원이 필요한 용도가 확인되면 offset과 index 이동([ADR 0049](./0049-webview-history-offset-navigation.md)의
   결정 4)과 함께 별도 결정에서 플랫폼별 경로(WebView2는 DevTools 프로토콜, WKWebView는 항목 목록과 `interactionState`)를 정한다. 복원은 WebView2에
   전용 경로가 없으므로 그때도 Windows에서 같은 의미로 제공할 수 있는지부터 확인한다.

## 근거

- Electron은 제공하고 Tauri는 제공하지 않아 두 프레임워크가 갈린다. 이 저장소에서 확인된 사용처가 없으므로 코어 API를 늘리지
  않는 Tauri 쪽을 따른다.
- 조회와 전체 초기화는 DevTools 프로토콜로 만들 수 있지만 복원은 만들 수 없다. 이 둘만 제공하면 Electron과 같은 저장과 복원
  흐름이 성립하지 않고, 복원을 흉내 내면 항목이 새 탐색으로 쌓여 의미가 달라진다. 반쪽 계약을 먼저 고정하지 않는다.
- 항목 id를 쓰는 DevTools 호출은 조회와 이동 사이의 history 변경을 다뤄야 하고, 앱이 같은 정보를 URL 기록으로 직접 쌓을 수
  있어 호스트가 맡을 이유가 약하다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 WebView 제어 문단에 history 항목 조회, 삭제, 복원이 없다는 점과 대안을 적는다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시한다.

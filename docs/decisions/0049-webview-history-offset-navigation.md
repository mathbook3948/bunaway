---
status: accepted
---

# WebView history의 offset과 index 이동은 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `ca54708d`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

WebView history에서 `goBack`, `goForward` 외에 offset 이동과 index 이동을 제공할지 정해야 했다. 현재는 `windows.goBack`,
`windows.goForward`와 `windows.getWebViewState`의 `canGoBack`, `canGoForward`만 제공한다.

- Electron의 `webContents.navigationHistory`는 `goToOffset(offset)`, `goToIndex(index)`, `canGoToOffset(offset)`과 항목 조회
  (`getEntryAtIndex(index)`, `getActiveIndex()`, `length()` 메서드)를 제공한다. 범위를 벗어난 이동은 아무 동작 없이 끝나고
  `getEntryAtIndex`는 `null`을 돌려준다.
- Tauri 2와 wry에는 offset과 index 이동 API가 없다. wry의 `WebView`에는 `go_back`, `go_forward`, `can_go_back`,
  `can_go_forward`가 있지만 Tauri는 이것도 공개하지 않는다. 앱은 JavaScript `history.go`나 `history.back`을 직접 쓴다.
- WebView2의 `ICoreWebView2`는 `GoBack`, `GoForward`, `CanGoBack`, `CanGoForward`만 제공한다. offset과 index 이동 전용
  메서드가 없다. 이 저장소의 Windows 호스트는 `CallDevToolsProtocolMethod` 바인딩을 이미 쓰므로 DevTools 프로토콜의
  탐색 history 메서드(`Page.getNavigationHistory`, `Page.navigateToHistoryEntry`)로 만들 수는 있다. WebView2 문서가 플랫폼에
  없는 기능에 안내하는 경로이지만, 이동 대상은 항목 index가 아니라 항목 id이므로 조회와 이동의 두 번 호출이 필요하다.
- 페이지 컨텍스트의 `history.go(n)`은 Electron의 `goToOffset(n)`과 이동 범위가 같다. 둘 다 같은 문서로 한정되지 않고
  탭 전체의 session history에서 offset만큼 이동하며 문서가 바뀌는 항목도 포함한다. 범위를 벗어난 값은 둘 다 아무 동작 없이
  끝난다. 차이는 실행 조건이다. `history.go(0)`은 현재 프레임 reload이고, `history.go`는 렌더러가 보내는 요청이라 문서가
  활성 상태가 아니거나 탐색이 이미 진행 중이면 무시될 수 있으며, 비동기라 성공 여부를 반환하지 않는다. `goToOffset`은 브라우저
  쪽에서 호출되어 이런 제한이 없다.
- macOS 호스트(WKWebView)도 `goBack`, `goForward`만 노출한다. Android 호스트는 앱에 노출된 history 이동 API가 없고 뒤로
  가기 키 처리에서만 `goBack`을 쓴다. 네이티브 WebView 쪽은 플랫폼마다 다르다. WKWebView는 항목 목록(`backForwardList`)과
  항목 지정 이동을 제공하고, Android WebView는 항목 목록과 함께 step 단위 이동(`goBackOrForward`)을 제공한다. 이 저장소는
  둘 다 아직 쓰지 않는다.

## 결정

1. 호스트 API로 `goToOffset`, `goToIndex`, `canGoToOffset`을 추가하지 않는다. `getWebViewState`에도 history 길이나 현재
   index를 넣지 않는다. 이 결정은 `windows` 플러그인을 제공하는 Windows와 macOS 호스트에 적용한다. Android는 앱에 노출된
   history 이동 API가 없다.
2. 여러 단계 이동이 필요한 앱은 `goBack`과 `goForward`를 반복한다. 호출은 이동을 시작했는지만 알려주며, 반환 직후의
   `getWebViewState`가 이동 결과를 반영한다고 보장하지 않는다. 이동 완료를 알리는 전용 신호는 아직 없으므로 연속 호출이 필요한
   앱은 페이지 쪽에서 확인할 수 있는 상태(예: 이동한 문서가 보내는 신호)를 기다린다.
3. offset 이동이 필요한 앱은 페이지에서 `history.go(n)`을 직접 쓴다. 이동 범위는 Electron의 `goToOffset`과 같다. 호스트의
   탐색 정책(origin 허용 목록)은 이 이동에도 그대로 적용된다.
4. 이동할 항목을 앱이 고를 필요가 있는 용도가 확인되면 history 조회와 함께 별도 결정에서 다룬다. 그때 플랫폼별 경로
   (WebView2는 DevTools 프로토콜, WKWebView는 항목 목록, Android WebView는 step 이동)를 함께 정한다.

## 근거

이동 범위는 `history.go`와 Electron의 `goToOffset`이 같다. 전용 API를 두지 않는 이유는 범위가 아니라 비용과 쓰임이다.

- Electron은 제공하고 Tauri는 제공하지 않아 두 프레임워크가 갈린다. 이 저장소에서 확인된 사용처가 없으므로 코어 API를 늘리지
  않는 Tauri 쪽을 따른다.
- WebView2에는 `GoToOffset`에 해당하는 네이티브 API가 없어 호스트가 만들 수 있는 경로는 둘이다. `ExecuteScript`로
  `history.go`를 감싸면 렌더러 요청의 제한(`history.go(0)`의 reload 의미, 비활성 문서와 진행 중인 탐색에서의 무시)을 호스트
  계약으로 정리해야 한다. DevTools 프로토콜 경로(`Page.getNavigationHistory`, `Page.navigateToHistoryEntry`)로 만들면 항목
  id를 쓰는 두 번 호출과 그 사이의 history 변경을 다뤄야 한다. 어느 쪽이든 쓰임이 확인되지 않은 기능에 비해 부담이 크다.
- 기본 `goBack`과 `goForward`는 이미 이동 가능 여부를 반환하고, 여러 단계 이동은 이 두 호출을 반복해 대신할 수 있다. 앱이
  offset 이동을 직접 원하면 페이지에서 `history.go`를 쓰면 된다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 WebView 제어 문단에 offset과 index 이동이 없다는 점과 대안을 적는다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시한다. 탐색 history의 조회, 삭제, 초기화, 복원 항목은 이 결정 범위 밖이다.

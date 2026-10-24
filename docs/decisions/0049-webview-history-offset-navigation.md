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
  index 이동에 대응하는 네이티브 API가 없다. 그래서 Windows에서는 페이지 컨텍스트의 `history.go(n)`으로만 흉내 낼 수 있다.
- `history.go(n)`은 호출한 문서의 joint session history 안에서 움직이며, 범위를 벗어난 값은 조용히 무시되고 결과가
  비동기라 이동 성공 여부를 알 수 없다. 이동을 시작했다는 `true`와 항목이 없다는 `false`를 구분하는 현재 `goBack`
  계약과 맞지 않는다. 또 `about:blank`, 오류 페이지, 스크립트가 막힌 문서처럼 스크립트를 실행할 수 없는 상태에서는
  동작하지 않으며, 호스트가 주입하는 스크립트에 기대게 된다.
- index 이동은 현재 항목 위치와 항목 수를 알아야 한다. 이 정보는 WebView2에 없고 `history.length`는 현재 위치를
  알려주지 않으므로 항목 조회 없이는 안정적으로 만들 수 없다.

## 결정

1. `windows.goToOffset`, `windows.goToIndex`와 `canGoToOffset`을 추가하지 않는다. `getWebViewState`에도 history 길이나
   현재 index를 넣지 않는다.
2. 여러 단계 이동이 필요한 앱은 `goBack`과 `goForward`를 반복하고, 매번 반환값과 `canGoBack`, `canGoForward`로 끝을
   확인한다.
3. 페이지가 직접 `history.go(n)`을 쓰는 것은 막지 않는다. 이는 렌더러 내부 동작이며 호스트 계약이 아니다.
4. WebView2에 항목 목록이나 offset 이동 API가 생기거나, 위 방법으로 만들 수 없는 용도가 확인되면 history 조회와 함께
   별도 결정에서 다룬다.

## 근거

- 두 프레임워크가 다르다. Electron은 제공하고 Tauri는 제공하지 않는다. Electron의 offset과 index 이동은 항목 조회와
  범위 확인이 한 묶음이라 의미가 정해지는데, WebView2에는 그 기반이 없다. `history.go`만으로는 이동 가능 여부와 성공
  여부를 알 수 없어 Electron과 같은 범위의 동작이라고 할 수 없다. 이 차이를 숨기고 같은 이름의 API를 두면 앱이
  Electron과 같은 결과를 기대하고 Windows에서만 조용히 무시되는 경우가 생긴다.
- 쓰는 곳이 없는 기능을 위해 네이티브 우회 경로와 스크립트 주입을 코어에 들이지 않는다. 기본 `goBack`과 `goForward`는
  이미 가능 여부를 정확히 반환한다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 WebView 제어 문단에 offset과 index 이동이 없다는 점과 대안을 적는다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시한다. 탐색 history의 조회, 삭제, 초기화, 복원 항목은 이 결정 범위 밖이다.

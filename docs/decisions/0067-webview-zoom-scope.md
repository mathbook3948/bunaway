---
status: accepted
---

# WebView zoom 범위 설정을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `94fa3d36`.

## 배경

zoom factor를 origin별로 공유할지 WebView별로 독립 관리할지 고르는 설정을 제공할지 정해야 했다.

- 이 저장소의 `setZoomFactor`와 `getWebViewState`의 `zoomFactor`는 Windows 호스트가 WebView2 컨트롤러의
  `put_ZoomFactor`, `get_ZoomFactor`로 읽고 쓴다(`native/windows/bun/webview.ts`). 값은 컨트롤러에 속하며, 허용 범위는 0.25에서 5이다.
- 창 하나에 WebView 하나만 두고(ADR 0026) 탐색은 앱의 허용 origin 안으로 제한한다. 한 WebView가 서로 다른 origin을 오가는 경로가
  없으므로 "origin별 공유"와 "WebView별 독립"은 앱이 관찰할 수 있는 차이를 만들지 않는다.
- 호스트는 zoom 단축키와 Ctrl+휠을 끈다(ADR 0064). 앱이 `setZoomFactor`로 정한 값만 zoom을 바꾼다.
- Windows CI(`tests/lifecycle/windows-webview-controls.ts`)가 같은 origin 안의 탐색, 뒤로와 앞으로 이동, reload, 중단 뒤 재탐색에서
  설정한 zoom factor가 유지되는 것을 확인한다.

## 결정

1. zoom 범위(origin별 공유 또는 WebView별 독립)를 고르는 설정을 추가하지 않는다. zoom factor는 WebView 컨트롤러의 값이며
   같은 WebView의 탐색, history 이동과 reload에서 유지된다.
2. 앱이 창을 다시 만든 뒤에도 같은 값이 필요하면 앱이 값을 저장하고 새 WebView가 준비된 뒤 `setZoomFactor`로 적용한다.
   호스트는 zoom factor를 디스크에 저장하지 않는다.
3. 한 창에 여러 WebView를 두거나 WebView가 여러 origin을 오가게 하는 결정이 따로 나오면, 그때 이 결정을 다시 연다.

## 근거

- 설정이 고를 수 있는 두 동작이 현재 계약에서 구분되지 않는다. 구분되지 않는 설정을 위해 스키마와 코어 계약을 늘리지 않는다.
- 앱 저장이 필요한 값의 보존 범위(앱 데이터, 사용자별 설정)는 앱이 정하는 일이며 기존 저장소 플러그인으로 다룰 수 있다.
- 이 결정은 현재 계약(창 하나에 WebView 하나, 허용 origin 안의 탐색)과 Windows CI 결과에 근거한다.

## 결과

- 스키마, 이벤트, 권한과 네이티브 코드 변경은 없다.
- Windows CI의 WebView 제어 시나리오에 탐색 뒤 zoom factor 유지 단언을 추가한다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

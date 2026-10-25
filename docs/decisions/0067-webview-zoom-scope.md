---
status: accepted
---

# WebView zoom 범위 설정을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `94fa3d36`.

## 배경

zoom factor를 origin별로 공유할지 WebView별로 독립 관리할지 고르는 설정을 제공할지 정해야 했다.

- 이 저장소의 `setZoomFactor`와 `getWebViewState`의 `zoomFactor`는 Windows 호스트가 WebView2 컨트롤러의
  `put_ZoomFactor`, `get_ZoomFactor`로 읽고 쓴다(`native/windows/bun/webview.ts`). 허용 범위는 0.25에서 5이다.
- 창 하나에 WebView 하나이고(ADR 0026) 탐색은 앱 정의의 `origins`(최대 16개) 안으로 제한된다. 한 WebView가 허용 origin 여러 개를 오갈 수 있다.
- origin 사이를 이동할 때 zoom 값이 어떻게 되는지는 WebView2의 동작을 따르며 이 저장소가 정하지 않는다.
  `windows.mdx`는 이미 이 API가 origin별 공유 정책을 추가하지 않고 현재 값을 다시 조회하도록 안내한다.
- 호스트는 zoom 단축키와 Ctrl+휠을 끈다(ADR 0064). 핀치 zoom은 호스트가 설정하지 않아 WebView2 기본값을 따르고 이 계약에 포함하지 않는다.
  그 밖에는 앱이 `setZoomFactor`로 정한 값만 zoom을 바꾼다.
- Windows CI(`tests/lifecycle/windows-webview-controls.ts`)는 허용 origin이 하나인 앱에서 같은 origin 안의 탐색,
  뒤로와 앞으로 이동, reload 뒤 zoom factor가 유지되는지 단언한다. 여러 origin 사이의 이동은 검증하지 않는다.

## 결정

1. zoom 범위(origin별 공유 또는 WebView별 독립)를 고르는 설정을 추가하지 않는다. 호스트는 WebView2 컨트롤러의 zoom factor를 설정하고
   조회할 뿐 별도 정책을 얹지 않는다.
2. 앱은 탐색 뒤 필요하면 `getWebViewState`로 현재 값을 다시 조회하고, 원하는 값이 다르면 `setZoomFactor`로 다시 적용한다.
   창을 다시 만든 뒤에도 같은 값이 필요하면 앱이 값을 저장했다가 적용한다. 호스트는 zoom factor를 디스크에 저장하지 않는다.
3. origin 사이 이동에서 값을 고정해야 하는 앱이 확인되면 별도 결정에서 다룬다. 그때는 설정이 아니라 호스트가 탐색 뒤 값을 다시 적용하는 방식을 먼저 검토한다.

## 근거

- 두 범위 중 하나를 강제하려면 호스트가 탐색마다 값을 추적하고 다시 적용해야 한다. 쓰는 곳이 확인되지 않은 정책을 위해 코어 계약과 스키마를 늘리지 않는다.
- 값의 보존 범위(앱 데이터, 사용자별 설정)는 앱이 정하는 일이며 저장소 플러그인으로 다룰 수 있다.

## 결과

- 스키마, 이벤트, 권한과 네이티브 코드 변경은 없다.
- Windows CI의 WebView 제어 시나리오에 같은 origin 안의 탐색, history 이동, reload 직후 zoom factor 단언을 추가한다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

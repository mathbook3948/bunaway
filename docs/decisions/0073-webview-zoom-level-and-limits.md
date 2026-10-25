---
status: accepted
---

# WebView zoom level과 visual zoom 한도 API를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `42fdd220`.

## 배경

zoom을 로그 단위 level로 설정하고 조회하는 API와, 핀치 같은 visual zoom의 최소와 최대 한도를 설정하는 API를 제공할지 정해야 했다.

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

- Electron의 `webContents`는 배율을 직접 쓰는 `setZoomFactor`와 `getZoomFactor`, 로그 단위의 `setZoomLevel`과 `getZoomLevel`,
  핀치 zoom의 한도를 정하는 `setVisualZoomLevelLimits(minimumLevel, maximumLevel)`을 제공한다.
- Tauri 2의 `Webview`와 `WebviewWindow`는 배율을 쓰는 `setZoom(scale)`만 제공한다. level과 visual zoom 한도 API는 없다.
- 이 저장소의 `windows.setZoomFactor`와 `getWebViewState`의 `zoomFactor`는 WebView2 컨트롤러의 `put_ZoomFactor`,
  `get_ZoomFactor`로 읽고 쓴다(`native/windows/bun/webview.ts`). 입력은 0.25 이상 5 이하이며 스키마(`plugins/windows/src/contract.ts`)와
  호스트가 같은 범위로 검사한다. 범위를 벗어나면 `INVALID_ARGUMENT`이다.
- 로그 단위 level은 배율과 일대일로 변환된다(Chromium 기준 배율 = 1.2의 level 제곱). 별도 상태가 아니므로 배율을 쓰는 API로
  같은 값을 표현할 수 있다.
- visual zoom 한도에 대응하는 WebView2 컨트롤러 항목이 이 저장소가 쓰는 API 범위에는 없다. 호스트는 zoom 단축키와 Ctrl+휠을 끄고
  (ADR 0064), 핀치 zoom은 설정하지 않아 WebView2 기본값을 따른다. 그 밖에는 앱이 `setZoomFactor`로 정한 값만 zoom을 바꾼다.

## 결정

1. zoom level을 설정하거나 조회하는 API를 추가하지 않는다. 앱은 `setZoomFactor`와 `getWebViewState`의 `zoomFactor`를 쓰고,
   level이 필요하면 앱 코드에서 `Math.log(factor) / Math.log(1.2)`로 변환한다.
2. visual zoom의 최소와 최대 한도 API를 추가하지 않는다. 한도를 나타내는 설정이 호스트에 없으므로 핀치 zoom 범위는 WebView2 기본값을 따르며
   이 계약에 포함하지 않는다.
3. 앱이 배율 범위를 0.25에서 5보다 좁혀야 하면 앱이 `setZoomFactor`에 넘기는 값을 clamp한다. 호스트의 0.25에서 5 검사는 바꾸지 않는다.
4. 핀치 zoom을 막아야 하는 앱이 확인되면 한도 API가 아니라 별도 결정에서 on/off 설정을 먼저 검토한다.

## 근거

- 두 프레임워크가 다르다. Electron은 level과 visual zoom 한도를 제공하고 Tauri는 배율만 제공한다. level은 배율과 같은 값을 다른 단위로 표현할 뿐이라
  API를 둘로 늘리는 이득이 없다. 코어는 작게 유지하고 쓰는 곳이 확인되지 않은 계약을 늘리지 않는다.
- visual zoom 한도는 대응하는 호스트 수단이 없어 약속할 수 없다. 약속하지 못하는 한도 값을 받으면 실제 동작과 계약이 어긋난다.
- 배율 범위의 하한과 상한은 이미 스키마와 호스트가 같은 값으로 검사하므로, 더 좁은 범위는 앱이 값을 정하는 시점에 적용하면 된다.

## 결과

- 스키마, 이벤트, 권한과 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

---
status: accepted
---

# WebView zoom level과 visual zoom 한도 API를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `42fdd220`.

## 배경

zoom을 로그 단위 level로 설정하고 조회하는 API와, 핀치 같은 visual zoom의 최소와 최대 한도를 설정하는 API를 제공할지 정해야 했다.

아래 Electron v45.0.0, Tauri 2.12.5, WebView2 SDK 1.0.4314.35 서술은 해당 버전의 공개 문서와 소스를 확인한 것이며 이 저장소의 테스트로 검증한 것은 아니다.

- Electron의 `webContents`는 배율을 직접 쓰는 `setZoomFactor`와 `getZoomFactor`, 로그 단위의 `setZoomLevel`과 `getZoomLevel`,
  핀치 zoom의 한도를 정하는 `setVisualZoomLevelLimits(minimumLevel, maximumLevel)`을 제공한다. 이 함수의 level은 로그 단위가 아니라
  page scale 배율(1이 원래 크기)이며 `setZoomLevel`의 level과 단위가 다르다. Electron은 visual zoom을 기본으로 끈다.
- Tauri 2의 `Webview`와 `WebviewWindow`는 배율을 쓰는 `setZoom(scaleFactor)`만 제공한다. level, zoom 조회, visual zoom 한도 API는 없다.
- 이 저장소의 `windows.setZoomFactor`와 `getWebViewState`의 `zoomFactor`는 WebView2 컨트롤러의 `put_ZoomFactor`,
  `get_ZoomFactor`로 읽고 쓴다(`native/windows/bun/webview.ts`). 입력은 0.25 이상 5 이하이며 스키마(`plugins/windows/src/contract.ts`)와
  호스트가 같은 범위로 검사한다. 범위를 벗어나면 `INVALID_ARGUMENT`이다.
- Electron 문서는 `setZoomLevel`의 level을 `scale := 1.2 ^ level`로 정의한다. 별도 상태가 아니라 같은 값의
  다른 단위이므로 배율을 쓰는 API로 표현할 수 있다.
- WebView2 SDK 1.0.4314.35의 zoom 관련 호스트 API는 컨트롤러의 `ZoomFactor`와 `ZoomFactorChanged`, `SetBoundsAndZoomFactor`, 설정의
  `IsZoomControlEnabled`와 `IsPinchZoomEnabled`(켜고 끔만)뿐이며 visual zoom 한도에 대응하는 것은 없다. 호스트는 zoom 단축키와 Ctrl+휠을 끄고
  (ADR 0064), 핀치 zoom은 설정하지 않아 WebView2 기본값을 따른다. 그 밖에는 앱이 `setZoomFactor`로 정한 값만 zoom을 바꾼다.

## 결정

1. zoom level을 설정하거나 조회하는 API를 추가하지 않는다. 앱은 `setZoomFactor`와 `getWebViewState`의 `zoomFactor`를 쓰고,
   level이 필요하면 앱이 위 대응식(예: `Math.log(factor) / Math.log(1.2)`)으로 변환한다. 이 변환은 호스트가 검증하지 않는다.
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

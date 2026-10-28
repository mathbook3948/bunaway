---
status: accepted
---

# 요소 검사와 worker DevTools 열기 API는 제공하지 않는다

결정일: 2026-10-28. 검토 기준: main `5832b295`.

## 배경

화면 좌표의 요소를 DevTools에서 검사하는 기능과 service worker, shared worker를 DevTools에서 여는 기능을 API로 제공할지 정해야 했다.

아래 외부 동작은 Electron v45.0.0, Tauri 2.12.5(wry 0.57.1), WebView2 SDK 1.0.4314.35 기준의 공식 문서와 해당 태그의 소스에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다. 문서에 없는 부분은 추론이라고 표시한다.

- Electron의 `webContents.inspectElement(x, y)`는 DevTools를 열고 해당 좌표의 요소를 선택한다. DevTools가 닫혀 있으면 먼저 연다. `webContents.inspectSharedWorker()`와 `inspectSharedWorkerById(id)`는 shared worker 대상의 DevTools를 열고, `inspectServiceWorker()`는 service worker 대상의 DevTools를 연다. `inspectSharedWorkerById(id)`의 식별자는 앱이 `getAllSharedWorkers()`로 얻는다.
- Tauri는 `WebviewWindow`의 `open_devtools`, `close_devtools`, `is_devtools_open`만 제공한다. 좌표 검사나 worker 대상 열기 API는 없다.
- WebView2는 `ICoreWebView2::OpenDevToolsWindow`로 DevTools 창을 열 수 있다. 좌표를 받는 검사 API와 worker를 대상으로 DevTools를 여는 API는 없다. 요소 선택(inspect mode)과 worker 대상 선택은 Chromium DevTools 창 안의 기능이며, 열린 DevTools에서 사용자가 직접 고른다. 임의 좌표를 호스트가 지정하려면 DevTools 프로토콜(`DOM`, `Overlay`)을 호출해야 한다고 본다(추론).
- 이 저장소의 Windows 호스트는 개발 도구를 켠 빌드에서만 WebView2 `AreDevToolsEnabled`와 브라우저 가속키(`AreBrowserAcceleratorKeysEnabled`)를 켠다. 기본 context menu(`AreDefaultContextMenusEnabled`)는 항상 끄므로([ADR 0064](./0064-webview-browser-default-ui.md)) 우클릭 "검사" 항목은 없다. `windows.openDevTools`는 개발 모드와 작업 권한이 모두 있을 때만 DevTools 창을 연다.
- worker의 조회, 시작, IPC와 console 이벤트는 제공하지 않기로 이미 정했다([ADR 0086](./0086-webview-workers-and-session-preload.md)). 이 결정은 그 결정이 다루지 않은 "DevTools 열기"만 다룬다.
- 제품 빌드에서 DevTools를 여는 경로는 없고, DevTools 프로토콜 직접 호출의 제공 여부는 `docs/TODO-windows.md`의 debugger protocol 항목에서 따로 정하며, 이 결정은 그 결과와 관계없이 성립한다. 호스트는 이미 내부에서 DevTools 프로토콜 호출을 쓰고 있어 구현 수단은 있고, 공개 operation으로 노출할지가 그 항목의 미결 사항이다.

## 결정

1. 좌표 기반 요소 검사 API(`inspectElement` 대응)를 제공하지 않는다.
2. service worker와 shared worker 대상으로 DevTools를 여는 API(`inspectServiceWorker`, `inspectSharedWorker` 대응)를 제공하지 않는다.
3. 개발 모드에서 요소와 worker를 검사하는 경로는 `windows.openDevTools`(또는 개발 도구를 켠 빌드의 `F12`, `Ctrl+Shift+I`)로 DevTools를 연 뒤 DevTools 안에서 Chromium의 요소 선택(`Ctrl+Shift+C`)과 worker 대상 선택을 쓰는 것이다. 프로덕션 호스트는 이 경로가 없으며 이 결정으로 바뀌지 않는다.
4. 개발 모드에서 기본 context menu를 켜 우클릭 "검사"를 허용하는 설정은 이 결정에 포함하지 않는다. ADR 0064의 고정값이 계약이며, 필요가 확인되면 별도 결정에서 다룬다.
5. 사용처가 확인되면 별도 결정에서 다시 연다. 다시 열 때 정할 것은 좌표 입력의 좌표계(창 client, 화면, DPI), 프로덕션 빌드에서의 거부 규칙이다. worker 대상 열기는 worker 조회를 제공하지 않기로 한 ADR 0086 결정 3을 먼저 다시 열어야 하며, 이 결정만으로는 열 수 없다.

## 근거

- 두 프레임워크가 다르다. Electron은 `inspectElement`, shared worker 검사 둘, `inspectServiceWorker`를 제공하고 Tauri는 DevTools 열기와 닫기만 제공한다. 이 결정은 Tauri와 같은 쪽이다. WebView2에는 대응 API가 없어, 구현하려면 DevTools 프로토콜 호출을 공개 operation으로 노출해야 하고, 그것은 debugger protocol 항목이 다루는 범위다. `inspectSharedWorkerById`는 식별자를 얻는 조회 API가 선행되어야 하는데 그 API도 제공하지 않기로 했다(ADR 0086).
- 이 기능들은 사람이 DevTools 화면을 보며 쓰는 개발 보조이고, 앱 코드가 호출해 얻는 결과가 없다. 앱이 좌표를 알고 있어야 하는 호출 경로(Electron에서는 주로 context menu의 "Inspect Element")는 이 저장소의 메뉴 플러그인으로 앱 메뉴 항목을 만들 수 있으나 그 항목은 `openDevTools`로 DevTools를 열 뿐 클릭한 요소를 고르지 못한다. 요소 검사는 `openDevTools`로 DevTools를 연 뒤 사용자가 `Ctrl+Shift+C`로 요소를 직접 고르는 우회 경로가 있다. 클릭한 좌표의 요소를 자동으로 선택하는 기능은 잃으며, 우클릭 검사 흐름도 결정 4에 따라 없다. `F12`, `Ctrl+Shift+I`, `Ctrl+Shift+C` 동작과 DevTools 안의 선택 기능은 WebView2와 Chromium DevTools 기준이며 이 저장소의 테스트로 검증하지 않았다. 저장소가 확인하는 것은 개발 모드에서 `AreDevToolsEnabled`와 브라우저 가속키 설정이 켜진다는 점까지다.
- 코어는 작게 둔다. 호출하는 곳이 없는 API를 위해 operation, 권한, 스키마를 늘리지 않는다. 개발 모드 한정 기능이어서 프로덕션 보안 경계는 바뀌지 않는다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.
- `windows.mdx`의 `openDevTools` 설명에 요소와 worker 검사는 열린 DevTools 안에서 한다는 한 문장을 더한다.

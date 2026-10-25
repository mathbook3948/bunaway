---
status: accepted
---

# WebView 오프라인, latency, bandwidth emulation을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `42fdd220`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

앱이 WebView의 네트워크를 오프라인으로 만들거나 지연과 처리량을 제한하는 emulation API를 제공할지 정해야 했다.

- Electron은 `session.enableNetworkEmulation({ offline, latency, downloadThroughput, uploadThroughput })`와
  `session.disableNetworkEmulation()`을 제공한다. 세션 단위로 적용되어 그 세션을 쓰는 모든 WebContents에 영향을 준다.
- Tauri와 wry는 같은 기능을 제공하지 않는다. 앱이 필요하면 `Webview::with_webview`가 넘겨주는 WebView2 객체로 직접 구현한다.
- WebView2에는 전용 설정이 없고, DevTools 프로토콜의 `Network.emulateNetworkConditions`를 `CallDevToolsProtocolMethod`로 호출해야 한다.
  이 설정은 호출한 WebView의 대상(target)에 적용되며 같은 프로필의 다른 WebView에는 영향을 주지 않는다. 호스트는 선언 뷰마다 앱 데이터 아래의
  프로필 하나를 쓰고([ADR 0016](./0016-window-creation-contract.md)) 창 하나에 WebView 하나를 둔다([ADR 0026](./0026-single-webview-single-window.md)).
  Electron의 세션 단위 emulation은 같은 세션의 모든 WebContents에 걸리지만, 대상 단위 호출은 호출한 WebView에만 걸리므로 의미가 다르다.
- 이 저장소는 `network.isOnline`과 `network.onlineChanged`로 운영체제의 활성 인터페이스 유무를 알려 준다. emulation이 같은 이름의
  "오프라인"을 페이지에만 적용하면 두 값이 어긋나고, 앱 백엔드의 `network.request`는 emulation의 영향을 받지 않는다.
  백엔드와 페이지가 서로 다른 네트워크 상태를 보게 된다.
- 오프라인과 느린 네트워크 상태에서 앱을 확인하는 용도는 `--devtools`로 여는 개발 모드 DevTools의 Network 탭 throttling이
  이미 맡는다. 배포 앱이 사용자에게 네트워크를 제한할 이유는 확인되지 않았다.
- 앱 코드가 emulation을 켠 채 종료하거나 비정상 종료하면 다음 실행의 상태가 어떻게 되는지 정해야 한다. DevTools 프로토콜의 설정은
  WebView 수명에 묶이므로 재생성과 탐색 뒤 재적용 규칙, 여러 WebView 사이의 일관성도 계약으로 정해야 한다.

## 결정

1. 오프라인, latency, bandwidth emulation API를 추가하지 않는다.
2. 개발 중 확인은 `--devtools`의 DevTools Network throttling을 쓴다. 앱 로직의 오프라인 처리는 `network.isOnline`과
   `network.onlineChanged`, 페이지의 `navigator.onLine`과 `online`, `offline` 이벤트로 확인한다.
3. 배포 앱에서 WebView 트래픽을 제한해야 하는 요구가 확인되면 별도 결정에서 다룬다. 이때 적용 범위(WebView 또는 프로필),
   재생성과 탐색 뒤 재적용, `network.request`와의 관계를 먼저 정한다.

## 근거

- Electron만 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는 쪽을 따른다. 쓰는 곳이 없다
  (`plugins`, `packages`, `examples`에서 emulation을 요구하는 코드는 없다).
- 호스트에는 `CallDevToolsProtocolMethod` 바인딩이 이미 있어 호출 자체는 추가할 수 있다. 문제는 적용 범위다. 적용 범위가
  Electron(세션)과 WebView2(대상)에서 달라 같은 이름의 API가 다른 범위를 약속하고, 재생성과 탐색 뒤 재적용 규칙도 새로 정해야 한다.
- 개발 모드 DevTools가 같은 확인 수단을 이미 제공한다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

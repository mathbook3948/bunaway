---
status: accepted
---

# WebView 오프라인, latency, bandwidth emulation을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `42fdd220`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.
기준은 Electron v45.0.0(Chromium 156.0.8078.48), Tauri 2.12.5, wry 0.57.1이다. WebView2의 범위와 수명은 Microsoft 문서가 아니라
Chromium 소스에서 추론한 것이고 WebView2 런타임에서 확인하지 않았다.

앱이 WebView의 네트워크를 오프라인으로 만들거나 지연과 처리량을 제한하는 emulation API를 제공할지 정해야 했다.

- Electron은 `session.enableNetworkEmulation({ offline, latency, downloadThroughput, uploadThroughput })`와
  `session.disableNetworkEmulation()`을 제공한다. 문서상 범위는 세션이다. 다만 v45.0.0 소스를 읽으면 세션이 만든 emulation 토큰은
  네트워크 컨텍스트에 조건을 거는 호출에만 쓰이고 어떤 요청의 `throttling_profile_id`로도 설정되지 않는다. 같은 원인은 2019년에
  electron/electron#21250에서 Electron 메인테이너가 분석했고(Electron 4 이상 기준), 그 이슈는 고쳐지지 않은 채 2022년에 자동으로 닫혔다.
  따라서 문서가 약속하는 동작이 실제로 동작하지 않을 가능성이 높으며, 이 저장소에서 실행으로 확인하지는 않았다.
- Tauri와 wry에는 같은 기능이 없다. Tauri 2.12.5와 wry 0.57.1의 소스를 각각 검색했고(`tauri-runtime-wry`는 wry 0.57.0에 의존한다),
  `CallDevToolsProtocolMethod` 래퍼도 없다. 앱이 필요하면 `Webview::with_webview`가 넘겨주는 `PlatformWebview`에서 Windows는 `controller()`로
  얻는 `ICoreWebView2Controller`에서 `CoreWebView2`를 따로 얻어 직접 호출해야 한다.
- WebView2에는 전용 설정이 없고, DevTools 프로토콜의 `Network.emulateNetworkConditions`를 `CallDevToolsProtocolMethod`로 호출해야 한다.
  이 메서드는 Chromium 156 프로토콜 정의에서 deprecated이고 `emulateNetworkConditionsByRule`과 `overrideNetworkState`로 대체되었다.
  Chromium 소스상 이 설정은 호출한 WebView의 최상위 page target(같은 local frame root의 frame)에 적용되고 같은 프로필의 다른 WebView에는
  영향을 주지 않는다. cross-origin iframe과 worker는 별도 target이라 `CallDevToolsProtocolMethodForSession`으로 따로 걸어야 한다. 창 하나에 WebView 하나와
  프로필 하나를 두므로([ADR 0026](./0026-single-webview-single-window.md), [ADR 0016](./0016-window-creation-contract.md))
  한 WebView가 한 프로필을 쓴다.
  Electron이 문서로 약속하는 세션 단위 emulation은 같은 세션의 WebContents 전체에 걸리지만, 대상 단위 호출은 호출한 WebView에만 걸리므로 의미가 다르다.
- 이 저장소는 `network.isOnline`과 `network.onlineChanged`로 운영체제의 활성 인터페이스 유무를 알려 준다. emulation이 같은 이름의
  "오프라인"을 페이지에만 적용하면 두 값이 어긋나고, 앱 백엔드의 `network.request`는 emulation의 영향을 받지 않는다.
  백엔드와 페이지가 서로 다른 네트워크 상태를 보게 된다.
- 개발 중에 느린 네트워크를 보려면 Windows x64의 `bunaway dev`가 여는 DevTools의 Network 탭을 쓸 수 있다
  ([디버깅 가이드](../site/src/content/docs/guides/debugging.mdx)). macOS의 DevTools 연결은 제공하지 않으므로 이 수단은 Windows에만 있다.
  배포 앱이 사용자에게 네트워크를 제한할 이유는 확인되지 않았다.
- Chromium 소스상 DevTools 프로토콜의 조건은 DevTools 세션에 묶이고(WebView2 문서에는 없다) 네트워크 서비스의 메모리에만 있어, 종료나
  비정상 종료 뒤 다음 실행에 남지 않는 것으로 보인다. 일반 탐색 뒤에는 대개 재적용이 필요 없을 것으로 보이지만(추론) prerender activation처럼
  토큰이 바뀌는 경우와 WebView를 다시 만드는 경우에는 다시 걸어야 하고, WebView2가 DevTools 세션을 WebView보다 먼저 끝내는 경우가 있는지는
  확인하지 못했다. 재적용 규칙과 여러 WebView 사이의 일관성은 계약으로 정해야 한다.

## 결정

1. 오프라인, latency, bandwidth emulation API를 추가하지 않는다.
2. 대체 수단은 안내하지 않고 개발 중 Windows의 DevTools Network 탭만 언급한다. 운영체제 수준의 온라인 상태는 `network.isOnline`과
   `network.onlineChanged`로 알 수 있으며, 이 값은 페이지에 건 emulation으로 바뀌지 않는다.
3. 배포 앱에서 WebView 트래픽을 제한해야 하는 요구가 확인되면 별도 결정에서 다룬다. 이때 적용 범위(WebView 또는 프로필),
   재생성 뒤 재적용, `network.request`와의 관계를 먼저 정하고, 대체된 `emulateNetworkConditionsByRule`과 `overrideNetworkState`를 기준으로 삼는다.

## 근거

- Electron만 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는 쪽을 따른다. 쓰는 곳이 없다
  (`plugins`, `packages`, `examples`에서 emulation을 요구하는 코드는 없다).
- 호스트에는 `CallDevToolsProtocolMethod` 바인딩이 이미 있어 호출 자체는 추가할 수 있다. 문제는 적용 범위다. 적용 범위가
  Electron(문서상 세션)과 WebView2(대상)에서 달라 같은 이름의 API가 다른 범위를 약속하고, 재생성 뒤 재적용 규칙도 새로 정해야 한다.
  호출할 프로토콜 메서드도 deprecated라 지금 고르면 곧 바뀐다.
- Windows 개발 모드의 DevTools가 느린 네트워크를 확인하는 수단을 제공한다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

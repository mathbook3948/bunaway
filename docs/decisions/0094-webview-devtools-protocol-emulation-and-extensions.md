---
status: accepted
---

# WebView DevTools 프로토콜 연결, 장치 emulation, DevTools 창 설정과 개발 도구 확장은 제공하지 않는다

결정일: 2026-10-26. 검토 기준: main `d85b91f1`.

## 배경

앱이 WebView의 DevTools 프로토콜에 연결해 명령을 실행하고 이벤트를 받는 기능, 뷰포트와 화면 배율과 입력을 흉내 내는 장치
emulation, DevTools의 workspace와 dock 위치와 별도 창과 title 설정, 개발 도구 확장의 설치와 실행 범위를 제공할지 정해야 했다.

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.
기준은 Electron v45.0.0, Tauri 2.12.5, wry 0.57.1이다.

- Electron은 `webContents.debugger`로 `attach`, `detach`, `sendCommand`와 `message` 이벤트를 제공해 앱이 DevTools 프로토콜을 직접 쓰게 한다.
  장치 emulation은 `webContents.enableDeviceEmulation(parameters)`와 `disableDeviceEmulation()`이 있고 `screenPosition`, `screenSize`,
  `viewPosition`, `deviceScaleFactor`, `viewSize`, `scale`을 받는다. DevTools 창은 `openDevTools`의 `mode`(`left`, `right`, `bottom`,
  `undocked`, `detach`)와 `title` 옵션으로 정하고, workspace 추가와 제거는 공개 API가 아니다.
  확장은 `session.extensions`를 쓰며 [ADR 0070](./0070-webview-browser-extensions.md)이 다룬다.
- Tauri와 wry에는 같은 기능이 없다. Tauri 2.12.5는 `Webview::open_devtools`, `close_devtools`, `is_devtools_open`만 제공하고 프로토콜 연결,
  emulation, dock 위치, title 설정은 없다. 앱이 필요하면 `Webview::with_webview`가 넘겨 주는 `PlatformWebview`에서 직접 WebView2를 호출해야 한다.
- WebView2는 `ICoreWebView2::CallDevToolsProtocolMethod`와 `GetDevToolsProtocolEventReceiver`로 프로토콜을 연다. DevTools 창은
  `OpenDevToolsWindow`가 열 뿐이고 dock 위치, title, workspace를 정하는 설정은 `CoreWebView2Settings`에 없다.
- 이 저장소의 Windows 호스트는 `CallDevToolsProtocolMethod` 바인딩을 이미 가지고 있다(`native/windows/bun/webview-devtools.ts`).
  호스트가 자기 스크립트를 실행하는 `Runtime.evaluate` 호출에만 쓰며 앱에는 노출하지 않는다. 이 호출은 `AreDevToolsEnabled`가 꺼져 있어도
  동작한다. 그 설정은 브라우저 UI만 막기 때문이다.
- 현재 앱이 쓸 수 있는 것은 `windows.openDevTools`뿐이다. 작업 권한과 호스트의 개발 모드 설정이 모두 필요하고, 프로덕션 호스트는 작업 권한이 있어도
  `PERMISSION_DENIED`다. 백엔드는 `bunaway dev --inspect`로 디버거에 연결한다([디버깅 가이드](../site/src/content/docs/guides/debugging.mdx)).

## 결정

1. 앱에 DevTools 프로토콜 연결, 명령 실행, 이벤트 수신 API를 추가하지 않는다. `CallDevToolsProtocolMethod` 바인딩은 호스트 내부에만 둔다.
2. 뷰포트, 화면 배율, 입력 장치 emulation API를 추가하지 않는다. 개발 중에는 `windows.openDevTools`가 여는 DevTools의 장치 모드를 쓴다.
3. DevTools workspace, dock 위치, 별도 창, title 설정 API를 추가하지 않는다. WebView2가 설정을 노출하지 않는다.
4. 개발 도구 확장의 설치와 실행 범위를 제공하지 않는다. [ADR 0070](./0070-webview-browser-extensions.md)의 결정을 그대로 따른다.
5. 개발 모드에 한정한 읽기 전용 진단처럼 사용처가 확인되면 별도 결정에서 다룬다. 그때 개발 모드 한정의 강제 방식, 허용할 프로토콜 도메인 목록,
   프로덕션 호스트에서의 거부를 먼저 정한다.

## 근거

- 임의 프로토콜 호출은 앱 보안 경계를 우회한다. 페이지의 JavaScript 실행(`Runtime.evaluate`), cookie(`Network.getCookies`, `Network.setCookie`),
  요청 가로채기(`Fetch.enable`), 네트워크 조건(`Network.emulateNetworkConditions`)이 프로토콜 한 통로로 모두 열린다. 이 저장소는 요청 가로채기
  ([ADR 0083](./0083-webview-request-interception.md)), cookie([ADR 0076](./0076-webview-cookies.md)),
  네트워크 emulation([ADR 0071](./0071-webview-network-emulation.md))을 각각 제공하지 않기로 정했다. 프로토콜 연결을 열면 이 결정이 무효가 된다.
  페이지에 스크립트를 넣는 API는 [#158](https://github.com/mathbook3948/bunaway/issues/158)에서 추적하며 CSP와 번들 자산 처리의 경계가 먼저
  정해져야 한다. 프로토콜 연결은 그 경계를 거치지 않는다.
- 호스트 바인딩은 `AreDevToolsEnabled`와 무관하게 동작한다. 앱 API로 열면 "프로덕션에서는 DevTools가 꺼진다"는
  `windows.openDevTools`의 보장이 프로토콜 쪽에서는 지켜지지 않으므로 개발 모드 판정과 권한 모델을 새로 만들어야 한다.
- 장치 emulation의 값은 실제 창 크기와 DPI가 앱 동작이므로 개발 시 DevTools UI의 장치 모드로 충분하다. 앱이 런타임에 이 값을 흉내 내야 할
  사용처는 `plugins`, `packages`, `examples`에서 확인되지 않았다.
- DevTools 창의 dock, title, workspace는 WebView2가 노출하지 않으므로 호스트가 구현하려면 프로토콜 호출이나 창 조작으로 우회해야 한다.
  Tauri도 제공하지 않는다.
- Electron만 프로토콜 연결과 emulation을 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어는 작게 두는 쪽을 따랐다.
  쓰는 곳이 없고 보안 경계를 먼저 정해야 하므로 결정을 미뤄도 앱이 막히지 않는다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 네 항목(DevTools workspace와 dock과 창 설정, device emulation, debugger protocol, 개발 도구 확장)을
  완료로 표시하고 이 결정을 참조한다.

---
status: accepted
---

# WebView HTTP 요청 가로채기, header 변경과 요청 결과 이벤트를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `a419fe05`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다. Electron v45.0.0, Tauri 2.12.5, wry 0.57.1, WebView2 SDK 1.0.4314.35의 문서와 소스를 기준으로 확인했다.

WebView가 보내는 HTTP 요청을 백엔드가 취소, 리다이렉트, URL 필터로 다루는 기능, 요청과 응답 header를 조회하고 바꾸며 응답을 stream으로
대체하는 기능, 요청 완료, 실패, redirect 이벤트를 제공할지 정해야 했다.

- Electron은 `session.webRequest`로 `onBeforeRequest`(취소와 `redirectURL`), `onBeforeSendHeaders`와 `onHeadersReceived`(header 변경),
  `onSendHeaders`, `onResponseStarted`, `onBeforeRedirect`, `onCompleted`, `onErrorOccurred`를 제공한다. 이벤트마다 URL 패턴 필터(`urls`,
  `excludeUrls`, `types`)를 받고, 같은 이벤트에 마지막으로 붙인 리스너만 유효하다.
- Tauri 2.12와 wry 0.57에는 임의 http(s) 요청을 요청 단위로 가로채거나 요청 header를 바꾸는 크로스플랫폼 공개 API를 찾지 못했다(최초 로드 URL의 header 지정은 제외). `on_web_resource_request`는
  공개 API이지만 `tauri` 스킴에만 실행되고 외부 URL에는 실행되지 않으며 응답만 수정할 수 있다. 그 밖에 사용자 정의 scheme 핸들러와 탐색 허용 여부를 정하는
  `on_navigation` 훅이 있다. Windows에서는 `with_webview`로 얻은 WebView2 객체에 앱이 직접 `WebResourceRequested`를 붙일 수 있다.
- WebView2(SDK 1.0.4314.35)는 `AddWebResourceRequestedFilterWithRequestSourceKinds`로 URL, 리소스 종류, 요청 출처별 필터를 걸고
  `WebResourceRequested`에서 요청을 처리한다. 요청 출처는 문서(전용 worker와 iframe 포함),
  shared worker, service worker 중에서 고르고, worker 필터는 프로필당 한 WebView에만 추가하라고 안내한다. 구 `AddWebResourceRequestedFilter`는 deprecated이며
  메인 프레임과 같은 origin의 iframe에만 이벤트를 낸다. `WebResourceResponseReceived`는 관찰 전용이고 `GetContent`로 응답 본문 stream을
  받을 수 있으나 123MB를 넘거나 다운로드가 되는 응답이면 null이다. 리소스 요청 단위의 네트워크 오류와 완료를 알리는 전용 호스트 이벤트는 `add_` 이벤트 목록에 없다. `DevToolsProtocolEventReceived`로 CDP Network 이벤트를 받을 수 있는지는
  검증하지 않았다.
  `NavigationCompleted`는 탐색만, `ServerCertificateErrorDetected`는 TLS 인증서 오류만 다룬다. 즉 Electron의 `onCompleted`, `onErrorOccurred`에
  해당하는 이벤트를 같은 범위로 만들 수 없다.
- 이 저장소는 탐색마다 `NavigationStarting`에서 허용 origin을 검사하고 redirect도 같은 검사를 거친다. 탐색 허용과 거부의 앱 훅은 별도
  항목(TODO-windows의 탐색 전 허용과 거부 훅)으로 남아 있다. 백엔드의 HTTP 요청은 선택 플러그인 `network.request`가 제한된 header와 base64
  body로 제공하고 redirect를 따라가지 않는다([network 계약](../site/src/content/docs/reference/plugins/network.mdx)). 네이티브 호스트는 이미 `WebResourceRequested`로
  내장 웹 자산을 응답으로 제공한다(`native/windows/bun/README.md`). 후속 결정이 같은 이벤트에 필터를 더하면 이 자산 필터와의 관계를 함께 정해야 한다.
- 요청마다 백엔드의 응답을 기다리는 훅은 페이지 하나가 수백 개의 하위 리소스를 요청하므로 로드 시간이 백엔드의 응답 시간과 deadline에 묶인다.
  백엔드가 응답하지 않을 때 요청을 통과시킬지 막을지를 계약으로 정해야 하고, 어느 쪽이든 페이지 로드 동작이 달라진다.
- header 변경은 `Origin`, `Referer`, `Cookie`, `Authorization`, `Content-Security-Policy`처럼 웹 보안 경계를 이루는 header를 백엔드가
  바꿀 수 있게 한다. 신뢰된 백엔드라 권한 경계를 넘지는 않지만, 앱의 origin 검사와 CSP 방침을 우회하는 경로가 항상 열려 있게 된다.

## 결정

1. WebView의 HTTP 요청 취소, redirect, URL 필터 훅을 추가하지 않는다.
2. 요청과 응답 header의 조회와 변경, 응답 stream 대체를 추가하지 않는다.
3. 요청 완료, 실패, redirect 이벤트를 추가하지 않는다.
4. 탐색의 허용과 거부는 기존 허용 origin 검사와 탐색 훅 항목이 맡는다. 백엔드가 외부 HTTP를 호출해야 하면 `network.request`를 쓰고, 로컬
   콘텐츠는 앱 자산 경로로 제공한다. 페이지가 쓰는 header와 보안 정책은 서버 응답과 앱 CSP 설정이 정한다.
5. 특정 요청을 막거나 바꿔야 하는 요구가 확인되면 별도 결정에서 다룬다. 이때 대상은 WebView2 `WebResourceRequested` 필터로 URL 패턴, 리소스 종류와 요청 출처를
   한정하고, 백엔드 응답이 없을 때의 기본 동작, 변경 가능한 header의 허용 목록, 서비스 워커 요청의 적용 여부를 계약으로 먼저 정한다.

## 근거

- Electron은 요청 가로채기와 결과 이벤트를 제공하고 Tauri는 임의 요청 단위의 크로스플랫폼 API를 제공하지 않는다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는 쪽을 따른다.
  또한 쓰는 곳이 없다(`plugins`, `packages`, `examples`에서 WebView 요청을 가로채거나 header를 바꾸는 코드는 없고, `native`는 내장 자산 응답에만 `WebResourceRequested`를 쓴다).
- Electron과 같은 범위를 제공해도 WebView2에는 리소스 요청의 완료와 실패를 알리는 전용 호스트 이벤트가 없어 `onCompleted`, `onErrorOccurred`를 같은 의미로
  약속할 수 없다. 같은 이름의 이벤트가 플랫폼마다 다른 범위를 약속하게 되어 계약이 모호해진다.
- 요청 경로에 백엔드 응답을 끼우지 않으면 로드 시간이 백엔드와 무관하게 유지되고, 기존 origin 검사와 CSP 방침이 우회되지 않는다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

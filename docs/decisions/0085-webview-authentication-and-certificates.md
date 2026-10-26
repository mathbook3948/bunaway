---
status: accepted
---

# WebView 인증, client certificate 선택, certificate 검증 오류 처리와 OS 네트워크 경로 옵션을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `1e20a51d`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

앱이 WebView 페이지의 HTTP 인증 요청, client certificate 선택, 서버 certificate 검증 오류를 가로채 처리할지,
OS proxy, DNS, NTLM과 통합 인증을 쓰는 네트워크 경로를 별도 옵션으로 제공할지 정해야 했다.

- Electron은 `login`(HTTP 인증과 proxy 인증 요청, 자격 증명을 넘기거나 취소, 기본 동작은 모든 인증 취소),
  `select-client-certificate`(목록에서 certificate 선택), `certificate-error`(`event.preventDefault()` 뒤 `callback(true)`로 신뢰)
  이벤트를 `app`과 `webContents`에서 제공한다. `Session`에는 이 세 이벤트가 없고, session에서는
  `ses.setCertificateVerifyProc`만 서버 certificate 검증을 대신한다.
- Tauri 2(wry)는 인증 요청 처리, client certificate 선택, certificate 오류 처리에 대한 공개 API를 두지 않는다.
  Windows에서는 `Webview::with_webview`로 얻은 WebView2 객체에 앱이 직접 이벤트를 붙이는 방법만 있다.
- WebView2는 `ICoreWebView2_10::BasicAuthenticationRequested`, `ICoreWebView2_5::ClientCertificateRequested`,
  `ICoreWebView2_14::ServerCertificateErrorDetected`로 대응할 수 있다(SDK 1.0.4314.35의 IDL 기준).
- 이 저장소의 Windows 호스트는 위 세 이벤트에 핸들러를 달지 않는다(`native/windows/bun`에 해당 코드 없음). macOS 호스트에도
  인증 challenge나 서버 trust 처리 코드는 없다. 핸들러가 없을 때 WebView2의 인증 창은 앱 계약으로 보장하지 않는다
  ([ADR 0064](./0064-webview-browser-default-ui.md) 결정 3). certificate 오류 페이지의 표시도 이 저장소에서 검증하지 않았으며
  같은 이유로 앱 계약으로 보장하지 않는다.
- WebView 페이지의 OS proxy, DNS, NTLM과 통합 인증의 실제 동작은 WebView2 네트워크 스택이 정하며 이 저장소에서
  검증하지 않았다. 호스트는 브라우저 인자를 넘기지 않는다([ADR 0030](./0030-launch-arguments-and-environment.md) 결정 4,
  [ADR 0062](./0062-webview-network-identity-options.md)). 배포 앱의 환경 변수 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`는
  그대로 유효하지만 앱 계약이 아니다.
- 앱 백엔드의 HTTP 요청은 `network.request`가 처리한다. 요청 URL의 credentials와 `Proxy-Authorization` 헤더는 받지 않고,
  `Authorization` 헤더는 앱이 직접 지정한다. `network.resolveProxy`는 Windows 시스템 proxy 경로를 조회한다(macOS는 미지원).

## 결정

이 결정은 Windows 호스트 기준이다. macOS 호스트의 같은 항목(`docs/TODO-macos.md`의 proxy, 인증, client certificate,
인증서 오류 지원 범위)은 이 결정에 포함하지 않고 별도로 정한다.

1. WebView 인증 요청 처리, client certificate 선택, 서버 certificate 검증 오류 처리와 사용자 trust 판단, SSL 설정 API를
   추가하지 않는다. 호스트는 해당 WebView2 이벤트를 처리하지 않는다.
2. certificate 검증을 앱이 완화하는 수단(오류 무시, 임의 certificate 신뢰)은 제공하지 않는다. 모든 앱의 WebView에 영향을
   주는 보안 경계이므로 쓰는 곳이 확인되고 별도 결정이 있을 때만 다룬다.
3. OS proxy, DNS, NTLM과 통합 인증용 별도 옵션을 두지 않는다. 호스트는 브라우저 인자를 넘기지 않으므로 이 경로는
   WebView2 기본 설정에 맡기며 동작을 앱 계약으로 보장하지 않는다. Windows의 앱 백엔드는 `network.resolveProxy`로 시스템 proxy 경로를 조회할 수 있다.
4. 쓰는 곳이 확인되면 별도 결정에서 다시 다룬다. 그때 인증 요청은 `BasicAuthenticationRequested`, client certificate는
   `ClientCertificateRequested`로 대응하는 방안을 먼저 검토하고, certificate 오류는 완화 없이 알림만 받는 이벤트부터 검토한다.

## 근거

- Electron은 세 가지를 `app`과 `webContents` 이벤트로 제공하지만 Tauri는 공개 API가 없다. 이 저장소의 앱 자산과 개발 서버는 인증을 쓰지 않아
  ([ADR 0064](./0064-webview-browser-default-ui.md)) 쓰는 곳이 없고, certificate 검증 완화는 모든 앱의 보안 경계에 영향을 준다. 코어는 작게 두고 쓰는 곳이 확인될 때까지 보류하는 쪽을 따른다.
- 이벤트를 처리하지 않으면 새 권한 경계나 certificate 검증 완화 경로가 생기지 않는다. 앱이 검증을 완화하는 수단은
  쓰는 곳이 확인될 때까지 열지 않는다.
- 통합 인증과 OS 네트워크 설정용 옵션은 브라우저 인자 비전달 방침(ADR 0030)을 뒤집어야 하므로 쓰는 곳이 확인될 때까지
  보류한다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

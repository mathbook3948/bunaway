---
status: accepted
---

# WebView WebRTC IP 노출 정책과 UDP 포트 범위 설정을 제공하지 않는다

결정일: 2026-10-26.

## 배경

WebRTC 연결 후보(ICE candidate)에 어떤 네트워크 인터페이스 주소를 노출할지(IP handling policy)와 WebRTC가 쓰는 UDP 포트 범위를 앱이 정하게 할지 정해야 했다.

아래 Electron, Tauri, WebView2 서술은 Electron v45.0.0, Tauri 2.12.5, wry 0.57.0과 0.57.1, WebView2 SDK 1.0.4314.35의 공개 문서와 소스에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

- Electron은 `webContents.setWebRTCIPHandlingPolicy`로 `default`, `default_public_interface_only`, `default_public_and_private_interfaces`,
  `disable_non_proxied_udp` 중 하나를 고르게 하고, `webContents.setWebRTCUDPPortRange`로 UDP 포트 범위를 정하게 한다. 둘 다 WebContents 단위의 런타임 API다.
- Tauri와 wry에는 WebRTC IP 정책이나 UDP 포트 범위를 정하는 전용 공개 옵션을 찾지 못했다. Tauri는 Windows에서 창 단위 `additional_browser_args`로 WebView2 브라우저 인자를 넘길 수 있어([ADR 0030](./0030-launch-arguments-and-environment.md), [ADR 0065](./0065-webview-content-settings.md)) 범용 경로는 있으나, WebRTC 스위치를 이 용도로 쓰는 공개 문서는 확인하지 못했다.
- WebView2 SDK 1.0.4314.35의 `ICoreWebView2Settings`부터 `ICoreWebView2Settings9`까지, `ICoreWebView2Profile`과 `ICoreWebView2Environment`
  옵션에는 WebRTC 후보 노출이나 UDP 포트 범위를 정하는 항목이 없다. 남는 수단은 환경 생성 때만 넘기는 `AdditionalBrowserArguments`로 Chromium
  명령줄 스위치를 주는 것이다. 이 인자는 환경에 setter가 없고 같은 사용자 데이터 폴더의 브라우저 프로세스가 공유하며, 실행 중인 프로세스와 다르면
  환경 생성이 `ERROR_INVALID_STATE`로 실패한다([ADR 0065](./0065-webview-content-settings.md)). 어떤 스위치를 WebView2 빌드가 받아들이는지는 이 저장소에서 검증하지 않았다.
- 이 저장소의 호스트는 브라우저 인자를 넘기지 않으며 앱 정의에 WebRTC 관련 항목도 없다. 호스트 프로세스의 환경 변수 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`는 배포 앱에서도 유효하지만 `bunaway dev` 호스트에는 전달되지 않는다([ADR 0030](./0030-launch-arguments-and-environment.md) 결정 4). 앱 정의 API는 아니며 이 결정이 제공하는 수단이 아니다. 확인된 수요도 없다.

## 결정

1. WebRTC IP handling policy와 UDP 포트 범위를 앱 정의, 컨트롤러 API, 이벤트에 추가하지 않는다.
2. WebView2 기본 동작을 그대로 쓴다. 호스트는 WebRTC 관련 브라우저 인자를 넘기지 않는다.
3. 대체 수단은 제공하지 않는다. IP 노출은 페이지가 `RTCPeerConnection`에 `iceTransportPolicy: "relay"`를 지정하고 TURN 서버를 쓰면 일부 줄일 수 있으나 이는 앱 페이지의 책임이다. UDP 포트 범위는 대신할 방법을 제공하지 않는다.
4. 필요한 사용처가 확인되면 별도 결정에서 다룬다. 이때 `AdditionalBrowserArguments`의 해당 스위치 지원 여부를 먼저 검증하고, 같은 사용자 데이터
   폴더를 공유하는 환경 생성 규칙과 창 설정이 묶이는 문제를 계약으로 정한다.

## 근거

- Electron은 WebContents 단위 API를 제공하고 Tauri는 전용 옵션을 찾지 못해 둘이 다르다. WebView2에는 런타임 API가 없어
  Electron과 같은 수준의 WebContents 단위 설정을 약속할 수 없으므로 코어는 작게 두는 쪽을 따른다. 확인된 수요도 없다.
- 브라우저 인자로 대신하면 같은 사용자 데이터 폴더의 모든 WebView와 브라우저 프로세스에 적용되고 바꾸려면 프로세스를 새로 띄워야 한다.
  Electron의 런타임 설정과 의미가 달라진 채 같은 이름의 옵션을 약속하게 되고 환경 생성 규칙이 앱 정의에 묶인다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

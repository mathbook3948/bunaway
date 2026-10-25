---
status: accepted
---

# WebView preconnect, 연결 정리와 network log를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `a419fe05`.

## 배경

앱이 WebView의 네트워크 연결을 미리 열거나 닫고, 네트워크 활동을 파일로 기록하는 API를 제공할지 정해야 했다.
online 상태 조회와 변경 이벤트, host와 proxy resolve는 `network.isOnline`, `network.onlineChanged`,
`network.resolveHost`, `network.resolveProxy`로 이미 제공한다. 이 결정은 그 나머지인 preconnect, 연결 정리, network log만 다룬다.

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.
기준은 Electron v45.0.0(Chromium 156.0.8078.48), Tauri 2.12.5, wry 0.57.1, WebView2 SDK 1.0.4314.35이다.

- Electron은 `session.preconnect({ url, numSockets })`, `session.closeAllConnections()`, `session.netLog`
  (`startLogging`, `stopLogging`, `currentlyLogging`)를 Session 멤버로 제공한다. preconnect와 연결 정리는 소스상 해당 세션의
  BrowserContext와 NetworkContext 범위에서 동작한다. netLog는 접근 경로가 세션별이지만 Chromium의 로그 내보내기는 같은
  NetworkService가 관리하는 모든 NetworkContext의 이벤트를 포함하는 전역 로그가 일반적이라, 내용이 세션 단위로 나뉜다고 볼 수 없다.
- Tauri 2.12.5와 wry 0.57.1의 소스에서 preconnect, 연결 정리, network log에 해당하는 공개 API를 찾지 못했다.
  가장 가까운 수단은 Windows 전용 `additional_browser_args`로, WebView2 환경을 만들 때 브라우저 인수를 넘긴다.
- WebView2 SDK의 `WebView2.idl`에는 preconnect와 연결 정리 API가 없다. network log는 `--log-net-log`와
  `--net-log-capture-mode` 브라우저 플래그뿐이며 `AdditionalBrowserArguments`, 환경 변수, 레지스트리 모두 환경(브라우저 프로세스)
  생성 때만 적용되고 실행 중에 시작하거나 멈추는 API는 없다. 같은 사용자 데이터 폴더의 브라우저 프로세스가 이미 실행 중이면
  옵션이 다른 환경 생성은 `ERROR_INVALID_STATE`로 실패한다. Microsoft는 이 플래그를 프로덕션 앱에서 쓰지 말라고 안내한다.
- 이 저장소의 호스트는 `CreateCoreWebView2EnvironmentWithOptions`에 환경 옵션을 넘기지 않는다(`native/windows/bun/webview.ts`).
  network log를 켜려면 환경 옵션 전달 경로를 새로 만들어야 하고, 이 경로는 모든 앱의 WebView 생성에 영향을 준다.
- `<link rel="preconnect">`와 `dns-prefetch`는 Chromium에서 임베더가 `CreatePrescientNetworking`을 구현해야 동작한다.
  Chrome과 Electron은 구현하지만 WebView2가 지원한다는 공식 명시는 확인하지 못했다. 앱 백엔드의
  `network.request`는 별도 전송 계층을 쓰므로 WebView의 연결 풀과 관계가 없다.
- network log는 `Default`에서 쿠키와 인증 정보를 제거하고, `IncludeSensitive`는 쿠키와 인증 헤더를, `Everything`은 소켓으로
  주고받은 실제 바이트(본문 포함 가능)를 기록한다(Chromium `net_log_capture_mode.h`). 민감한 정보를 파일로 남길 수 있다.
  기록 위치와 보관은 앱 책임이며 경로 제한은 코어가 맡지 않는 방침([ADR 0024](./0024-plugin-path-responsibility.md))과 맞물린다.
- 개발 중에는 Windows x64의 `bunaway dev`가 DevTools를 연결하므로
  ([디버깅 가이드](../site/src/content/docs/guides/debugging.mdx)) Network 패널로 요청을 볼 수 있다.

## 결정

1. preconnect, 연결 정리, network log API를 추가하지 않는다.
2. 대체 API는 두지 않는다. 개발 중 요청 확인은 Windows x64의 DevTools로 충당한다. 페이지의 `<link rel="preconnect">`는 앱이
   쓸 수 있지만 동작은 WebView2 런타임이 정하며 이 저장소는 보장하지 않는다.
3. 배포 앱에서 이 기능이 필요하다는 요구가 확인되면 별도 결정에서 다룬다. 이때 환경 옵션 전달 경로, 기록 범위,
   민감 정보 포함 여부(capture 수준), 출력 경로의 책임을 먼저 정한다.

## 근거

- Electron은 세션 단위로 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는 쪽을 따른다.
  쓰는 곳이 없다(`plugins`, `packages`, `examples`에서 이 기능을 요구하는 코드는 없다).
- preconnect와 연결 정리는 WebView2에 대응 API가 없다. Electron과 같은 이름의 API를 약속하려면 공개 표면이 없는
  Chromium 내부 동작이나 DevTools 프로토콜에 기대야 한다. Electron의 netLog도 세션별 이름과 달리 전역 로그에 가까워
  같은 이름의 API를 약속하기 어렵다.
- network log는 호스트의 환경 생성 경로를 바꾸고 환경 생성 뒤에는 켜고 끌 수 없어 Electron의 `startLogging`,
  `stopLogging` 의미를 지킬 수 없다. 쿠키와 본문까지 파일에 남길 수 있는 기능이라 쓰는 곳 없이 먼저 열 이유가 없다.
- 쓰는 곳이 확인되지 않았으므로 결정을 미뤄도 앱이 막히지 않는다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

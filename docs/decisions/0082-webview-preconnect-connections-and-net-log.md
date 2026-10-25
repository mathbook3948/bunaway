---
status: accepted
---

# WebView preconnect, 연결 정리와 network log를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `a419fe05`.

## 배경

앱이 WebView의 네트워크 연결을 미리 열거나 닫고, 네트워크 활동을 파일로 기록하는 API를 제공할지 정해야 했다.
online 상태 조회와 변경 이벤트, host와 proxy resolve는 `network.isOnline`, `network.onlineChanged`,
`network.resolveHost`, `network.resolveProxy`로 이미 제공한다. 이 결정은 그 나머지인 preconnect, 연결 정리, network log만 다룬다.

- Electron은 `session.preconnect({ url, numSockets })`, `session.closeAllConnections()`, `netLog`
  (`startLogging`, `stopLogging`, `currentlyLogging`)를 세션 단위로 제공한다.
- Tauri와 wry에는 같은 기능이 없다.
- WebView2는 preconnect와 연결 정리 API를 제공하지 않는다. network log는 Chromium의 `--log-net-log`
  명령줄 스위치를 환경 생성 때 추가 브라우저 인수로 넘겨야 하고, 실행 중에 시작하거나 멈출 수 없다.
- 이 저장소의 호스트는 `CreateCoreWebView2EnvironmentWithOptions`에 환경 옵션을 넘기지 않는다(`native/windows/bun/webview.ts`).
  network log를 켜려면 환경 옵션 전달 경로를 새로 만들어야 하고, 이 경로는 모든 앱의 WebView 생성에 영향을 준다.
- 페이지는 `<link rel="preconnect">`와 `<link rel="dns-prefetch">`로 연결을 미리 열 수 있다. 앱 백엔드의
  `network.request`는 별도 전송 계층을 쓰므로 WebView의 연결 풀과 관계가 없다.
- network log는 URL, header, 경우에 따라 cookie와 본문을 담을 수 있어 민감한 정보를 파일로 남긴다.
  기록 위치와 보관은 앱 책임이며 경로 제한은 코어가 맡지 않는 방침([ADR 0024](./0024-plugin-path-responsibility.md))과 맞물린다.
- 개발 중에는 Windows x64의 `bunaway dev`가 DevTools를 연결하므로
  ([디버깅 가이드](../site/src/content/docs/guides/debugging.mdx)) Network 패널로 요청을 볼 수 있다.

## 결정

1. preconnect, 연결 정리, network log API를 추가하지 않는다.
2. 대체 API는 두지 않는다. 연결을 미리 여는 용도는 문서의 `<link rel="preconnect">`로, 개발 중 요청 확인은 DevTools로 충당한다.
3. 배포 앱에서 이 기능이 필요하다는 요구가 확인되면 별도 결정에서 다룬다. 이때 환경 옵션 전달 경로, 기록 범위,
   민감 정보 포함 여부(capture 수준), 출력 경로의 책임을 먼저 정한다.

## 근거

- Electron만 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는 쪽을 따른다.
  쓰는 곳이 없다(`plugins`, `packages`, `examples`에서 이 기능을 요구하는 코드는 없다).
- preconnect와 연결 정리는 WebView2에 대응 API가 없다. Electron과 같은 이름의 API를 약속하려면 공개 표면이 없는
  Chromium 내부 동작이나 DevTools 프로토콜에 기대야 한다.
- network log는 호스트의 환경 생성 경로를 바꾸고 프로세스 시작 뒤에는 켜고 끌 수 없어 Electron의 `startLogging`,
  `stopLogging` 의미를 지킬 수 없다. 민감 정보를 파일에 남기는 기능이라 쓰는 곳 없이 먼저 열 이유가 없다.
- 쓰는 곳이 확인되지 않았으므로 결정을 미뤄도 앱이 막히지 않는다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

# Renderers

- `system-webview/`: OS별 기본 WebView 어댑터의 예정 영역.
- `chromium/`: 후속 선택 렌더러의 인터페이스 자리.

호스트의 렌더러 계약을 따르며 앱 명령의 의미를 알지 못한다.
이 디렉터리에 별도 어댑터 구현과 네이티브 빌드 설정은 없다.
현재 Windows WebView2 통합은 `native/windows/bun/webview.ts`에 구현되어 있으며,
SDK 전송 어댑터는 `packages/client-sdk/src/webview.ts`에 있다.
앱 화면은 `@bunaway/client`의 `invoke`, `listen`을 사용하며 기본 연결의 브리지 선택과
Transport 초기화는 `packages/client-sdk/src/default-client.ts`가 담당한다.
[실행 검증](../docs/architecture/windows-bun-results.md)은 Windows 다중 창/뷰를 포함한다.
다른 OS의 기본 WebView 어댑터와 Chromium 선택 렌더러는 미구현이다.

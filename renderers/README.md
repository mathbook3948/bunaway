# Renderers

- `system-webview/`: OS별 기본 WebView 어댑터의 예정 영역.
- `chromium/`: 후속 선택 렌더러의 인터페이스 자리.

호스트의 렌더러 계약을 따르며 앱 명령의 의미를 알지 못한다.
이 디렉터리에 별도 어댑터 구현과 네이티브 빌드 설정은 없다.
현재 Windows WebView2 통합은 `native/windows/host/host.cpp`에 구현되어 있으며,
SDK 전송 어댑터는 `packages/client-sdk/src/webview.ts`에 있다.
[실행 검증](../docs/architecture/windows-host-results.md)은 Windows 단일 창/뷰에 한정한다.
다른 OS의 기본 WebView 어댑터와 Chromium 선택 렌더러는 미구현이다.

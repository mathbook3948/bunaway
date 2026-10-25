---
status: accepted
---

# WebView JavaScript, 이미지, WebGL, autoplay, background throttling 설정은 제공하지 않는다

결정일: 2026-10-25.

## 배경

앱 정의나 컨트롤러에 WebView 콘텐츠 동작 설정을 둘지 정해야 했다. 대상은 JavaScript 실행, 이미지 로드, WebGL,
미디어 autoplay 정책, 백그라운드 WebView의 타이머 throttling이다.

이 결정의 외부 동작 서술(Electron, Tauri, WebView2)은 공개 문서 기준이며 이 저장소의 테스트로 검증한 것이 아니다.
Tauri의 해당 옵션 제공 범위는 버전별 확인이 끝나지 않았고, 이 결정은 그 확인 결과에 의존하지 않는 근거만 사용한다.

- Electron의 `webPreferences`는 `javascript`, `images`, `webgl`, `autoplayPolicy`, `backgroundThrottling`을 제공한다.
  기본값은 각각 켬, 켬, 켬, `no-user-gesture-required`, 켬이다.
- WebView2에는 `ICoreWebView2Settings.IsScriptEnabled`가 있다. 이미지 로드, WebGL, autoplay, 타이머 throttling을 켜고 끄는
  전용 `ICoreWebView2Settings` 항목은 없다. 이들을 바꾸려면 환경 생성 시점의 브라우저 인자(`AdditionalBrowserArguments`)가
  필요하고, 이 인자는 같은 환경을 쓰는 모든 WebView에 적용되며 생성 뒤에는 바꿀 수 없다.
- Windows 호스트는 WebView2의 `WebMessageReceived`(페이지의 `window.chrome.webview.postMessage`)로 UI 메시지를 받고
  `PostWebMessageAsJson`으로 보낸다(`native/windows/bun/webview.ts`). JavaScript를 끄면 이 경로가 끊겨 앱 UI와 백엔드가
  통신할 수 없다.

## 결정

1. JavaScript, 이미지, WebGL, autoplay, background throttling 설정을 앱 정의와 컨트롤러 API에 추가하지 않는다.
2. WebView는 WebView2 기본 동작을 그대로 쓴다.
3. 이미지와 미디어 제어는 앱의 HTML과 CSS(`<img loading>`, `<video autoplay muted>`, `media` 속성)로,
   throttling이 문제인 작업은 Worker나 백엔드로 옮겨서 해결한다.
4. 이 설정이 필요한 구체적 사용처가 확인되면 별도 결정에서 다룬다.

## 근거

- 쓰는 곳이 없다. JavaScript를 끄면 UI와 백엔드 통신이 끊겨 의미 있는 사용처가 없고, 나머지 설정은 WebView2에 전용 설정이
  없어 환경 단위 브라우저 인자로만 바꿀 수 있다. 이를 앱 정의에 노출하면 환경 생성 규칙과 창 설정이 서로 묶인다.
  코어는 작게 두고, 필요한 앱은 HTML과 CSS로 해결한다.
- Electron과 같은 옵션을 제공하지 않는 점에서 이 결정은 Electron과 다르다. 사용처가 확인되면 별도 결정에서 다시 다룬다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

---
status: accepted
---

# WebView JavaScript, 이미지, WebGL, autoplay, background throttling 설정은 제공하지 않는다

결정일: 2026-10-25.

## 배경

앱 정의나 컨트롤러에 WebView 콘텐츠 동작 설정을 둘지 정해야 했다. 대상은 JavaScript 실행, 이미지 로드, WebGL,
미디어 autoplay 정책, 백그라운드 WebView의 타이머 throttling이다.

아래 외부 동작은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

- Electron의 `webPreferences`는 `javascript`, `images`, `webgl`, `autoplayPolicy`, `backgroundThrottling`을 제공한다.
  기본값은 각각 켬, 켬, 켬, `no-user-gesture-required`, 켬이다.
- Tauri 2의 Windows 설정에는 JavaScript 실행, 이미지, WebGL, autoplay 정책 옵션이 없다.
- WebView2에는 `ICoreWebView2Settings.IsScriptEnabled`가 있다. 이미지 로드와 WebGL을 끄는 전용 설정은 없고,
  autoplay 정책과 WebGL(GPU) 동작은 환경 생성 시점의 브라우저 인자(`AdditionalBrowserArguments`)로만 바꾼다.
  브라우저 인자는 같은 사용자 데이터 폴더를 쓰는 환경 전체에 적용되며 생성 뒤에는 바꿀 수 없다.
- WebView2의 백그라운드 자원 제어는 `TrySuspend`/`Resume`과 `MemoryUsageTargetLevel`이며 타이머 throttling을
  켜고 끄는 설정은 아니다.
- 이 저장소의 호스트는 `window.postMessage` 브리지와 문서 시작 스크립트로 UI와 백엔드를 연결한다. JavaScript를 끄면
  이 브리지와 앱 UI가 모두 동작하지 않는다.

## 결정

1. JavaScript, 이미지, WebGL, autoplay, background throttling 설정을 앱 정의와 컨트롤러 API에 추가하지 않는다.
2. WebView는 WebView2 기본 동작을 그대로 쓴다.
3. 이미지와 미디어 제어는 앱의 HTML과 CSS(`<img loading>`, `<video autoplay muted>`, `media` 속성)로,
   throttling이 문제인 작업은 Worker나 백엔드로 옮겨서 해결한다.
4. 이 설정이 필요한 구체적 사용처가 확인되면 별도 결정에서 다룬다.

## 근거

- Electron은 제공하고 Tauri는 Windows에서 제공하지 않는다. 이 앱 구조에서 JavaScript를 끄면 브리지가 끊기므로
  의미 있는 사용처가 없고, 이미지와 WebGL은 WebView2에 대응 설정이 없어 환경 전체의 브라우저 인자를 건드려야 한다.
  쓰는 곳이 없는 옵션을 위해 코어 계약과 환경 생성 규칙을 늘리지 않는다.
- autoplay와 WebGL을 바꾸는 브라우저 인자는 환경 단위라 단일 창 단일 WebView 구조([ADR 0026](./0026-single-webview-single-window.md))에서
  창 설정으로 노출하면 사용자 데이터 폴더 공유와 충돌할 수 있다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

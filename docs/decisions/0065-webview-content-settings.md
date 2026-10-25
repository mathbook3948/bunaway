---
status: accepted
---

# WebView JavaScript, 이미지, WebGL, autoplay, background throttling 설정은 제공하지 않는다

결정일: 2026-10-25.

## 배경

앱 정의나 컨트롤러에 WebView 콘텐츠 동작 설정을 둘지 정해야 했다. 대상은 JavaScript 실행, 이미지 로드, WebGL,
미디어 autoplay 정책, 백그라운드 WebView의 타이머 throttling이다.

이 결정의 외부 동작 서술(Electron, Tauri, WebView2)은 공개 문서 기준이며 특정 버전으로 고정해 확인하지 않았고
이 저장소의 테스트로 검증한 것도 아니다. 이후 WebView2 SDK가 전용 설정을 추가하면 이 결정을 다시 확인한다.
Tauri의 해당 옵션 제공 범위는 버전별 확인이 끝나지 않았고, 이 결정은 그 확인 결과에 의존하지 않는 근거만 사용한다.

- Electron의 `webPreferences`는 `javascript`, `images`, `webgl`, `autoplayPolicy`, `backgroundThrottling`을 제공한다.
  기본값은 각각 켬, 켬, 켬, `no-user-gesture-required`, 켬이다.
- WebView2에는 `ICoreWebView2Settings.IsScriptEnabled`가 있다. 이미지 로드, WebGL, autoplay, 타이머 throttling을 켜고 끄는
  전용 `ICoreWebView2Settings` 항목은 없다. 이들을 바꾸려면 환경 생성 시점의 브라우저 인자(`AdditionalBrowserArguments`)가
  필요하고, 이 인자는 같은 환경을 쓰는 모든 WebView에 적용되며 생성 뒤에는 바꿀 수 없다.
- Windows 호스트는 슬롯 34의 `add_WebMessageReceived` 핸들러로 페이지 메시지를 받고 `PostWebMessageAsJson`으로 보낸다
  (`native/windows/bun/webview.ts`). 페이지에서 이 경로로 보내는 것은 스크립트 실행에 의존하므로, WebView2에서
  JavaScript를 끄면 앱 UI와 백엔드의 메시지 통신이 끊길 것으로 본다(WebView2 동작에 대한 추론이며 이 저장소에서 검증하지 않았다).

## 결정

1. JavaScript, 이미지, WebGL, autoplay, background throttling 설정을 앱 정의와 컨트롤러 API에 추가하지 않는다.
2. 이 다섯 항목은 WebView2 기본값을 그대로 쓴다. 호스트가 이미 바꾸는 다른 `ICoreWebView2Settings`(웹 메시지, 기본 대화상자,
   컨텍스트 메뉴 등)는 이 결정의 범위가 아니다.
3. 이 설정들의 대체 수단은 제공하지 않는다. 앱은 자신의 페이지 안에서 처리하고(예: throttling이 문제인 작업은 백엔드로
   옮긴다), 이미지, WebGL, autoplay 정책 자체를 바꾸는 방법은 이 결정에서 정하지 않는다.
4. 이 설정이 필요한 구체적 사용처가 확인되면 별도 결정에서 다룬다.

## 근거

- 쓰는 곳이 없다. JavaScript를 끄면 UI와 백엔드 통신이 끊길 것으로 보여 의미 있는 사용처가 없고, 나머지 설정은 WebView2에
  전용 설정이 없어 환경 단위 브라우저 인자로만 바꿀 수 있다. 이를 앱 정의에 노출하면 환경 생성 규칙과 창 설정이 서로
  묶인다. 코어는 작게 두고, 사용처가 확인되면 그때 결정한다.
- 호스트는 브라우저 인자를 넘기지 않지만 호스트 프로세스의 환경 변수 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`는 배포 앱에서도
  유효하다([ADR 0030](./0030-launch-arguments-and-environment.md)). 앱 정의 API는 아니며 이 결정이 제공하는 수단이 아니다.
- Electron은 이 옵션들을 제공하므로 이 결정은 Electron과 다르다. 같은 구역의 렌더링 옵션 결정
  ([ADR 0039](./0039-webview-rendering-options.md))과 같은 방침이다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

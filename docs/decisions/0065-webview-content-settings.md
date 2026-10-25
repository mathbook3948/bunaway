---
status: accepted
---

# WebView JavaScript, 이미지, WebGL, autoplay, background throttling 설정은 제공하지 않는다

결정일: 2026-10-25.

## 배경

앱 정의나 컨트롤러에 WebView 콘텐츠 동작 설정을 둘지 정해야 했다. 대상은 JavaScript 실행, 이미지 로드, WebGL,
미디어 autoplay 정책, 백그라운드 WebView의 타이머 throttling이다.

아래 외부 동작은 Electron v45.0.0, Tauri 2.12.5(wry 0.57.0과 0.57.1), WebView2 SDK 1.0.4314.35 기준으로 공식 문서와
해당 태그의 소스를 확인한 것이며 이 저장소의 테스트로 검증한 것은 아니다.

- Electron의 `webPreferences`는 `javascript`, `images`, `webgl`, `autoplayPolicy`, `backgroundThrottling`을 제공한다.
  기본값은 각각 켬, 켬, 켬, `no-user-gesture-required`, 켬이다.
- Tauri는 JavaScript 끄기(`disable_javascript`, 설정 파일의 `javascriptDisabled`)와 `background_throttling`을 제공한다.
  WebView2에서 JavaScript 끄기는 `IsScriptEnabled`를 끄는 것이다. background throttling은 macOS 14 이상과 iOS 17 이상만
  지원하고 Windows는 지원하지 않는다. 이미지와 WebGL 설정은 없다. autoplay는 공개 옵션이 없고, wry가 Windows에서
  기본으로 `--autoplay-policy=no-user-gesture-required` 브라우저 인자를 넘긴다.
- WebView2에서 `ICoreWebView2Settings`부터 `ICoreWebView2Settings9`까지에는 `IsScriptEnabled`만 이 범주의 항목이고,
  이미지, WebGL, autoplay, 타이머 throttling 전용 항목은 없다. 대신 Settings 밖의 수단이 일부 있다. autoplay는
  권한 종류 `COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY`를 `PermissionRequested` 이벤트나 프로필의 `SetPermissionState`로
  제어하고, 이미지는 `WebResourceRequested` 필터(`COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE`)로 요청을 막는다.
  WebGL과 throttling을 끄는 API는 없다.
- WebView2의 `AdditionalBrowserArguments`는 환경 생성 때만 넘기며 환경 객체에 바꾸는 setter가 없다. 브라우저 프로세스는
  같은 사용자 데이터 폴더의 WebView가 공유하므로 이 인자도 그 범위에 적용되고, 실행 중인 프로세스와 옵션이 다르면
  환경 생성이 `ERROR_INVALID_STATE`로 실패한다.
- Windows 호스트는 슬롯 34의 `add_WebMessageReceived` 핸들러로 페이지 메시지를 받고 `PostWebMessageAsJson`으로 보낸다
  (`native/windows/bun/webview.ts`). 호스트는 `AddScriptToExecuteOnDocumentCreated`와 `ExecuteScript`를 쓰지 않는다.
  `IsScriptEnabled`는 문서 안의 스크립트에만 영향을 주므로, 끄면 페이지 스크립트가 실행되지 않아 페이지는
  `window.chrome.webview.postMessage`를 호출할 수 없다. 호스트가 주입한 스크립트는 실행되지만 이 저장소는 쓰지 않는다.

## 결정

1. JavaScript, 이미지, WebGL, autoplay, background throttling 설정을 앱 정의와 컨트롤러 API에 추가하지 않는다.
2. 이 다섯 항목은 WebView2 기본값을 그대로 쓴다. 호스트가 이미 바꾸는 다른 `ICoreWebView2Settings`(웹 메시지, 기본 대화상자,
   컨텍스트 메뉴 등)는 이 결정의 범위가 아니다.
3. 이 설정들의 대체 수단은 제공하지 않는다. 앱은 자신의 페이지 안에서 처리하고(예: throttling이 문제인 작업은 백엔드로
   옮긴다), 이미지, WebGL, autoplay 정책 자체를 바꾸는 방법은 이 결정에서 정하지 않는다.
4. 이 설정이 필요한 구체적 사용처가 확인되면 별도 결정에서 다룬다.

## 근거

- 쓰는 곳이 없다. 이 호스트에서 JavaScript를 끄면 페이지가 호스트로 메시지를 보낼 수 없어 UI와 백엔드 통신이 끊기므로
  의미 있는 사용처가 없다. WebGL과 throttling은 WebView2에 끄는 API가 없고 브라우저 인자가 필요하며, 이 인자는 같은
  사용자 데이터 폴더의 브라우저 프로세스 전체에 적용되고 바꾸려면 그 프로세스를 새로 띄워야 한다. autoplay와 이미지는
  권한 API와 요청 가로채기로 가능하지만 프로필 권한 상태나 요청 필터와 얽혀 계약이 커진다. 앱 정의에 노출하면 환경 생성
  규칙과 창 설정이 서로 묶이므로 코어는 작게 두고, 사용처가 확인되면 그때 결정한다.
- Electron은 다섯 설정을 모두 제공하고 Tauri는 JavaScript 끄기만 Windows에서 제공하므로 두 프레임워크가 다르다.
  Tauri의 JavaScript 끄기는 이 호스트처럼 페이지 스크립트로 브리지를 쓰는 구조에서는 앱을 쓸 수 없게 만드는 옵션이며,
  Tauri의 throttling은 Windows에서 동작하지 않고 이미지, WebGL 옵션은 없다. 이 결정은 Electron과 다르고, Windows에서
  동작하는 범위로는 Tauri와 가깝다. 같은 구역의 렌더링 옵션 결정([ADR 0039](./0039-webview-rendering-options.md))과
  같은 방침이다.
- 호스트는 브라우저 인자를 넘기지 않지만 호스트 프로세스의 환경 변수 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`는 배포 앱에서도
  유효하다. `bunaway dev` 호스트에는 전달되지 않는다([ADR 0030](./0030-launch-arguments-and-environment.md) 결정 4).
  앱 정의 API는 아니며 이 결정이 제공하는 수단이 아니다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

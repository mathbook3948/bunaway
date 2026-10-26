---
status: accepted
---

# WebView2 최소 runtime 버전을 두고 Evergreen만 지원한다

결정일: 2026-10-26. 검토 기준: main `c6b9ecc9`.

## 배경

Windows 호스트는 시작할 때 `WebView2Loader`의 `GetAvailableCoreWebView2BrowserVersionString`으로 설치된 runtime
버전을 읽는다([ADR 0022](./0022-app-info-context.md)). 그 값은 `app.webview`로만 쓰이고 최소 버전과 비교하지 않았다.

호스트는 고정 SDK 1.0.4129.50의 vtable slot과 IID로 인터페이스를 직접 호출한다. 일부는 없으면 기능만 줄어든다
(`ICoreWebView2_12`, `_13`과 Profile은 color scheme, `_15`는 favicon, `_16`은 print, `Settings9`는 titlebar).
반면 `ICoreWebView2_4`(다운로드 기본 거부 정책), `ICoreWebView2Settings4`(설정), `ICoreWebView2Controller2`(배경색),
`ICoreWebView2Environment8`(브라우저 프로세스 목록), `ICoreWebView2PermissionRequestedEventArgs3`(권한 거부 처리)와
`ICoreWebView2_3`(embedded가 아닐 때의 virtual host mapping), embedded 자산을 쓸 때의 `ICoreWebView2_22`(요청 출처별
resource filter)는 fallback 없이 QueryInterface하므로,
오래된 runtime에서는 창을 만들거나 요청을 처리하는 중에 원인을 알기 어려운 오류가 난다. `ICoreWebView2_8`(오디오 상태)은
앱이 audio API를 호출할 때만 조회하므로 시작 조건에 넣지 않는다.

선례:

- Electron은 Chromium을 앱에 번들하므로 runtime 버전 검사나 Fixed Version 개념이 없고 갱신은 앱 책임이다.
- Tauri는 WebView2 Evergreen을 기본으로 하고, Fixed Version은 빌드 설정(`webviewInstallMode`의 `fixedRuntime`)으로만
  열며 앱 실행 중 경로 입력은 받지 않는다.

## 결정

- 호스트는 읽은 runtime 버전이 최소 버전보다 낮으면 `webview-version-too-old`를 로그에 남기고 Core를 만들기 전에 시작을
  실패시킨다. 오류 메시지에는 감지한 버전, 요구 버전, Evergreen runtime 설치 안내만 담고 경로는 담지 않는다. 시작 실패 대화상자가 공통으로 덧붙이는 stack과 로그 파일 위치는 이 결정의 범위 밖이다.
- 버전을 읽지 못했거나 모양을 해석할 수 없으면 기존대로 계속한다(읽기 실패는 `webview-version-unavailable`을 남긴다).
  정보를 얻지 못한 것만으로 앱을 막지 않는다.
- 최소 버전(128.0.2739.15)은 필수 인터페이스(fallback 없는 호출) 중 가장 늦게 나온 `ICoreWebView2_22` 기준으로 정하고,
  선택 인터페이스는 값을 올리지 않는다. 개발 실행(embedded가 아님)에는 `_22`가 필요 없지만 기준은 하나로 둔다. 상수는 `native/windows/bun/webview-version-check.ts` 한 곳에 둔다.
- Evergreen만 지원한다. 설치 채널의 `webView2`(`check`, `bootstrap`, `offline`)가 모두 Evergreen 설치다.
- Fixed Version(`BrowserExecutableFolder`)은 제공하지 않는다. 앱이 임의 폴더의 브라우저 바이너리를 로드하게 하는
  통로는 서명 검증과 보안 갱신을 우회하므로 열지 않는다. 나중에 연다면 패키징 설정에서 설치 폴더 기준 상대 경로로
  고정하고, 호스트가 WebView 생성과 버전 조회에 같은 폴더를 넘기며 최소 버전 검사도 그 폴더 기준으로 한다.
- Store unpackaged 채널은 `check`로 고정이므로 설치 중 runtime을 보정할 수 없다. runtime이 없거나 너무 낮을 때의
  동작은 같은 시작 실패 안내다. 채널 허용 범위는 이 결정과 별개로 남는다.

## 검증 범위

버전 해석과 비교는 순수 함수라 모든 플랫폼에서 단위 시험한다. 실제로 오래된 runtime이 깔린 PC에서의 시작 실패
표시는 CI 러너에서 오래된 runtime을 만들 수 없어 자동 시험하지 못하며 수동 확인 대상이다.

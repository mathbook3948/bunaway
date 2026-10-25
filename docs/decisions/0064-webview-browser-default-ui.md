---
status: accepted
---

# WebView 브라우저 기본 UI 설정을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `579c976e`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

앱이 WebView의 브라우저 기본 UI를 켜고 끄는 설정을 제공할지 정해야 했다. 대상은 JavaScript 대화상자(`alert`, `confirm`, `prompt`),
기본 context menu, zoom 단축키(Ctrl+휠, Ctrl+더하기와 빼기), autofill, 비밀번호 자동 저장, HTTP 인증이다.

- Electron의 WebView에는 기본 context menu가 없고, 앱이 `context-menu` 이벤트를 받아 직접 메뉴를 만든다. JavaScript 대화상자를
  끄는 `disableDialogs` 옵션이 있다. zoom 단축키는 앱 메뉴의 `zoomIn`, `zoomOut` role이 만든다. HTTP 인증은 `login` 이벤트로
  앱이 처리한다.
- Tauri 2의 Windows 창 빌더에는 zoom 단축키를 켜고 끄는 `zoom_hotkeys_enabled` 옵션이 있다. 그 밖의 항목에는 앱이 쓰는
  설정이 없다.
- 이 저장소의 Windows 호스트는 WebView2 설정을 고정한다(`native/windows/bun/webview.ts`). JavaScript 대화상자
  (`AreDefaultScriptDialogsEnabled`), 기본 context menu(`AreDefaultContextMenusEnabled`), zoom 컨트롤(`IsZoomControlEnabled`),
  상태 표시줄, host object를 끄고, 비밀번호 자동 저장(`IsPasswordAutosaveEnabled`)과 일반 autofill(`IsGeneralAutofillEnabled`)도 끈다.
  브라우저 가속키(`AreBrowserAcceleratorKeysEnabled`)는 개발 도구를 켠 빌드에서만 켠다.
- 컨트롤러 `setZoomFactor`와 `getWebViewState`의 zoom factor는 이미 제공한다. 호스트는 `IsZoomControlEnabled`를 꺼서 Ctrl+휠과 Ctrl+더하기, 빼기로 zoom이 바뀌는
  경로를 닫는다. 터치 핀치 zoom(`IsPinchZoomEnabled`)은 호스트가 설정하지 않아 WebView2 기본값을 따르며 이 계약에 포함하지 않는다.
  개발 도구를 켠 빌드의 브라우저 가속키도 포함하지 않는다. 그래서 앱이 zoom 단계를 메뉴나 단축키로 직접 정할 수 있다.
- 호스트는 `BasicAuthenticationRequested`를 처리하지 않는다. 허용 origin 안의 문서가 401 응답을 받으면 WebView2 기본 인증 창이
  뜬다. 앱 자산과 개발 서버가 인증을 쓰지 않으므로 이 경로는 현재 쓰는 곳이 없다.
- 페이지 안에서는 대화상자를 HTML 요소로, context menu를 `contextmenu` 이벤트와 앱 메뉴(메뉴 플러그인의 `showContextMenu`)로,
  autofill을 `autocomplete` 속성으로 다룰 수 있다.

## 결정

1. 기본 JavaScript 대화상자, 기본 context menu, zoom 단축키, autofill, 비밀번호 자동 저장을 켜는 설정을 추가하지 않는다.
   호스트의 현재 고정값(핀치 zoom 제외, 나머지는 끔)이 계약이다.
2. 앱은 대화상자 용도에 dialog 플러그인과 HTML 요소를, context menu에 메뉴 플러그인의 `showContextMenu`를, zoom에 `setZoomFactor`를 쓴다.
3. HTTP 인증 설정과 인증 요청 이벤트를 추가하지 않는다. 인증이 필요한 원격 자원이 확인되면 별도 결정에서 다룬다.
   그때까지 WebView2 기본 인증 창은 호스트가 바꾸지 않는 동작이며 앱 계약으로 보장하지 않는다.
4. 이 결정은 Windows 호스트 기준이다. macOS 호스트는 이 결정에서 다루지 않는다.

## 근거

- 두 프레임워크가 다르다. Electron은 기본 context menu 없이 앱이 만드는 모델이고, Tauri는 zoom 단축키 하나만 설정으로 둔다.
  이 저장소는 기본 UI를 모두 끈 상태로 시작하고, 같은 일을 메뉴 플러그인의 `showContextMenu`와 `setZoomFactor`로 할 수 있다.
  쓰는 곳이 없는 설정을 위해 앱 정의 스키마와 코어 계약을 늘리지 않는다.
- 브라우저 기본 UI를 켜면 앱이 그리지 않은 창(대화상자, 인증, autofill 목록)이 WebView 위에 뜬다. 이 창은 앱 창의 종료,
  숨김과 모달 처리 규칙 바깥에 있어서, 켜는 설정은 그 규칙을 먼저 정해야 한다.
- 끄는 방향의 고정값은 이미 구현되어 있어 코드 변경이 필요 없다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 두 항목을 완료로 표시하고 이 결정을 참조한다.

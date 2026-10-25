---
status: accepted
---

# WebView console 메시지, 스크립트 초기화 실패와 context-menu 이벤트를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `e43c2d59`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다. Electron v45 기준이다.

백엔드가 WebView 페이지의 console 출력, 문서 초기화 스크립트의 실패, 페이지의 context-menu 요청을 이벤트로 받을지 정해야 했다.

- Electron의 `webContents`는 `console-message`로 페이지의 console 출력(레벨, 메시지, 줄, 소스)을 메인 프로세스에 알리고, 프리로드 스크립트가
  실패하면 `preload-error`를 낸다. `context-menu`는 클릭 위치, 링크와 이미지 URL, 선택 텍스트, 편집 가능 여부를 담아 알리며, 앱이 이 이벤트로
  메뉴를 직접 만든다([ADR 0064](./0064-webview-browser-default-ui.md)).
- Tauri와 wry는 console 메시지나 context-menu를 백엔드로 전달하는 공개 API를 제공하지 않는다. 앱은 페이지의 `contextmenu` DOM 이벤트와
  `invoke`로 처리하고, console은 개발 모드의 DevTools로 본다. 초기화 스크립트(`initialization_script`)가 실패해도 별도 이벤트는 없다.
- WebView2에서 console 출력은 `CallDevToolsProtocolMethod`로 `Runtime.enable`을 호출하고 `DevToolsProtocolEventReceiver`로
  `Runtime.consoleAPICalled`와 `Runtime.exceptionThrown`을 받아야 얻는다. 전용 console 이벤트는 없다. `AddScriptToExecuteOnDocumentCreated`는 스크립트
  ID만 돌려주고 실행 실패를 알리지 않으며, 실패는 위 DevTools 프로토콜의 예외 이벤트로만 보인다. context-menu는 `ICoreWebView2_11`의
  `ContextMenuRequested`가 있다.
- 이 저장소에는 문서 초기화 스크립트 삽입 API가 없다(추적 항목 [#158](https://github.com/mathbook3948/bunaway/issues/158)). 실패를 알릴 대상이
  아직 존재하지 않는다.
- console 출력은 비밀번호나 토큰 같은 민감한 값이 실수로 찍히는 경로다. 항상 켜진 DevTools 프로토콜 세션과 모든 `console.*` 호출의 백엔드 전송은
  모든 앱의 페이지 실행 경로에 상시 관찰 지점과 추가 비용을 만들고, 출력이 많은 페이지에서는 이벤트 폭주를 막는 유량 규칙을 계약으로 정해야 한다.
- 이 저장소의 로그는 `log` 플러그인이 맡고, 페이지가 남기려는 기록은 UI가 명령으로 백엔드에 넘길 수 있다.

## 결정

1. console 메시지, 스크립트 초기화 실패, context-menu 이벤트를 백엔드로 전달하는 이벤트와 API를 추가하지 않는다.
2. 앱은 페이지의 `contextmenu` DOM 이벤트와 메뉴 플러그인의 `showContextMenu`로 context menu를 처리하고, 기록이 필요한 console 출력은 UI가
   `log` 플러그인에 명령으로 보낸다. 개발 중 확인은 개발 모드 DevTools를 쓴다.
3. 문서 초기화 스크립트 API가 생기면 그 결정에서 실패 보고 방식을 함께 정한다. 이때 DevTools 프로토콜 세션을 상시 켜지 않고 해당 스크립트에
   한정하는 방법을 먼저 본다.
4. 페이지 console을 백엔드에서 수집해야 하는 요구가 확인되면 별도 결정에서 다룬다. 레벨 필터, 메시지 길이와 초당 건수 제한, 민감한 값의 취급을
   계약으로 먼저 정한다.

## 근거

- Electron은 세 이벤트를 모두 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는 쪽을 따른다. 쓰는 곳이
  없다(`plugins`, `packages`, `examples`에서 페이지 console이나 context-menu를 호스트 이벤트로 받는 코드는 없고, context menu는 이미
  `showContextMenu`로 처리한다).
- context-menu는 Electron과 같은 범위를 WebView2가 제공하지만 같은 일을 페이지의 DOM 이벤트가 이미 하고, 기본 메뉴를 끈 채 시작하는 현재 방침
  (ADR 0064)에서 호스트 이벤트를 따로 두면 같은 요청을 두 경로로 처리하게 된다.
- console 수집은 항상 켜진 DevTools 프로토콜 세션이 필요해 모든 앱의 실행 경로를 바꾸고, 초기화 스크립트 실패는 스크립트 API가 없어 계약을 정할 수 없다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

---
status: accepted
---

# WebView console 메시지, 스크립트 초기화 실패와 context-menu 이벤트를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `e43c2d59`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다. Electron v45 기준이다.

백엔드가 WebView 페이지의 console 출력, 문서 초기화 스크립트의 실패, 페이지의 context-menu 요청을 이벤트로 받을지 정해야 했다.

- Electron의 `webContents`는 `console-message`로 페이지의 console 출력을 메인 프로세스에 알린다. v35부터 인자는 `details` 객체(`level` 문자열
  `info`, `warning`, `error`, `debug`, `message`, `lineNumber`, `sourceId`, `frame`)이고 위치 인자 형식은 사용 중단이다. 프리로드 스크립트가 처리되지
  않은 예외를 던지면 `preload-error`를 낸다. `context-menu`는 클릭 위치, 링크와 이미지 URL, 선택 텍스트, 편집 가능 여부에 더해 맞춤법 오류 단어와
  제안, 편집 가능 플래그 같은 필드를 담아 알리며, 앱이 이 이벤트로 메뉴를 직접 만든다([ADR 0064](./0064-webview-browser-default-ui.md)).
- Tauri와 wry는 console 메시지나 context-menu를 백엔드로 전달하는 공개 API를 제공하지 않는다. 앱은 페이지의 `contextmenu` DOM 이벤트와
  `invoke`로 처리하고, console은 DevTools로 본다(`devtools` 옵션은 릴리스 빌드에서는 feature를 켜야 한다). 초기화 스크립트
  (`initialization_script`)는 Windows에서 등록 결과만 받고 실행 실패 이벤트는 없다. 앱이 네이티브 WebView 핸들을 꺼내(wry `WebViewExtWindows::webview()`,
  tauri `with_webview`) WebView2 API를 직접 붙일 수는 있으나 이는 프레임워크가 전달하는 API가 아니다.
- WebView2에서 console 출력은 `CallDevToolsProtocolMethod`로 `Runtime.enable`을 호출하고 `DevToolsProtocolEventReceiver`로
  `Runtime.consoleAPICalled`와 `Runtime.exceptionThrown`을 받아야 얻는다. 브라우저가 남기는 메시지는 `Log.enable`과 `Log.entryAdded`로도 받을 수 있고, 페이지 스크립트가 console을 감싸
  `window.chrome.webview.postMessage`로 보내는 앱 구현도 가능하다. 전용 console 이벤트는 없다. `AddScriptToExecuteOnDocumentCreated`의 완료
  핸들러는 등록 결과(`errorCode`)와 스크립트 `id`만 주고 실행 실패를 알리지 않는다. 처리되지 않은 예외는 `Runtime.exceptionThrown`으로 관찰할 수 있을
  것이나 WebView2 문서에 명시되지는 않았고, 페이지 안의 try/catch와 `postMessage`로도 보고할 수 있다. context-menu는 `ICoreWebView2_11`의
  `ContextMenuRequested`가 있다.
- 이 저장소에는 문서 초기화 스크립트 삽입 API가 없다(추적 항목 [#158](https://github.com/mathbook3948/bunaway/issues/158)). 실패를 알릴 대상이
  아직 존재하지 않는다.
- console 출력은 비밀번호나 토큰 같은 민감한 값이 실수로 찍히는 경로다. 항상 켜진 DevTools 프로토콜 세션과 모든 `console.*` 호출의 백엔드 전송은
  모든 앱의 페이지 실행 경로에 상시 관찰 지점과 추가 비용을 만들고, 출력이 많은 페이지에서는 이벤트 폭주를 막는 유량 규칙을 계약으로 정해야 한다.
- 이 저장소의 로그는 `log` 플러그인이 맡고, 페이지가 남기려는 기록은 UI가 명령으로 백엔드에 넘길 수 있다.

## 결정

1. console 메시지, 스크립트 초기화 실패, context-menu 이벤트를 백엔드로 전달하는 이벤트와 API를 추가하지 않는다.
2. 앱은 페이지의 `contextmenu` DOM 이벤트와 메뉴 플러그인의 `showContextMenu`로 context menu를 처리하고, 기록이 필요한 console 출력은 UI가
   `log` 플러그인에 명령으로 보낸다. 개발 중 확인은 개발 모드 DevTools(Windows)를 쓴다.
3. 문서 초기화 스크립트 API가 생기면 그 결정에서 실패 보고 방식을 함께 정한다. 이때 DevTools 프로토콜 세션을 상시 켜지 않고 해당 스크립트에
   한정하는 방법을 먼저 본다.
4. 페이지 console을 백엔드에서 수집해야 하는 요구가 확인되면 별도 결정에서 다룬다. 레벨 필터, 메시지 길이와 초당 건수 제한, 민감한 값의 취급을
   계약으로 먼저 정한다.

## 근거

- Electron은 세 이벤트를 모두 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는 쪽을 따른다. 쓰는 곳이
  없다(`plugins`, `packages`, `examples`에서 페이지 console이나 context-menu를 호스트 이벤트로 받는 코드는 없고, context menu는 이미
  `showContextMenu`로 처리한다).
- context-menu는 WebView2가 위치, 링크, 소스 URL, 선택 텍스트, 편집 가능 여부를 제공해 Electron과 핵심 범위가 같고 맞춤법 필드 등은 다르다. 같은 일을 페이지의 DOM 이벤트가 이미 하고, Windows 호스트가 기본 메뉴를 끈 채
  시작하는 현재 방침(ADR 0064)에서 호스트 이벤트를 따로 두면 같은 요청을 두 경로로 처리하게 된다.
- console 수집을 상시 켜는 설계는 DevTools 프로토콜 세션이 필요해 모든 앱의 실행 경로를 바꾸고, 초기화 스크립트 실패는 스크립트 API가 없어 계약을 정할 수 없다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

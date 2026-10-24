---
status: accepted
---

# WebView 편집 명령과 selection 제어 API를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `ca54708d`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

앱 백엔드가 WebView에 undo, redo, cut, copy, paste, 평문 paste, select-all 같은 편집 명령을 보내는 API와, selection 변경,
텍스트 삽입과 교체, 맨 위와 맨 아래로 스크롤하는 API를 제공할지 정해야 했다.

- Electron의 `webContents`는 `undo`, `redo`, `cut`, `copy`, `paste`, `pasteAndMatchStyle`, `delete`, `selectAll`,
  `unselect`, `replace`, `insertText` 메서드를 제공한다.
- Tauri 2의 `Webview`와 `Window`에는 편집 명령이나 selection을 제어하는 API가 없다. 페이지가 `Selection` API와
  `document.execCommand`를 쓴다.
- 이 저장소의 메뉴 플러그인은 편집 role `undo`, `redo`, `cut`, `copy`, `paste`, `selectAll`을 이미 제공한다. Windows
  호스트는 role을 포커스된 문서에서 `document.execCommand`로 실행하고, paste는 클립보드의 평문(CF_UNICODETEXT)을
  `Input.insertText`로 넣는다. 그래서 평문 paste는 `paste` role의 동작이다. role은 창 메뉴 항목에서만 쓸 수 있고
  트레이 메뉴와 백엔드 호출에서는 거부한다. 같은 origin의 중첩 프레임은 따라가고 cross-origin 프레임은 건드리지
  않는다. 다만 paste는 포커스 확인과 삽입이 서로 다른 호출이라, 그 사이에 포커스가 cross-origin 프레임으로 옮겨지면
  그 프레임이 텍스트를 받을 수 있다. 이 role 구현은 현재 Windows에만 있고 macOS는 이 결정에서 다루지 않는다.
- 페이지 안에서는 `getSelection()`, `Range`, 입력 요소의 `setSelectionRange`, `execCommand("insertText")`,
  `scrollTo`로 selection과 텍스트 삽입, 스크롤을 다룰 수 있다. 호스트가 페이지 소유의 편집 상태를 바꾸면 페이지의
  undo 기록과 입력 이벤트 흐름을 호스트가 알 수 없는 방식으로 건드리게 된다.
- 앱 백엔드의 스크립트 실행과 문서 삽입 계약은 별도 항목에서 다루며, 편집 API가 그 항목을 대신하지 않는다.

## 결정

1. 편집 명령(undo, redo, cut, copy, paste, 평문 paste, select-all)을 WebView에 보내는 별도 API를 추가하지 않는다.
   사용자 조작으로 시작하는 편집은 메뉴 role로 제공하며, 이미 지원하는 범위가 이 항목이 요구하는 명령을 덮는다.
2. selection 변경, 텍스트 삽입과 교체, 스크롤 이동 API를 추가하지 않는다. 앱은 렌더러에서 위 웹 표준 API를 쓰고,
   백엔드가 시작해야 하면 앱 명령으로 렌더러에 요청을 보낸다.
3. 서식 있는 붙여넣기와 `pasteAndMatchStyle` 구분은 만들지 않는다. Windows의 `paste` role은 평문만 넣는다.
4. 위 방법으로 만들 수 없는 용도가 확인되면 별도 결정에서 다룬다. 이때 호스트가 만든 편집이 사용자 제스처나
   클립보드 권한을 대신하지 않는 형태로만 검토한다.

## 근거

- 두 프레임워크가 다르다. Electron은 제공하고 Tauri는 제공하지 않는다. 사용자가 시작하는 편집은 메뉴 role로 이미
  덮고, 나머지는 렌더러의 웹 표준 API로 같은 일을 할 수 있다. 이 저장소에서 쓰는 곳이 없는 기능을 위해 코어 API와
  DevTools 프로토콜 경로를 늘리지 않는다.
- 백엔드가 호출하는 `cut`, `copy`, `paste` API는 사용자 활성화 없이 클립보드를 읽고 쓰는 경로가 된다. 메뉴 role은
  사용자가 창 메뉴에서 항목을 고른 경우에만 실행되고, 호스트는 그 선택을 사용자 활성화로 삼아 `userGesture`를 켜서
  실행한다. 별도 API는 사용자 선택 없이 이 활성화를 대신하게 되므로 그 경계를 먼저 정해야 한다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 두 항목을 완료로 표시하고 이 결정을 참조한다.

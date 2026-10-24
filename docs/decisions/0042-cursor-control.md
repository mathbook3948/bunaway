---
status: accepted
---

# 커서 아이콘, 표시, 위치 설정과 grab을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `57fc4069`.

## 배경

창 API에 커서 조회(`windows.getCursorPosition`)는 있다. 이에 더해 커서 아이콘 변경, 커서 숨김, 커서 위치 이동,
커서를 창 안에 가두는 grab을 제공할지 정해야 했다.

- Electron의 `BrowserWindow`와 `screen`에는 커서 아이콘, 표시, 위치 이동, grab을 바꾸는 API가 없다.
  `screen.getCursorScreenPoint()`로 위치를 읽기만 한다. 페이지 안의 아이콘과 숨김은 렌더러의 CSS `cursor`(`none` 포함)로
  다룬다. 웹 표준 Pointer Lock API는 커서를 숨기고 상대 이동값만 주며, 보이는 커서를 창 안에 제한하는 방법은 아니다.
- Tauri 2의 `Window`는 `setCursorIcon`, `setCursorVisible`, `setCursorPosition`, `setCursorGrab`을 제공하고
  `cursorPosition`으로 조회한다. tao는 Windows에서 각각 `SetCursor`, `ShowCursor`, `SetCursorPos`,
  `ClipCursor`로 구현한다.
- `SetCursorPos`와 `ClipCursor`는 호출한 프로세스가 아니라 사용자 세션의 커서에 작용한다. `SetCursorPos`는 다른 앱
  위로 커서를 옮겨 사용자의 다음 클릭을 그 앱에 보낼 수 있고, `ClipCursor`는 커서를 가둔 동안 사용자가 다른 앱으로
  커서를 옮기지 못하게 하므로 해제 시점을 호스트가 책임져야 한다.

## 결정

1. 커서 아이콘, 커서 표시 설정, 커서 위치 이동, grab API를 제공하지 않는다. 조회 API인 `getCursorPosition`만 유지한다.
2. 페이지 안의 아이콘과 숨김은 렌더러의 CSS `cursor`로 다룬다. 상대 이동값이 필요한 앱은 렌더러의 Pointer Lock API를
   쓴다. 보이는 커서를 창 안에 제한하는 방법은 제공하지 않는다. 문서의 `getCursorPosition` 절에 이 내용을 적는다.
3. WebView 밖의 창 가장자리(크기 조절 테두리, 제목 표시줄)의 커서는 OS가 정하며, 이 영역의 커서 변경은 지원하지 않는다.
   문서에도 같은 내용을 적는다.
4. 위 방법으로 만들 수 없는 용도가 확인되면 별도 결정에서 다룬다. 이때 사용자 세션 전체에 작용하는 위치 이동과 grab은
   포커스 상실과 종료 시 해제를 호스트가 보장하는 형태로만 검토한다.

## 근거

- 두 프레임워크가 다르다. Electron은 제공하지 않고 Tauri는 제공한다. 이 저장소에서 쓰는 곳이 없고, 페이지 안의 커서
  모양과 숨김은 CSS로 같은 결과를 낸다. 쓰는 곳이 없는 기능을 위해 코어 API를 늘리지 않고 Electron을 따른다.
- 위치 이동과 grab은 다른 앱의 입력에 영향을 준다. 사용처 없이 권한 하나로 열면 해제 보장과 포커스 상실 처리까지
  호스트가 떠안는다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 `getCursorPosition` 절에 설정 API가 없다는 점, CSS와 Pointer Lock 대안, 창 가장자리 커서는 OS가
  정한다는 점을 적는다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시한다.

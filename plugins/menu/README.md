# menu

`@bunaway/plugin-menu`는 앱 수명의 메뉴 리소스와 Windows 트레이, 창 메뉴 막대, 컨텍스트 팝업을 제공한다.
공개 입력, 결과, 권한과 제한은 [menu API](../../docs/site/src/content/docs/reference/plugins/menu.mdx)를 따른다.

중립 계약은 `defineNativePlugin`과 Zod로 선언하고 `bun run plugins:build`로 빌드한다.
플랫폼 어댑터는 UI Worker에서 정의와 연결을 소유한다. 메뉴 조회는 복사본을 반환하고
변경은 후보 트리 전체 검증 뒤 커밋한다. 트레이가 받는 `NativeMenuItem` 계약은
`@bunaway/plugin-api/native`에 둔다. 공통 Windows 전용 `@bunaway/plugin/windows-menu`의
`NativePopupMenu`가 HMENU와 모든 하위 메뉴를 소유한다. 창 메뉴는 연결 해제나 창 종료 때,
팝업은 표시 종료나 생성 실패 때 해제한다. checkbox와 radio 선택은 상태를 자동 변경하지 않는다.
`setWindowMenu`는 창에 메뉴를 연결하고 `setWindowMenuVisible`은 연결을 유지한 채 HWND에서 HMENU만 떼었다 붙여 메뉴바를 숨기고 표시하며, `showContextMenu`는 화면 물리 좌표에 임시 팝업을 표시한다.
리소스 하나는 트레이나 창 하나에만 연결할 수 있다. 팝업은 독립 복사본을 사용하며 요청 신호로 취소한다.
편집 role(undo, redo, cut, copy, paste, selectAll)은 `type: "item"`에만 허용한다. 스키마가
생략한 label을 기본 label로 채우고, `NativePopupMenu`가 role의 표시용 단축키 문구를 붙이며 선택 때
role을 알려 준다. `WindowMenus`는 role 선택을 `menu.clicked` 없이 창 호스트의 `executeRole`로 넘기고,
호스트가 해당 창 WebView에 DevTools 프로토콜의 `Runtime.evaluate`로 `document.execCommand`를 실행한다(포커스된
document를 따라가며 키 이벤트는 만들지 않는다). paste는 `execCommand("paste")`가 거부되므로 호스트가
클립보드의 CF_UNICODETEXT를 한 번 읽어 `Input.insertText`로 넣는다(`paste` 이벤트 대신 `beforeinput`).
cross-origin iframe에 포커스가 있으면 실행하지 않는다.
`type: "item"`(role 포함)과 submenu는 선택 필드 `icon`(tray `setIcon`과 같은 base64 ICO, null이면 없음)을
가진다. 스키마가 ICO 디렉터리를 검사하고 checkbox, radio, separator의 icon은 거부한다. `NativePopupMenu`가
`SM_CXSMICON` 크기의 32bpp premultiplied-alpha DIB section을 트리 인스턴스마다 만들어
`MENUITEMINFOW.hbmpItem`(MIIM_BITMAP)에 설정하고, 트리를 해제할 때 DeleteObject로 함께 해제한다.
`updateItem.changes.icon`은 다른 변경과 같이 트리를 다시 만들어 반영한다.
트레이 메뉴는 role을 `INVALID_ARGUMENT`로 거부한다. 가속키 등록과 앱 전체 기본 메뉴는 지원하지 않는다.

`tests/api/menu.test.ts`는 계약, 제한, 권한, 변경 실패 보존과 이전 선택 폐기를 검사한다.
`api/menu-icon.test.ts`는 icon 스키마, 거부 규칙과 `updateItem` 변경을,
`lifecycle/windows-menu-icon.test.ts`는 실제 HMENU의 `GetMenuItemInfoW` hbmpItem 설정, 교체, 제거와 해제를 검사한다.
`tests/lifecycle/windows-menu.test.ts`는 실제 Win32 메뉴의 순서, 상태, Unicode와 자원 해제를 확인한다.
`windows-menu-ui.test.ts`는 실제 UI Worker와 창 없는 트레이의 API 호출 및 숨긴 HWND 정리를 검사한다.
`api/window-menu.test.ts`는 창 연결, 변경, 선택 이벤트와 팝업 취소 계약을 검사한다.
`lifecycle/windows-window-menu.test.ts`는 실제 창 연결과 중첩 메뉴 선택, 크기 보존,
UI Worker의 팝업 취소 및 메뉴 막대 종료를 검사한다.
`lifecycle/windows-menu-roles.ts`는 실제 WebView2 창에서 메뉴바와 컨텍스트 팝업의 role 선택이
textarea, 클립보드와 undo 이력을 바꾸고 선택 이벤트를 만들지 않음을 검사한다.
Windows 테스트는 `mise run host:windows`에 포함되며 Linux에서는 건너뛴다.
실제 포인터 클릭, 키보드 메뉴 조작과 Explorer 재시작 중 사용자 정의 메뉴는 수동 검증이 남아 있다.

창이 없는 백엔드의 다음 입력 대기는 공통 SDK의 NativeEventWaiters를 사용한다.
최대 16개 대기를 유지하며 신호 취소와 어댑터 종료에서 모두 해제한다. 입력 이력과 앱 실행 유지 조건은 소유하지 않는다.

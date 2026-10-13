# menu

`@bunaway/plugin-menu`는 앱 수명의 메뉴 리소스와 Windows 트레이 연결을 제공한다.
공개 입력, 결과, 권한과 제한은 [menu API](../../docs/site/src/content/docs/reference/plugins/menu.mdx)를 따른다.

중립 계약은 `defineNativePlugin`과 Zod로 선언하고 `bun run plugins:build`로 빌드한다.
플랫폼 어댑터는 UI Worker에서 정의와 연결을 소유한다. 메뉴 조회는 복사본을 반환하고
변경은 후보 트리 전체 검증 뒤 커밋한다. 트레이가 받는 `NativeMenuItem` 계약은
`@bunaway/plugin-api/native`에 둔다. 호스트의 `NativePopupMenu`가 HMENU와 모든 하위 메뉴를
소유하며 팝업 종료나 생성 실패 때 해제한다. checkbox와 radio 선택은 상태를 자동 변경하지 않는다.

`tests/api/menu.test.ts`는 계약, 제한, 권한, 변경 실패 보존과 이전 선택 폐기를 검사한다.
`tests/lifecycle/windows-menu.test.ts`는 실제 Win32 메뉴의 순서, 상태, Unicode와 자원 해제를 확인한다.
`windows-menu-ui.test.ts`는 실제 UI Worker와 창 없는 트레이의 API 호출 및 숨긴 HWND 정리를 검사한다.
두 Windows 테스트는 `mise run host:windows`에 포함되며 Linux에서는 건너뛴다.
실제 포인터 클릭, 키보드 메뉴 조작과 Explorer 재시작 중 사용자 정의 메뉴는 수동 검증이 남아 있다.

창이 없는 백엔드의 다음 입력 대기는 공통 SDK의 NativeEventWaiters를 사용한다.
최대 16개 대기를 유지하며 신호 취소와 어댑터 종료에서 모두 해제한다. 입력 이력과 앱 실행 유지 조건은 소유하지 않는다.

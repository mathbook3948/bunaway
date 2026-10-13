# globalShortcut

`@bunaway/plugin-global-shortcut`는 Windows RegisterHotKey 기반 전역 단축키를 제공한다.
공개 계약은 [globalShortcut API](../../docs/site/src/content/docs/reference/plugins/global-shortcut.mdx)를 따른다.
`defineNativePlugin`과 Zod로 작업을 선언하며 `bun run plugins:build`로 중립 및 Windows 출력을 만든다.

UI 어댑터가 등록 상태, 중지 상태, 숨긴 HWND와 DLL 바인딩을 소유한다.
등록된 조합만 `WM_HOTKEY`로 받고 정책과 구독을 검사하는 기존 이벤트 경로로 전달한다.
메시지 ID를 재사용하지 않으므로 이전 등록의 큐 입력이 재개나 재등록 뒤 새 이벤트가 되지 않는다.
중지와 rollback 실패에서도 남은 OS 등록의 소유권을 보존한다. 종료는 명시적 해제를 시도하고
숨긴 HWND를 파괴해 남은 등록을 정리한다. 앱 실행 유지 정책은 호스트가 계속 소유한다.

`tests/api/global-shortcut.test.ts`는 계약, 권한, 충돌 rollback, 중지와 재개, 오래된 메시지와
자원 실패를 검사한다. `tests/lifecycle/windows-global-shortcut.test.ts`는 실제 RegisterHotKey,
경쟁 HWND, SendInput에 의한 OS 입력, 중지 및 재개와 자원 해제를 확인한다.
Windows 네이티브 CI의 `mise run host:windows`에 포함하며 Linux에서는 건너뛴다.
이 테스트는 물리 키보드, 다양한 키보드 레이아웃과 사용자 입력 조합을 검증했다는 뜻이 아니다.

창이 없는 백엔드의 다음 입력 대기는 공통 SDK의 NativeEventWaiters를 사용한다.
최대 16개 대기를 유지하며 신호 취소와 어댑터 종료에서 모두 해제한다. 입력 이력과 앱 실행 유지 조건은 소유하지 않는다.

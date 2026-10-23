# Examples

[memo/](./memo/README.md)는 CLI 생성 앱과 같은 구조를 사용하는 독립 메모 앱이다.
예제 폴더에서 `bun run dev`, `bun run build`, `bun run package`를 실행한다.
실제 클라이언트 SDK, 백엔드 SDK, Host API를 사용하며 창 하나에서 메모를 작성하고 저장한다.
네이티브 회귀 테스트의 여러 창과 자동 실행 시나리오는 테스트 fixture에 있다.

[tray-notes/](./tray-notes/README.md)는 트레이, `keep-alive`, window-state 저장, 닫기 요청을 함께 쓰는 단일 창 상주 앱이다.
트레이 Open이 다시 만든 창은 항상 표시하며 Windows에서 동작한다.

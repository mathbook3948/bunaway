# Tests

- `protocol/`: 직렬화·버전 협상·오류 계약.
- `api/`: 모듈 공통 타입, 명령 input/output, Host API 컨텍스트, 취소, 오류 계약,
  클라이언트 기본 연결의 지연 초기화, 문서/HMR 공유, 구독 해제, 실패, 취소, 문서 종료 정리.
- `core/`: 명령·상태·이벤트·플러그인.
- `conformance/`: 네이티브 호스트 간 공통 계약.
- `security/`: 권한·origin·세션·파일 범위.
- `lifecycle/`: 종료·재연결·모바일 수명주기.

`mise run test`는 프로토콜·정책·SDK·코어·Host API의 계약 테스트와 네이티브용 생성
스키마 일치 검사를 실행한다. `mise run check`에는 테스트와 테스트 코드의 타입 검사도 포함한다.
코어·SDK 테스트와 `runtime-bun.test.ts`의 실제 Bun 프로세스 IPC 테스트를 포함한다.
런타임 테스트는 플러그인 초기화 중 Host API, 응답 컨텍스트, 취소·폐기·늦은 응답,
새 세션, 종료 훅·EOF와 부팅 전/초기화 중 종료를 확인한다.
`mise run host:windows`는 C++ 컴파일 없이 Bun UI Worker의 실제 WebView2·SDK·권한·
다중 창·저장·메모 복원·렌더러 복구·정상/비정상 종료를 검증한다.
모달 중 메인의 타이머·Promise·네트워크와 초기화 중 닫기·생성 실패·파일 핸들 경계,
이동한 독립 CLI 프로젝트도 포함한다. [실행 결과](../docs/architecture/windows-bun-results.md).
공통 앱·화면 데이터는 `tests/fixtures/desktop/host/`에서 Windows/macOS가 공유한다.
예전 Windows C++ 호스트/probe와 전용 실행기·테스트는 삭제했다.
`backend-startup.test.ts`는 macOS 프로세스 probe 백엔드로 boot 전후 종료와 버전·세대 검증을 확인한다.
다른 플랫폼·모바일 수명주기의 검증 완료를 뜻하지 않는다.

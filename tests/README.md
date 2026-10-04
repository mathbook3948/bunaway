# Tests

- `protocol/`: 직렬화·버전 협상·오류 계약.
- `api/`: 모듈 공통 타입, 명령 input/output, Host API 컨텍스트·취소·오류 계약.
- `core/`: 명령·상태·이벤트·플러그인.
- `conformance/`: 네이티브 호스트 간 공통 계약.
- `security/`: 권한·origin·세션·파일 범위.
- `lifecycle/`: 종료·재연결·모바일 수명주기.

`mise run test`는 구현된 프로토콜·정책의 계약 테스트와 네이티브용 생성 스키마의
일치 여부를 검사한다. `mise run check`에는 테스트와 테스트 코드의 타입 검사도 포함한다.
제품 코어·SDK·WebView·보안 집행 테스트는 해당 구현 뒤 추가한다.
`mise run probe:windows`는 별도로 Windows 네이티브 패키지를 빌드하고 실제 Bun 프로세스
IPC·정상/강제 종료 통합 검증 33개를 실행한다.

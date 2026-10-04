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
IPC·정상/강제 종료 통합 검증 39개를 실행한다. TypeScript와 C++에 같은 입력 51개를
넣는 검증기 회귀 테스트, 출력 소비 중단·살아 있는 Bun의 stdout EOF·Unicode 오류도 포함한다.
단독 surrogate는 값·객체 키에서 송신 전에 거부하고 정상 이모지는 IPC로 왕복한다.
U+2028·U+2029 경로 순회 우회와 `required` 생략 시 선택 속성의 타입 추론도 검사한다.
`anyOf`의 공통 필수 필드·분기 타입과 정책·bootstrap·boot 프레임의 중복 view ID 거부도 검사한다.
폐기 뒤에 listen 성공 응답을 보내는 테스트 백엔드로 구독 복원·이벤트 전달을 차단하는지 검사한다.
빈 객체와 배열 스키마의 입력·출력 형태는 컴파일 오류 검증과 실제 명령 실행으로 확인한다.

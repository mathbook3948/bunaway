# 구현 진행 상태

기준일: 2026-10-04. PRD의 제품 범위와 단계별 완료 조건은 그대로 유지한다.

| 단계 | 현재 결과 | 남은 작업 |
| --- | --- | --- |
| 개발 환경 | mise 기반 Bun 1.4.2, 8개 workspace, 타입 환경 분리, 포맷·린트 | 실행 가능한 앱이 생기면 dev/build 추가 |
| A 계약 | IPC·정책 단일 스키마, 타입 추론, JSON 검증·직렬화, 버전 협상, 네이티브 스키마 생성, C ABI 초안, 런타임 후보 조사 | 실제 호스트에서 계약 적용, Bun 소스·패치 최종 고정 |
| B 내장 실현성 | 현재 도구와 Windows·모바일 최소 실험 조건 기록 | 앱 프로세스 내 Bun 실행과 수명주기 증거. 아직 어떤 플랫폼도 통과하지 않음 |
| C 수직 기능 | 미착수 | UI→명령→범위 제한 저장→이벤트와 종료·권한 거부 검증 |
| D~F | 미착수 | 플랫폼 확장·배포·선택 렌더러 |

## 구현된 API

`@bunaway/protocol`의 `parseMessage`, `serializeMessage`, `parsePolicy`,
`negotiateProtocol`과 관련 타입·스키마를 사용할 수 있다. 호스트 전용으로
`parseBootstrap`, `parseHostResponse`, `serializeHostResponse`도 구현했다.
이것은 데이터 계약 계층이다.
명령 실행·세션 인증·실제 권한 검사·요청 취소·이벤트 라우팅은 아직 없다.

`mise run check`로 포맷·린트·8개 패키지와 테스트의 타입·계약 테스트를 확인한다.
`mise run protocol:generate`로 네이티브 JSON Schema를 갱신하며 생성 파일의 내용이
원본과 달라지면 테스트가 실패한다. C ABI 헤더는 MSVC에서 C와 C++ 문법 검사를 했다.
이 검사는 링크·호출 규약·VM 구동·종료를 검증하지 않는다.

이번 변경에서 Bun 1.4.2로 계약 테스트 20개와 전체 `mise run check`를 통과했다.
크기·깊이 경계, 위조 필드, 동적 객체의 직렬화, 정책 검증과 생성 스키마 일치를 포함한다.

## 이어서 할 작업

1. [런타임 실현성 기록](./runtime-feasibility.md)의 Windows 최소 실험을 수행한다.
   Bun 전체 SHA와 빌드 도구·패치를 고정하고, 같은 프로세스에서 산술·비동기·오류·종료를 확인한다.
2. [IPC 계약](./protocol.md)을 따르는 client-sdk와 core의 명령 왕복을 구현한다.
   테스트용 transport 성공과 실제 네이티브 경계 통과를 구분한다.
3. 네이티브 브리지에서 세션·origin·frame 검증, 정책 집행과 실제 파일 접근 경계를 연결한다.
4. Android·iOS는 각각 전용 도구·기기로 검증하고 실행하지 않은 항목은 미검증으로 남긴다.

[C ABI 초안](./native-abi.md)과 [모듈 의존성](./workspace.md)은 구현 중 함께 갱신한다.

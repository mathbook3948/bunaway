# 구현 진행 상태

기준일: 2026-10-04. B 단계는 번들된 Bun 자식 프로세스와 IPC 검증으로 수정했다.

| 단계 | 현재 결과 | 남은 작업 |
| --- | --- | --- |
| 개발 환경 | mise 기반 Bun 1.4.2, 8개 workspace, 타입 환경 분리, 포맷·린트 | 실행 가능한 앱이 생기면 dev/build 추가 |
| A 계약 | IPC·정책 단일 스키마, 타입 추론, JSON 검증·직렬화, 버전 협상, 네이티브 스키마 생성. 이전 C ABI는 기록으로 보존 | 프로세스 IPC envelope·프레이밍 구현, 실제 호스트에서 계약 적용 |
| B 번들 실행 실현성 | DLL 실험 중단, Windows 번들 Bun 자식 프로세스·IPC 계획으로 변경 | 배포물 버전·revision·해시 고정, 실행·산술·Promise·타이머·요청·응답·이벤트·오류·프로세스 정리. 아직 미검증 |
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
원본과 달라지면 테스트가 실패한다. 이전 C ABI 헤더는 MSVC에서 C와 C++ 문법 검사를 했다.
이 기록은 현행 프로세스 IPC 실행·종료 검증 결과가 아니다.

A 단계 기록에서는 Bun 1.4.2로 계약 테스트 20개와 전체 `mise run check`를 통과했다.
크기·깊이 경계, 위조 필드, 동적 객체의 직렬화, 정책 검증과 생성 스키마 일치를 포함한다.

## 이어서 할 작업

1. [B 단계 계획](./runtime-feasibility.md)의 WebView 없는 Windows 최소 실험을 수행한다.
   앱 패키지의 Bun을 절대 경로로 실행하고, 실제 IPC로 산술·Promise·타이머·요청·응답·이벤트·
   오류와 앱 종료 시 Bun 프로세스 정리를 확인한다. 사용자 Bun 설치나 PATH에 의존하지 않는다.
2. [IPC 계약](./protocol.md)을 따르는 client-sdk와 core의 명령 왕복을 구현한다.
   테스트용 transport 성공과 실제 네이티브 경계 통과를 구분한다.
3. 네이티브 브리지에서 세션·origin·frame 검증, 정책 집행과 실제 파일 접근 경계를 연결한다.
4. Android·iOS의 Bun 실행·배포 경로는 D 단계에서 전용 도구·기기로 별도 검증한다.
   Windows 자식 프로세스 방식의 성공을 모바일 성공으로 간주하지 않는다.

[C ABI 초안](./native-abi.md)은 이전 동일 프로세스 설계의 기록이다.
현재 구현은 프로세스 IPC와 [모듈 의존성](./workspace.md)을 따른다.

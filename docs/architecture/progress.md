# 구현 진행 상태

기준일: 2026-10-04. Windows B 단계의 번들 Bun 프로세스·IPC 검증을 완료했다.

| 단계 | 현재 결과 | 남은 작업 |
| --- | --- | --- |
| 개발 환경 | mise 기반 Bun 1.4.2, 8개 workspace, 타입 환경 분리, 포맷·린트 | 실제 앱의 dev/build 추가 |
| A 계약 | Web·프로세스 IPC·정책 단일 스키마, 타입 추론, JSON 검증·직렬화, 버전 협상, 네이티브 스키마 생성 | 제품용 세션·권한 집행 연결 |
| B 번들 실행 실현성 | Windows x64 baseline Bun 1.4.2 고정, C++ 독립 패키지, IPC·계산·이벤트·오류·정상/강제 종료 검증 통과 | 다른 OS와 설치·배포는 후속 단계 |
| C 수직 기능 | 공통 API·Host operation 스키마·명령 검증·컨텍스트 바인딩과 계약 테스트 준비 | client-sdk·core·WebView 호스트 병렬 구현과 실제 저장·이벤트 연결 |
| D~F | 미착수 | 플랫폼 확장·배포·선택 렌더러 |

## 구현된 API와 검증

`@bunaway/protocol`의 Web 메시지·정책·부트 설정·Host API 응답과 프로세스 envelope를
파싱·직렬화하고 버전을 협상할 수 있다. `@bunaway/runtime-bun`은 파이프 읽기 단위와
별개로 NDJSON 프레임을 조립하고 UTF-8·크기·EOF를 검사한다.

`native/windows/probe/`는 WebView 없는 C++ 실험 호스트다. 생성 process 스키마를 읽고,
자신의 위치에서 검증한 Bun을 suspended 생성→Job 배정→실행한다. 전용 파이프로
실험 백엔드와 통신하고 실제 종료·관리 대상 프로세스 0개를 확인한다.
고정된 실험 컨텍스트의 구독·이벤트·해제·늦은 응답 폐기와 종료 시 요청 실패를 구현했다.
제품용 명령 레지스트리·세션 인증·권한 집행·다중 뷰 라우팅은 아직 없다.

[C 공통 API](./common-api.md)를 타입과 계약 테스트로 고정했다. Transport·ClientFactory,
CoreFactory·세션·RuntimeServices, 앱·플러그인 정의와 Host API를 각 패키지에서 공유한다.
backend의 command는 실제 input/output 검증을 수행하고 runtime-bun의 bindHostAPI는
호출 컨텍스트를 유지하며 취소·오류·응답 스키마를 검사한다.
SDK·코어 factory의 실행 구현과 네이티브 Host operation 실행은 다음 병렬 작업이다.

`mise run check`로 포맷·린트·8개 패키지와 테스트의 타입·계약 테스트를 확인한다.
`mise run protocol:generate`로 네이티브 JSON Schema를 갱신하며 원본과 다르면 테스트가 실패한다.
`mise run probe:windows`로 독립 패키지를 만들고 실제 Windows 프로세스 검증을 실행한다.
[Windows B 실행 결과](./windows-probe-results.md)에 환경·manifest·관찰과 제한을 기록했다.

## 이어서 할 작업

1. [IPC 계약](./protocol.md)을 따르는 client-sdk와 core의 명령 왕복을 구현한다.
   테스트용 transport 성공과 실제 네이티브 경계 통과를 구분한다.
2. WebView2 브리지의 세션·origin·frame 검증과 정책 집행을 연결한다.
3. 파일을 실제로 여는 네이티브 경계에서 저장 범위를 검사하고, 명령→저장→이벤트를 검증한다.
   읽기 전용 설치 디렉터리와 앱 데이터·임시 디렉터리를 분리한다.
4. Android·iOS의 Bun 실행·배포 경로는 D 단계에서 전용 도구·기기로 별도 검증한다.
   Windows 자식 프로세스 방식의 성공을 모바일 성공으로 간주하지 않는다.

[C ABI 초안](./native-abi.md)은 이전 동일 프로세스 설계의 기록이다.
현재 구현은 프로세스 IPC와 [모듈 의존성](./workspace.md)을 따른다.

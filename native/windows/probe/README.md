# Windows bundled-process probe

저장소 루트에서 `mise run probe:windows`를 실행한다.
PowerShell 7, MSVC C++ Build Tools와 CMake/Ninja가 개발 환경에 필요하다.

`run.ps1`은 고정 해시의 공식 Bun·JSON 헤더·라이선스를 내려받고,
정적 CRT C++ 호스트와 Bun 백엔드를 독립 패키지로 빌드한 뒤 실제 프로세스 검증을 실행한다.
`-SkipTests`는 패키지만 만들고 `-Bun <path>`는 고정 버전의 개발 Bun을 직접 지정한다.

호스트는 자신의 위치 기준 Bun을 절대 경로로 실행한다. 패키지 사용자에게 Bun 설치를
요구하지 않는다. stdin/stdout은 NDJSON 제어기용이며 stdout 진단과 backend envelope를
외부 검증기가 읽는다. stderr는 로그다. 프레임 1 MiB·깊이 64·큐/미완료 요청 128개,
ID 기록 1024개, 부팅 10초·Bun 종료 2초·종료 후 출력 정리 2초 한도를 둔다.
제어기로 보내는 출력도 128개 큐에 순서를 확정한 뒤 전용 스레드가 잠금 밖에서 쓴다.
큐 초과·출력 실패는 프로세스 정리를 시작한다. 출력 대기는 다음 요청·폐기·shutdown 수신을 막지 않는다.
stdout 소비가 중단되면 출력 쓰기와 최종 진단 쓰기도 취소하고 실패 상태로 종료한다.
백엔드 stdout의 예상하지 않은 EOF는 Bun 생존 여부와 관계없이 연결 장애로 처리한다.

`normal` 외의 실행 모드는 오류·비정상 종료·자손 정리 검증용이다.
`--watch <pid> ...`는 OS 핸들로 프로세스 종료를 관찰하는 테스트 보조 모드다.
`--validate`는 stdin의 `{schema,value}` NDJSON을 같은 C++ 검증기로 검사하는 테스트 모드다.
`probe.close-stdout`은 테스트에서만 Windows 표준 출력 핸들을 닫고 Bun을 계속 실행한다.
제품용 WebView·SDK·core·Host API와 권한 집행은 이 실험에 포함하지 않는다.

[실행 결과](../../../docs/architecture/windows-probe-results.md)를 참고한다.

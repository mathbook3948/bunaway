# Windows 제품 호스트

저장소 루트에서 `mise run host:windows`를 실행한다.
PowerShell 7, MSVC C++ Build Tools, CMake/Ninja와 WebView2 Evergreen 런타임이 필요하다.

`run.ps1`은 고정 해시의 공식 Bun·nlohmann/json 헤더·WebView2 SDK와 라이선스를
내려받아 정적 CRT C++ 호스트와 번들 Bun 백엔드·Web 자산을 패키지로 만든 뒤
실제 Windows 통합 검증을 실행한다. `-SkipTests`는 패키지만 만들고
`-Bun <path>`는 고정 버전의 개발 Bun을 직접 지정한다.
`-Sample`은 [메모 앱](../../../examples/memo/README.md)을 `build/windows-memo-package/`로
패키징한다. 기본 출력 패키지는 `build/windows-host-package/`다. `bunaway-host.exe`,
`runtime/bun.exe`, `assets/`에 백엔드·Web 자산·스키마·정책·앱 설정,
`manifest.json`에 자산 해시, `licenses/`에 라이선스를 담는다.

호스트는 자신의 위치 기준 Bun을 절대 경로로 실행한다. 사용자에게 Bun 설치를
요구하지 않고 PATH·부모 환경 변수·cwd의 `.env`·preload를 신뢰하지 않는다.
Bun에는 `--no-env-file --no-install`과 패키지의 `bunfig.toml`·`tsconfig.json`을
하나의 인자로 전달하고, 자식 환경은 허용 목록으로 다시 만든다.

## 경계

- WebView2는 가상 호스트 `app.bunaway.local` 아래 패키지 Web 자산만 로드한다.
  원격 탐색·iframe·지원하지 않는 스킴·권한 요청은 거부한다.
- Web 메시지는 실제 WebView 인스턴스·origin·최상위 문서와 활성 세션을 확인한 뒤
  hello/invoke/cancel/listen/unlisten만 받는다. Web payload가 컨텍스트·권한·
  내부 제어 프레임을 선택할 수 없다. 거부 로그에 payload를 남기지 않는다.
- 세션 컨텍스트는 호스트가 `ctx-<random>`으로 발급한다. 탐색·뷰 폐기·종료는
  `session-open`/`revoke` 호스트 전용 프레임으로 백엔드에 알린다.
  History API의 같은 문서 URL 변경은 WebView2 `SourceChanged`로 추적하며
  기존 세션·구독을 유지한다. 새 문서 탐색은 기존대로 세션을 폐기한다.
- 런타임 식별자·세대를 프레임 봉투로 검증해 지연·교차 프레임을 폐기한다.
- 명령·이벤트는 `policy.json`의 뷰 정책을 매 연산마다 다시 확인한다.
- Host operation(`storage.readText`·`storage.writeText`·`log.write`·
  `capabilities.get`)은 별도 작업 스레드에서 실행하고 host-cancel로 마킹한다.
  취소·지연·세션 종료 뒤 결과는 폐기한다.
- 저장은 `%LOCALAPPDATA%/bunaway/<appId>`의 `appData`·`temp` 범위로 제한한다.
  경로는 어휘 검사 후 실제 파일을 여는 경계에서 다시 검사한다. reparse point·
  다중 링크·디렉터리·최종 경로의 canonical 범위 이탈을 거부하고 읽기는 4 MiB다.
  읽기·쓰기 모두 루트와 중간 디렉터리 핸들을 최종 파일 검사까지 유지해 junction
  탐색과 검사 중 경로 교체를 막는다. 읽은 내용의 JSON 응답이 IPC 1 MiB 한도를
  넘으면 `INTERNAL` 오류를 반환한다.
  설치 자산과 쓰기 가능한 데이터는 분리한다.
- 프레임 1 MiB·깊이 64, 송신 큐·미완료 요청·구독 128개, 요청 ID 기록 1024개,
  부팅 10초·종료 2초·요청 기한 30초 한도를 둔다. `deadline` 필드로 더 짧은
  기한을 요청할 수 있고 초과 시 `TIMEOUT` 오류와 `cancel` 프레임을 보낸다.
  UI 메시지 큐 포화로 응답·이벤트를 전달하지 못하면 런타임을 실패 처리한다.
  실패·종료 알림도 큐에 들어가지 못한 경우 UI 타이머가 종료를 진행한다.
- Bun 자식은 중단 상태로 생성해 Job Object에 넣은 뒤 재개한다. 뷰 폐기·창 종료·
  backend 장애·큐 초과·기한 초과는 Job kill로 정리한다. 호스트를 강제 종료해도
  Job이 Bun과 자손을 정리한다.

## 진단

`logs/host.log`는 구조화된 이벤트 NDJSON, `logs/app.log`는 `log.write` 출력,
`logs/backend.log`는 Bun stderr다. `--watch <pid> ...`는 OS 핸들로 프로세스
종료를 관찰하는 테스트 보조 모드, `--validate`는 stdin의 `{schema,value}`
NDJSON을 C++ 검증기로 검사하는 테스트 모드다.

백엔드 `test/backend.ts`와 메모 샘플은 `runtime-bun.runBunApp`으로 실제 `createCore`를
부팅한다. Web 자산은 `createClient`·`createWebViewTransport`를 브라우저 대상으로
번들한다. 위조·잘못된 메시지 테스트만 SDK 밖에서 원시 입력을 보낸다.
코어 등록·플러그인 초기화가 끝난 뒤 ready를 보내며, 호스트는 ready와 WebView 준비가
모두 끝난 후 첫 문서를 탐색한다. 플러그인 초기화의 Host API도 허용하며 IPC 읽기는
코어 초기화와 명령 완료를 기다리지 않아 같은 파이프의 응답을 계속 처리한다.

`tests/lifecycle/windows-host-native.cpp`는 실제 호스트 코드를 사용하는 네이티브
회귀 테스트다. 세션 폐기 후 대기 중 저장 작업·늦은 응답 폐기, UI 큐에서 이전
문서의 메시지 차단, 파일 축소에 따른 조기 EOF 처리, 큰 파일·이스케이프 문자로
인한 응답 크기 초과와 이후 일반 읽기 복구를 검증한다. WebView2 통합 검증은
같은 저장 영역 안의 junction으로 `pathPrefix`를 우회하는 읽기·쓰기 거부도 확인한다.
`run.ps1`은 이 테스트를 WebView2 통합 검증 전에 실행한다. 이미 시작한 파일
작업은 세션 폐기로 롤백하지 않으며, 폐기 이후 그 결과는 전달하지 않는다.

[실행 결과](../../../docs/architecture/windows-host-results.md)를 참고한다.

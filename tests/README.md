# Tests

`cli/app-manifest.test.ts`는 Windows 실행 manifest의 형식과 계약 검증, 플러그인 제거 후
재생성, 생성 import와 metadata 불일치를 검사한다.
manifest 생성과 카탈로그 로딩에서 native 계약의 크기 상한을 그대로 허용하고 초과는 거부하는지도 검사한다.
정책의 기존 크기와 깊이 상한도 manifest 생성과 읽기에서 유지하며, 상한 초과 입력은 거부하는지 검사한다.
`cli/windows-assets.test.ts`는
원본 소스와 임시 자산을 삭제한 뒤에도 compiled EXE가 manifest와 플러그인 구현을
읽고 지연 로딩을 유지하는지 검사한다.
메인과 두 Worker에서 플러그인의 `BunawayError` 코드가 그대로 전달되는지도 확인한다.
중간 생성 소스 없이 가상 모듈이 EXE에 포함되는지 검사한다.
`packaging/contract.test.ts`는 `.bunaway/work/`와 `.bunaway/locks/`의 성공 및 실패 후 정리,
작업 디렉터리 링크 거부와 외부 파일 보존을 검사한다.
작업 중과 게시 직전에 작업 경로가 링크로 바뀌어도 외부 파일을 게시하지 않고 이전 출력을 보존하는지 검사한다.

`cli/restart-controller.test.ts`는 코드 교체 응답을 기다리는 중 받은 UI 변경의 즉시 무효화,
연속 저장 대기와 종료 시 대기 취소를 검사한다. `cli/distribution.test.ts`는 설치한 CommonJS
플러그인의 `.cjs`, `.js` 진입점을 실제로 번들하고 로드해 export와 교체 전후 객체 동일성을 검사한다.
조건별 import/require 결과와 require 전용 진입점, 차단된 import 거부 및 setup 플러그인의
바인딩 객체 재사용도 확인한다. Host API 테스트는 같은 플러그인을 재사용한 앱의 실행 컨텍스트가 독립적인지 검사한다.

- `protocol/`: 직렬화, 버전 협상, 오류 계약.
- `api/`: 모듈 공통 타입, 명령 input/output, Host API 컨텍스트, 취소, 오류 계약,
  클라이언트 기본 연결의 지연 초기화, 문서/HMR 공유, 구독 해제, 실패, 취소, 문서 종료 정리.
- `core/`: 명령, 상태, 이벤트, 플러그인.
- `conformance/`: 네이티브 호스트 간 공통 계약.
- `security/`: 권한, origin, 세션, 파일 범위.
- `lifecycle/`: 종료, 재연결, 모바일 수명주기.
  `webview-session.test.ts`는 WebView 전송, Windows 메시지 경계와 실제 Core를 연결해
  잘못된 구독 응답과 클라이언트 종료 시 세션 철회, 원격 구독 제거와 명령 취소를 확인한다.
- `docs/`: 문서 링크 검사기의 정상 입력, 잘못된 링크와 출력 경로 경계.

Windows 이벤트 전송 회귀는 실제 `MessageChannel`과 Core를 연결한다. 두 뷰의
총 130개 구독에 대한 방송과 구독별 순서, 수신 확인 지연, BUSY 구독 종료,
서버 대기열 포화와 세션 정리, 취소 및 종료 용량을 확인한다.
이 검사는 WebView2 GUI 실행을 포함하지 않는다.

Windows 호스트 시나리오는 `lifecycle/windows-host.ts`에 두고 PID 조회, 창 닫기와
프로세스 종료 감시는 `lifecycle/windows-host-processes.ts`에서 실행한다.
`app-reload.test.ts`는 명령 교체 후 상태, 세션, 구독, 진행 중인 명령의 기존 구현과
비공개 개발 IPC 입력 검증을 확인한다. 일반 경로와 별칭 경로에서 정상 번들을 교체하고,
해시가 다르거나 세대 디렉터리 밖을 가리키는 번들은 거부하는지도 검사한다.
`windows-app-reload.ts`는 생성하고 설치한 앱의
실제 CLI 파일 감시와 WebView2를 사용해 소스 오류 중 기존 앱 유지, 수정 후 상태와
화면 입력, 이벤트 순서, Host API, 오류 코드 보존, 계약 변경 시 전체 재시작을 검증한다.
CLI 계약 테스트는 로컬 UI와 백엔드의 공유 파일 변경을 전체 재시작 대상으로 분류하고
두 번들을 갱신하는지, JSON을 export하는 플러그인도 개발 번들에 포함할 수 있는지 확인한다.
뷰 프로필 이름은 호스트의 순수 `view-profile.ts` 함수를 공유한다.
macOS WebContent PID 조회와 종료는 `lifecycle/macos-renderer.ts`가 맡으며,
`macos-host.ts`는 시나리오별 기준 PID와 테스트 순서를 유지한다.

`mise run test`는 프로토콜, 정책, SDK, 코어, Host API의 계약 테스트와 네이티브용 생성
스키마 일치 검사를 실행한다. `mise run check`에는 테스트와 테스트 코드의 타입 검사도 포함한다.
코어, SDK 테스트와 `runtime-bun.test.ts`의 실제 Bun 프로세스 IPC 테스트를 포함한다.
런타임 테스트는 플러그인 초기화 중 Host API, 응답 컨텍스트, 취소, 폐기, 늦은 응답,
새 세션, 종료 훅, EOF와 부팅 전/초기화 중 종료를 확인한다.
`mise run host:windows`는 C++ 컴파일 없이 Bun UI Worker의 실제 WebView2, SDK, 권한,
다중 창, 저장, 메모 복원, 렌더러 복구, 정상/비정상 종료를 검증한다.
모달 중 메인의 타이머, Promise, 네트워크와 초기화 중 닫기, 생성 실패, 파일 핸들 경계,
이동한 독립 CLI 프로젝트도 포함한다. [실행 결과](../docs/architecture/windows-bun-results.md).
모달 테스트는 진행 중인 HTTP 요청을 완료한 뒤 테스트 서버를 닫는다.
독립 CLI 프로젝트는 테스트용 UI 명령 호출을 추가한 뒤 생성 앱의 타입 검사를 통과해야 빌드와 창 실행을 진행한다.
공통 앱, 화면 데이터는 `tests/fixtures/desktop/host/`에서 Windows/macOS가 공유한다.
예전 Windows C++ 호스트/probe와 전용 실행기, 테스트는 삭제했다.
`backend-startup.test.ts`는 macOS 프로세스 probe 백엔드로 boot 전후 종료와 버전, 세대 검증을 확인한다.
다른 플랫폼, 모바일 수명주기의 검증 완료를 뜻하지 않는다.

공개 창 API의 계약, 대상 창 권한, 카탈로그와 개발 URL은 SDK, CLI 테스트에서 확인한다.
`api/window-geometry.test.ts`는 content, outer와 normal 조회 schema, 공개 SDK 호출 컨텍스트,
반올림과 정수 범위, 창별 권한 거부 및 닫힌 창을 검사한다.
`lifecycle/windows-geometry.test.ts`는 실제 Win32 창에서 setter 직후 조회, 일반, 숨김,
최소화, 최대화와 전체화면 bounds, normal 복원과 음수 좌표를 검사한다. DPI 메시지는
합성 메시지이며 실제 배율이 다른 물리 모니터 사이의 이동 검증과 구분한다.
`windows-fullscreen-dpi.fixture.ts`는 DLL 대체로 음수 좌표의 모니터 이동, 작업 영역의
좌표 보정과 전체화면 중 현재 DPI에 따른 normal bounds 계산을 검사한다.
작업 영역 오프셋이 다른 모니터로 최대화 창을 옮기거나 전체화면에 진입해도 원래 일반
복원 rectangle의 모니터로 좌표를 보정하는지, 조회가 숨김 상태를 유지하는지도 검사한다.
`lifecycle/windows-window-size.test.ts`는 서로 다른 작업 영역과 DPI에서 최대화 크기 보정과
제약이 없는 축의 보존을 확인한다. `windows-size-constraints.test.ts`는 실제 Win32에서
최대화 중 제약 축소, 확대와 해제, 숨긴 최대화 창과 최소화 창의 표시 상태 및 복원 크기를 검사한다.
두 창을 사용해 최대화된 보조 창의 제약, 복원 크기와 DPI를 바꿀 때 활성화 메시지가 발생하지 않고 입력 창의 활성 상태와 키보드 포커스가 유지되는지도 검사한다. 다른 프로세스가 전경 창을 바꿀 수 있으므로 입력 창이 계속 전경인지는 비교하지 않는다. 보조 창이 전경을 가져오는 것은 항상 거부한다.
일반, 최소화와 최대화 상태에서 숨긴 보조 창의 제약, DPI와 전체화면을 바꿀 때 표시나 활성화 메시지가 발생하지 않고 숨김 상태, 복원 크기와 입력 창의 포커스를 유지하는지도 검사한다.
합성 DPI 메시지 이후 최대화 크기를 다시 계산하고 표시 상태와 논리 복원 크기를 유지하는지도 확인한다.
합성 DPI 메시지로 표시하거나 숨긴 전체화면 창이 실제 모니터 영역을 유지하고, 해제 시 크기 제약을 적용하는지도 검사한다.
`windows-window-size.test.ts`의 별도 프로세스는 Win32 DLL을 대체하고 실제 FFI 창 콜백을 호출한다.
서로 다른 DPI와 해상도의 모니터로 이동하기 전에 전달된 제안 위치로 전체화면 대상을 선택하고,
화면 영역, 숨김 상태, 활성화 방지와 저장된 크기 제약을 유지하는지 검사한다. 실제 물리 모니터 이동 검증과는 구분한다.
`lifecycle/window-operations.test.ts`는 정리 대기 중 중복 생성, 마지막 창 재생성 예약,
기존 문서 취소, 닫기 거절과 종료 경쟁을 검증한다. Windows 네이티브 실행기는
`windows-bun-window-api.ts`로 크기와 위치, 전체화면 복원, 확인 대화상자 거절과 승인,
보조 창의 반복 생성과 새로운 세션, 자기 창 재생성을 추가 검증한다.
닫기 확인을 설정한 창의 브라우저 프로세스를 종료해 확인 없이 닫히는지도 검증한다.
호출한 뷰의 세션이 종료되면 정리 대기 중인 생성 요청이 새 창을 열지 않는지도 확인한다.
공용 기능 목록 검사는 Windows 창 API의 `supported`와 macOS의 `unsupported`를 요구한다.

`desktop.test.ts`는 앱 열기 입력, 단일 인스턴스 전달과 시작 큐, 종료 취소,
실패 복구, 제어 패킷 경계를 확인한다. Windows 실행기의 `windows-desktop.ts`는
실제 창을 숨긴 뒤 백엔드 타이머가 계속 동작하는지, 두 번째 실행으로 복원되는지,
종료 취소 뒤 같은 창과 세션을 유지하고 다시 종료할 수 있는지 확인한다.
`windows-desktop-web.ts`는 복원 뒤에도 원래 구독으로 이벤트를 받고 같은 세션에서
명령을 호출하는지 확인한다. IPC의 5초 기한은 요청이나 응답 조각을 계속 보내도 연장되지 않는다.
기한 검사에서는 큰 인자의 전달과 연결 종료에 따른 pipe 오류도 처리하며 요청과 응답이 각각 기한을 채웠는지 확인한다.
Windows PowerShell 실행기 테스트는 한글 파일과 URL 인자 및 호출자의 cwd 보존을 확인한다.
`--`, PowerShell 공통 매개변수 이름, 따옴표, 끝의 역슬래시와 빈 인자도 확인한다.
한글 파일명 128개와 256개도 실제 실행기로 전달해 JSON 인코딩 뒤 명령줄 길이 초과가
발생하지 않는지 확인한다. 표준 입력의 크기 제한, 잘못된 JSON과 5초 기한도 검사한다.
Windows 데스크톱의 dev-veto, dev-hide, dev-pending 시나리오는 CLI 중단이 종료 취소,
트레이 숨김과 대기 중인 종료 훅을 우회하며 플러그인 정리를 실행하는지 확인한다.

공개 창 API와 데스크톱 종료 설정을 함께 쓰는 회귀도 확인한다. `windows.close`의
마지막 창 종료 취소는 기존 세션을 유지하고, 자기 창 재생성은 `beforeQuit`를 호출하지 않는다.
트레이 숨김 설정에서는 API로 닫은 뒤에도 같은 요청 컨텍스트로 창을 다시 표시할 수 있어야 한다.

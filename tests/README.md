# Tests

- `protocol/`: 직렬화, 버전 협상, 오류 계약.
- `api/`: 모듈 공통 타입, 명령 input/output, Host API 컨텍스트, 취소, 오류 계약,
  클라이언트 기본 연결의 지연 초기화, 문서/HMR 공유, 구독 해제, 실패, 취소, 문서 종료 정리.
- `core/`: 명령, 상태, 이벤트, 플러그인.
- `conformance/`: 네이티브 호스트 간 공통 계약.
- `security/`: 권한, origin, 세션, 파일 범위.
- `lifecycle/`: 종료, 재연결, 모바일 수명주기.

`mise run test`는 프로토콜, 정책, SDK, 코어, Host API의 계약 테스트와 네이티브용 생성
스키마 일치 검사를 실행한다. `mise run check`에는 테스트와 테스트 코드의 타입 검사도 포함한다.
코어, SDK 테스트와 `runtime-bun.test.ts`의 실제 Bun 프로세스 IPC 테스트를 포함한다.
런타임 테스트는 플러그인 초기화 중 Host API, 응답 컨텍스트, 취소, 폐기, 늦은 응답,
새 세션, 종료 훅, EOF와 부팅 전/초기화 중 종료를 확인한다.
`mise run host:windows`는 C++ 컴파일 없이 Bun UI Worker의 실제 WebView2, SDK, 권한,
다중 창, 저장, 메모 복원, 렌더러 복구, 정상/비정상 종료를 검증한다.
모달 중 메인의 타이머, Promise, 네트워크와 초기화 중 닫기, 생성 실패, 파일 핸들 경계,
이동한 독립 CLI 프로젝트도 포함한다. [실행 결과](../docs/architecture/windows-bun-results.md).
독립 CLI 프로젝트는 테스트용 UI 명령 호출을 추가한 뒤 생성 앱의 타입 검사를 통과해야 빌드와 창 실행을 진행한다.
공통 앱, 화면 데이터는 `tests/fixtures/desktop/host/`에서 Windows/macOS가 공유한다.
예전 Windows C++ 호스트/probe와 전용 실행기, 테스트는 삭제했다.
`backend-startup.test.ts`는 macOS 프로세스 probe 백엔드로 boot 전후 종료와 버전, 세대 검증을 확인한다.
다른 플랫폼, 모바일 수명주기의 검증 완료를 뜻하지 않는다.

`desktop.test.ts`는 앱 열기 입력, 단일 인스턴스 전달과 시작 큐, 종료 취소,
실패 복구, 제어 패킷 경계를 확인한다. Windows 실행기의 `windows-desktop.ts`는
실제 창을 숨긴 뒤 백엔드 타이머가 계속 동작하는지, 두 번째 실행으로 복원되는지,
종료 취소 뒤 같은 창과 세션을 유지하고 다시 종료할 수 있는지 확인한다.
`windows-desktop-web.ts`는 복원 뒤에도 원래 구독으로 이벤트를 받고 같은 세션에서
명령을 호출하는지 확인한다. IPC의 5초 기한은 요청이나 응답 조각을 계속 보내도 연장되지 않는다.
Windows PowerShell 실행기 테스트는 한글 파일과 URL 인자 및 호출자의 cwd 보존을 확인한다.
`--`, PowerShell 공통 매개변수 이름, 따옴표, 끝의 역슬래시와 빈 인자도 확인한다.
한글 파일명 128개와 256개도 실제 실행기로 전달해 JSON 인코딩 뒤 명령줄 길이 초과가
발생하지 않는지 확인한다. 표준 입력의 크기 제한, 잘못된 JSON과 5초 기한도 검사한다.
Windows 데스크톱의 dev-veto, dev-hide, dev-pending 시나리오는 CLI 중단이 종료 취소,
트레이 숨김과 대기 중인 종료 훅을 우회하며 플러그인 정리를 실행하는지 확인한다.

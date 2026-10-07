# Windows Bun FFI 실행 기록

2026-10-06 로컬 Windows x64, 저장소가 고정한 Bun 1.4.2
`744846f844374847c902b5e7fd59b4342a51ef99`, WebView2 SDK 1.0.4129.50과
설치된 Evergreen을 사용했다. 다른 OS/CPU 및 새 CI 실행 성공을 주장하지 않는다.

| 실제 실행 | 결과 |
| --- | --- |
| 직접 Win32/WebView2, 로컬 문서, 실제 SDK invoke/listen/unlisten/cancel, 화면 반환 | 통과 |
| 실제 창 이동 모달 중 메인 타이머, Promise, 로컬 HTTP 요청 | 통과 |
| 부팅 중 닫기, Loader 생성 실패, 부분 초기화 정리 | 통과 |
| 기존 세 창, 출처/iframe, 뷰별 권한/프로필, 탐색/외부 자원, 취소/늦은 응답, 개별 종료, 렌더러 복구, 메모 재실행 | 통과 |
| 범위 제한 파일 핸들, 부모 고정, junction/hardlink/path 거부, UTF-8, 조기 EOF | 통과 |
| 독립 생성 프로젝트 이동, 자체 vendor 빌드, 실제 SDK 저장/읽기, 환경 정리, 실행 전 변조 거부 | 통과 |
| 앱 import 중 생성한 자식 포함, 앱 종료 시 kill-on-close Job 회수 | 통과 |

재현 명령은 `pwsh -NoProfile -File native/windows/bun/run.ps1`이다.
공통 계약과 Worker 경계 테스트는 `bun test ./tests/core ./tests/api ./tests/protocol
./tests/lifecycle/windows-bun-boundary.test.ts ./tests/lifecycle/windows-bun-io.test.ts`,
타입 검사는 `mise run typecheck`다. 실제 GUI 보고서는
`build/windows-host-results.json`, 창별 정책과 정리 로그는 앱 데이터의 `logs/host.log`다.
전체 `bun test ./tests --timeout 90000`은 156 통과, 1 기존 skip, 7 실패였다.
실패는 Windows 링크 권한 EPERM(CLI 3건, 기존 macOS 파일 테스트 4건)이다.
기존 C++ 경로 삭제, 공용 fixture 이동 후 공통, Worker, backend startup/runtime 계약은
113 통과, 0 실패였다. tarball/snapshot 경계 3건, 실제 Windows GUI 전체와 이동한 독립 CLI
프로젝트, launcher도 재실행해 통과했다. workspace/테스트 TypeScript, 린트, 포맷 검사는 통과했다.
예전 C++ 프로세스 테스트 결과는 [별도 기록](./windows-host-results.md)으로 유지한다.

2026-10-06 리뷰 후 회귀: 진단 로그 포화 시 요청, 제어 슬롯 유지, 과대한 COM 문자열
거부 후 세션 유지, 앱 진입점 이름 `boot.ts`, `app.ts`, `ui.ts`의 번들 충돌을 검사했다.
공통 계약, Windows 경계, I/O, 새 번들 테스트는 116 통과, 0 실패였다. 실제 WebView에서
1 MiB 초과 메시지와 연속 권한 거부 요청 256개 이후 SDK 명령, 이벤트, 취소, 정상 종료를
검증했고, 이동한 독립 CLI 프로젝트의 `boot.ts` 진입점 빌드, 저장, launcher, Job 정리도
통과했다. 실행 명령은 `bun tests/lifecycle/windows-bun.ts`와
`bun tests/lifecycle/windows-bun-cli.ts`다. 실제 GUI 검증은 샌드박스 밖에서 실행했다.

기본 Windows CLI, 템플릿, mise, CI는 C++ 컴파일을 호출하지 않는다. 기존 C++ 소스, probe,
CMake, 전용 실행기와 테스트는 삭제했다. 회귀 데이터는 공용 `tests/fixtures/desktop/host/`로 옮겼다.
공식 WebView2Loader와 Windows DLL은 계속 필요하다. 자체 네이티브 shim은 없다.
기존 SDK, 코어, 프로토콜을 재사용하며 macOS의 별도 백엔드 경로는 유지한다.

검증 한계:

- COM Environment8와 Settings4 등 사용 인터페이스를 지원하는 Evergreen이 필요하다.
  최소 Windows/CPU, 구버전 Evergreen, 다른 Job 정책의 환경은 별도 검증이다.
- UI 모달 중 UI 전달/새 파일 작업 승인은 지연된다. 다른 스레드의 동기 COM 콜백을
  지원한다고 가정하지 않으며 콜백에서 소유 OS 스레드를 검사한다.
- WebView 자식 종료는 5초를 초과할 수 있다. 초기 강화 실행에서 30초 초과가 한 번
  발생했고 환경 해제 순서를 보강했다. 초과를 성공 처리하지 않는다.
- 고정 Bun이 간헐적으로 `Internal error: directory mismatch`를 출력하고 WebView가
  `Chrome_WidgetWin_0` unregister 진단을 출력했다. 원인은 확정하지 않았고 stderr를 남긴다.
- Windows CLI 계약 중 파일 링크 복사 3건은 현 환경의 `cp ... EPERM`으로 검증이
  막혔다. 건너뛰기를 통과로 바꾸지 않는다. 자체 파일 핸들 경계 검사는 실제 실행했다.
- 서명, 설치, 단일 exe, 완전 무콘솔 시작, 네이티브 호출 영구 정지의 정상 정리는 미검증이다.
  프로세스 강제 종료 시 자손 회수는 Job으로 검증했다. 앱 백엔드는 신뢰 코드이며
  직접 Bun API를 제한하는 샌드박스가 아니다.

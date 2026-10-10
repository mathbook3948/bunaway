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

재현 명령은 `mise run host:windows`이다.
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

2026-10-07 `main` CI 실행 [37555338557](https://github.com/mathbook3948/bunaway/actions/runs/37555338557)의
Windows 다중 창 검사는 권한 거부 로그 누락으로 실패했다. 진단 artifact의 `host.log`에는
`droppedDiagnostics: 6`이 기록돼 있었다. 진단 슬롯 포화 시 로그를 생략하는 동작은
[ADR 0006](../decisions/0006-windows-bun-ui-worker.md)의 계약이다.
권한과 잘못된 메시지 검사는 페이지가 받은 오류 코드와 금지된 명령의 미실행을
`report.json`, `reader.json`으로 확인한다. 드라이버는 해당 검사 이름의 존재와 성공을
요구하며, 생략될 수 있는 거부 로그의 개수로 성공 여부를 판단하지 않는다.
진단 슬롯을 채워 권한 거부와 입력 오류 로그가 생략되는 상황에서도 오류 응답은
전달되고 금지된 요청은 코어로 전달되지 않는지 별도 Worker 경계 회귀로 검사한다.

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

## 2026-10-07 공개 창 API 변경

CLI의 `app.windows`를 런타임 창 설정에 연결했다. 창 카탈로그는 최대 128개이며
뷰별로 하나의 창만 생성한다. `startup: false`는 동적 생성 대상이다. 창 제어는
뷰 또는 backend의 대상 뷰 ID 권한을 확인한 뒤 UI STA에서 실행한다. 재생성은
기존 세션을 폐기하고 WebView 프로세스와 COM 참조를 정리한 뒤 같은 프로필로
새 창과 뷰 세션을 만든다. 재생성 예약이 있는 동안 마지막 창 종료 통지를 보류한다.

Linux에서 계약, 권한 분리, 중복 생성, 닫기 거절, 취소, 종료와 재생성의 경쟁 조건을
검증하는 테스트를 추가했다. Windows의 실제 크기와 위치, 전체화면 복원, 닫기
대화상자 거절과 승인, 보조 창 반복 생성과 자기 창 재생성 회귀를
`tests/lifecycle/windows-bun-window-api.ts`에 추가하고 네이티브 실행기에 연결했다.
새 Windows 시나리오는 이 Linux 작업 환경에서 실행하지 않았으며 기존 GUI 검증 기록과 구분한다.

2026-10-07 PR #40 CI 실행 [37574470840](https://github.com/mathbook3948/bunaway/actions/runs/37574470840)에서
공개 창 API의 크기와 위치, 전체화면 복원, 닫기 확인 거절과 승인, 반복 생성과 자기 창 재생성은 통과했다.
독립 CLI의 설치, launcher와 loopback 개발 서버 검사도 통과했다. 전체 Windows 네이티브 작업은
공용 웹 fixture가 기능 목록을 기존 4개로 고정해 검사한 탓에 실패했다. macOS도 같은 검사에서 실패했다.
fixture는 프로토콜의 전체 operation 이름과 중복 여부, 플랫폼별 지원 상태를 검사하도록 갱신했다.
당시 Windows 창 API는 `experimental`, macOS 창 API는 `unsupported`를 요구했으며 기존 4개 API는 `supported`여야 했다.

## 2026-10-07 로컬 브라우저 장애 회귀

닫기 확인을 설정한 editor 창의 브라우저 프로세스를 강제 종료해 확인 없이 해당 창이 닫히는 것을 검증했다.
주 창에서 닫힌 상태를 조회하고 editor를 다시 생성했다. 기존 닫기 거절과 승인, 재생성 후 확인 메시지 초기화,
자기 창 재생성, 호출 세션 종료에 따른 생성 취소와 정상 종료도 실제 Windows WebView2 회귀를 통과했다.

## 데스크톱 앱 열기와 종료 확장, 2026-10-07

앱 정의의 `desktop`으로 두 번째 실행의 인자 전달, 파일과 URL 열기, 종료 취소,
트레이 숨김과 복원을 구현했다. 동작과 제한은 [ADR 0013](../decisions/0013-desktop-lifecycle.md)를 따른다.
`tests/lifecycle/desktop.test.ts`는 플랫폼 독립 계약을 확인하고 Windows 실행기에
`tests/lifecycle/windows-desktop.ts`의 hide, veto 시나리오를 추가했다.
초기 Linux 작업에서는 실제 Windows GUI 회귀를 실행하지 않았다. 후속 Windows x64,
Bun 1.4.2 검증에서 실제 WebView2의 hide, veto와 dev-veto, dev-hide, dev-pending을 통과했다.
숨김과 최대화 복원, 종료 취소 뒤 세션 유지, CLI 중단 시 종료 검사 우회와 플러그인 정리를 확인했다.
PowerShell 5.1 실행기에서 `--`, 공통 매개변수 이름, 따옴표, 끝의 역슬래시와 빈 인자 보존도 통과했다.
OS의 URL scheme과 파일 연결 등록은 제공하지 않는다.

## 2026-10-07 창 API와 데스크톱 수명주기 통합

PR #39 병합 후 공개 창 API와 디버깅 설정을 함께 유지하도록 충돌을 해결했다.
마지막 창의 `windows.close`는 앱의 종료 승인도 기다리고, 트레이 숨김은 세션을 유지한다.
`windows.recreate`는 앱 종료 검사를 우회하며 기존 창의 닫기 확인은 적용한다.
동적으로 만들거나 재생성하는 창도 검증된 DevTools 설정을 사용한다.

Windows x64, Bun 1.4.2에서 hide, veto, dev-veto, dev-hide, dev-pending 회귀를 통과했다.
창 API의 종료 취소, 자기 창 재생성, 브라우저 장애와 호출 세션 종료에 따른 생성 취소도 통과했다.
공개 창 API 실행기의 전체화면 사전 검사는 현재 환경에서 최대화 창의 복원 좌표가 달라 실패했다.
수정 전 PR 커밋 `53a79233`에서도 같은 실패를 재현했다. 해당 사전 검사만 제외한 임시 사본으로
창 수명주기 회귀를 실행했으며 원래 전체화면 검사는 유지했다. 전체 네이티브 회귀 통과를 뜻하지 않는다.

## 2026-10-07 공개 창 API 정식 지원 검증

PR #40 병합 커밋 `8eec961`을 기준으로 Windows 창 API 11개의 기능 조회 결과를
`experimental`에서 `supported`로 변경했다. macOS의 `unsupported`는 유지한다.
로컬 Windows x64, OS 빌드 26200, Bun 1.4.2, WebView2 SDK 1.0.4129.50과
Evergreen 154.0.4258.62에서 실제 GUI 회귀를 실행했다.

`tests/lifecycle/windows-bun-window-api.ts`는 사전 검사를 포함한 원본 전체를 통과했다.
표시, 숨김, 최소화와 최대화 창의 전체화면 해제 후 표시 상태와 좌표 복원,
크기와 위치, 닫기 거절과 승인, 브라우저 장애 후 닫기, 네 번의 보조 창 생성과
새 세션, 자기 창 재생성과 이전 세션 종료에 따른 생성 취소를 확인했다.

당시 Windows 실행기를 고정 Bun 1.4.2로 실행한 검사도 통과했다.
SDK와 코어, 모달 중 백엔드 진행, 초기화 중 닫기와 생성 실패 정리, 단일 인스턴스와
launcher, hide, veto와 세 개발 중단 시나리오, 파일 핸들 경계, 이동한 독립 CLI,
개발 서버와 실제 SDK 저장 왕복, 기존 다중 창의 정책과 `supported` 기능 목록,
메모 복원과 강제 종료 시 WebView 자손 정리를 확인했다.
Inno Setup이 없어 설치 파일 생성과 설치 검사는 건너뛰었으며 설치 검증 통과를 뜻하지 않는다.

전체 네이티브 실행의 모달 테스트에서 종료 중 HTTP 요청이 한 번 `ConnectionRefused`로
실패했다. 테스트가 시작한 요청을 모두 완료한 뒤 서버를 닫도록 정리하고 전체 실행을 다시 통과했다.
공용 기능 목록 회귀는 Windows 창 API가 `experimental`이나 `unsupported`를 보고하면 실패하며,
macOS가 `supported`를 보고하는 경우도 거부한다.

창 API 관련 SDK, 코어, 프로토콜, 창 설정과 수명주기 계약 테스트는 79 통과, 0 실패였다.
전체 `bun test ./tests --timeout 90000`은 582 통과, 33 skip, 5 실패였다.
실패 5건은 Windows의 파일 symlink 생성 권한 `EPERM`으로 막힌 macOS 파일 fixture 검사이며,
정식화 전 병합 커밋에서도 같은 결과를 확인했다.
전체 워크스페이스와 테스트 타입 검사, 린트와 포맷 검사는 통과했다.
`bun run docs:check`, `bun run docs:build`도 통과했으며 공개 항목 276개와
62페이지의 내부 링크와 앵커 4,908개를 검사했다.

## 2026-10-08 Bun compile 배포 검증

Windows 배포 빌드를 Bun 1.4.2 compile으로 변경했다. 앱 호스트와 앱 정의, 코어,
UI와 I/O Worker, 웹 자산, 설정과 정책은 GUI EXE에 들어간다. 외부에는 Microsoft
WebView2Loader.dll, 라이선스와 manifest만 둔다. 시작 시 전체 파일 해시 검사는 제거하고
의존성 핀과 빌드 및 패키징 사이의 해시 검증은 유지했다. 이전 배포 형식의 마이그레이션은 제공하지 않는다.

실제 compiled EXE에서 콘솔 창 미생성, EXE 아이콘, 한글과 빈 문자열 및 따옴표 인자,
작업 폴더의 .env와 bunfig 자동 로드 차단, 시작 오류 대화상자와 로그를 확인했다.
중복 실행은 인자를 전달하고 종료하며 앱 모듈을 다시 실행하지 않았다.
WebView는 임시 폴더에 웹 자산을 풀지 않고 내장 파일을 읽는다. 실제 다중 창 회귀에서
Range 응답, 누락 파일과 웹 경계 밖 요청의 404, 웹 Worker 스크립트 로딩을 검증했다.
기존 정책 분리, 저장, 렌더러 복구, 메모 재실행 복원과 강제 종료 후 WebView 자손 정리도 통과했다.

이동한 한글 경로의 독립 CLI에서 생성, compile, 실행, SDK와 저장 왕복, Job 정리,
패키징 해시와 파일 변조 거부, 개발 서버 실행과 종료를 통과했다.
Bun 1.4.2의 compile-executable-path 옵션에 한글 절대 경로를 넘기면 ENOENT가 발생해,
검증한 Bun을 빌드 임시 폴더로 복사하고 상대 경로를 넘긴다.
hide, veto, dev-veto, dev-hide와 dev-pending의 실제 데스크톱 회귀도 통과했다.

Inno Setup이 없어 설치 프로그램 생성과 설치, 제거는 실행하지 않았다.
인증서를 사용한 실제 Authenticode 서명과 스토어 제출, macOS compile은 이번 검증 범위가 아니다.
MSIX는 패키지 활성화와 데이터 경로 검증 전까지 비활성 상태를 유지한다.

## 2026-10-09 앱 코드 교체

Bun 1.4.2에서 생성하고 설치한 vanilla 앱을 실제 `bunaway dev`로 실행했다.
`tests/lifecycle/windows-app-reload.ts`는 프로젝트 내부 전이 의존성의 소스 오류 중
기존 앱이 계속 명령과 저장 작업을 처리하는지, 수정 후 같은 프로세스와 문서에서
StateStore 카운터가 1에서 11로 이어지는지 확인했다. 입력 중인 내용, 기존 이벤트
구독과 순서 1, 2, INVALID_ARGUMENT 오류 코드와 저장 Host API도 유지됐다.
이벤트 계약 변경은 다른 프로세스와 문서를 시작하며 상태를 초기화했다.

이 검증은 Windows 개발 실행의 명령 교체다. 모듈 변수는 새로 초기화되며
임의의 모듈 자원을 이전하는 기능, 플러그인 setup 교체와 상태 마이그레이션은 제공하지 않는다.

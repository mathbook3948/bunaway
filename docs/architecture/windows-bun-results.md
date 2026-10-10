# Windows Bun FFI 실행 기록

## 2026-10-10 opener 파일 작업

초기 UI Worker 구현의 Windows 실행 근거다. 후속 수정은 파일 검사와 셸 요청을
기존 I/O Worker로 옮기고 어댑터가 자체 STA 초기화와 정리를 소유하도록 변경했다.
아래 Windows 실행 결과는 후속 수정의 실행 근거로 사용하지 않는다. 후속 검증은
`windows-opener.test.ts`의 실제 I/O Worker, 권한 승인 거부와 대기 작업 취소, COM 정리와
`cli/opener.test.ts`의 UI 어댑터 미초기화 검사로 구분한다.

`6f2363c`의 opener를 확장하고 최신 main `87cbba6`에 rebase했다.
Windows 11 Pro x64 `10.0.26200`, Bun 1.4.2에서 확인했다.
`openFile`과 `revealFile`은 작업별 권한과 정확한 절대 파일 경로 scope를 사용한다.
성공한 `null`은 OS 요청 접수이며 실제 앱 실행이나 Explorer 선택 완료를 기다리는 계약이 아니다.

- 계약: `tests/api/opener.test.ts`에서 URL 계약 보존, 파일 API의 호출 컨텍스트와 오류 전달,
  Unicode와 공백, 경로 형식과 길이, 정확한 경로 일치와 작업별 권한, deny 우선을 확인했다.
- 실제 Windows: `tests/lifecycle/windows-opener.test.ts`에서 UI STA와 반복 정리, 없는 파일,
  디렉터리, 공유 잠금, junction과 하드 링크, 대소문자 별칭 거부를 확인했다.
  파일 핸들을 유지하는 동안 삭제가 거부되고 실패 후 핸들이 정리되는 것도 확인했다.
  `windows-opener-job.test.ts`는 Explorer가 실행한 프로세스가 앱 Job 밖에 있고 앱 종료 후에도 살아 있음을 확인했다.
  두 파일과 계약 파일을 함께 실행해 13개 검사가 통과했다.
- 패키지 실행: `BUNAWAY_OPENER_FILES_TEST=1 bun test tests/cli/opener.test.ts`가 통과했다.
  로컬 `.tgz`를 독립 프로젝트에 설치하고 생성 카탈로그와 scope evaluator, 브라우저 번들을 검사했다.
  설치한 어댑터를 고정 Bun으로 compiled STA EXE에 포함하고 프로브와 helper 소스를 삭제한 뒤 실행했다.
  `openFile`로 한글, 공백, 쉼표와 emoji가 있는 실행 파일의 기본 동작을 시작해 marker를 확인했다.
  `revealFile`은 같은 문자가 있는 텍스트 파일을 Explorer에서 실제 선택하는지 확인하고 테스트 창을 닫았다.
  이 프로브는 실제 WebView2 앱 전체, 서명된 앱, MSIX와 Inno 설치 프로그램을 검증한 결과가 아니다.

일반 문서의 연결 앱 실행 완료와 UNC 공유는 미검증이다. 임시 확장자를 등록한 추가 실험에서
로컬 Shell.Application은 파일 읽기를 완료했지만 Explorer 위임에서는 helper marker를 받지 못했다.
원인은 확정하지 못했으며 이 결과를 기본 문서 앱 실행 완료로 계산하지 않는다.
현재 자동 실행 검사는 사용자 파일 연결을 바꾸지 않는 실행 파일의 기본 동작을 사용한다.
URL 브라우저 로딩 완료 검사는 폐기 가능한 Windows Sandbox가 없어 재실행하지 않았다.

문서 coverage와 Astro 타입 검사, 69개 페이지 빌드와 내부 링크 5,913개 검사를 통과했다.
전체 `mise run check`의 첫 실행은 663 pass, 64 skip, 12 fail이었다.
일부 기존 CLI 검사에서 시간 제한이 발생했고 Windows의 파일 심볼릭 링크 생성은 `EPERM`이었다.
CommonJS 배포 검사는 단독 재실행에서 통과했다.
전체 재실행은 699 pass, 64 skip, 9 fail이었다. 형식, lint와 모든 패키지 및 테스트 타입 검사는 통과했다.
실패는 기존 CLI 설정 검사 하나의 5초 시간 초과와 그 뒤 공유 fixture 오류 세 개,
기존 macOS fixture 및 패키징 검사의 파일 심볼릭 링크 생성 `EPERM` 다섯 개였다.
CLI 설정 검사 네 개는 `--timeout 15000`을 지정한 단독 재실행에서 모두 통과했다.
첫 검사의 실행 시간은 약 8.1초였으며 저장소의 기본 5초 기한은 변경하지 않았다.
이 전체 검사 결과를 성공으로 기록하지 않는다.
## 2026-10-10 창 geometry 설정 API

main `6f2363c`를 기준으로 `setContentPosition`, `setOuterSize`, `setContentBounds`,
`setOuterBounds`를 추가했다. 로컬 Windows x64와 고정한 Bun 1.4.2로 검증했다.
기존 조회, DPI 변환과 content 기준 크기 제약을 사용한다. 새 API의 기본 단위는
물리 픽셀이며 논리 입력의 반올림, 변환 후 크기와 rectangle 경계 검사는
[창 API](../site/src/content/docs/reference/host/windows.mdx)에 정의했다.

- 계약 및 DLL 대체 검사: 영향받는 10개 파일의 29개 검사 중 24개는 GUI를 사용하지
  않는다. 새 setter의 schema, SDK 컨텍스트, 기본 단위, 144 DPI 반올림,
  deny 우선 대상 권한과 허용된 미선언 뷰, 닫힌 창, 시작 전 취소 및 종료를 확인했다.
  기존 크기 제약, 이벤트 비교와 모니터/DPI 대체 회귀도 통과했다.
- 실제 Win32: 같은 실행의 5개 검사는 실제 창과 네이티브 메시지를 사용한다.
  `windows-geometry.test.ts`에서 일반 및 숨김 상태의 적용, content 위치,
  outer 크기와 bounds, 제약 보정, 최소화 및 최대화 중 일반 복원 영역 변경과
  표시 상태 유지, 최소화 전 최대화 복원 이력, 전체화면 거부를 확인했다.
  잘못된 크기와 경계는 위치와 크기를 모두 유지한다. bounds 적용은 중간 관찰을
  보류하고 실제 조회와 같은 snapshot을 발행한다. 기존 상태, 제약과 이벤트 회귀도 통과했다.
- 실제 WebView2: `windows-window-events.ts`는 공개 SDK, Core와 UI Worker를
  연결해 네 setter를 호출했다. 세 문서에서 42개 이벤트를 수신했고 outer bounds
  적용 직후 조회와 같은 windowId 및 revision의 `windows.changed`가 일치했다.
  탐색은 같은 windowId를 유지하고 재생성은 새 windowId와 revision으로 시작했다.
  권한 거부, 구독 해제와 정상 종료도 통과했다. 보고서는
  `build/windows-window-events/report.json`에 남긴다.

120/144/192 DPI 검사는 실제 창에 합성 `WM_DPICHANGED`를 전달했다.
홀수 물리 outer 크기를 논리 왕복 변환 없이 유지하고 내용 위치를 현재 DPI로
반올림하는지 확인했다. 실제 배율이 다른 물리 모니터 간 이동이나 모니터 분리는
검증하지 않았다. 이 환경에서 OS가 전경 요청을 거부해 기존 focus/blur 전환 검사는
실제 활성화 성공으로 계산하지 않았다.

재현 명령은 `bun test tests/api/window-geometry.test.ts tests/lifecycle/windows-geometry.test.ts`와
`bun --no-env-file tests/lifecycle/windows-window-events.ts`다.
Win32와 WebView2 검증은 macOS나 다른 OS의 geometry 지원을 의미하지 않는다.

최종 포맷, lint, workspace 및 테스트 타입 검사는 통과했다. lint의 기존 경고 12개는
유지했다. `bun run docs:check`는 공개 계약 460개를 검사했고 `bun run docs:build`는
69개 페이지와 내부 링크 및 anchor 5913개를 검사했다.

전체 검사는 실패했다. `MISE_JOBS=1`로 작업을 순차 실행한 `mise run check`의
테스트 결과는 636 통과, 64 skip, 36 실패와 검사 사이 미처리 오류 1개다.
CLI fixture 패키징 준비의 30초 기한 초과와 exit 143을 재사용한 후속 검사 실패,
설치 패키지 및 artifact audit의 60초와 30초 기한 초과, Store EXE 두 검사의
기본 5초 기한 초과를 포함한다. macOS fixture 및 Info.plist의 파일 symlink 생성
다섯 건은 Windows `EPERM`이다. 미처리 오류는 distribution의 생성 앱 타입 검사
프로세스 실패이며 출력에 TypeScript 진단은 없었다. 새 geometry 검사는 같은
전체 실행에서도 통과했다. 실행 로그는 `build-check-complete.log`에 남겼다.

`mise run host:windows`는 SDK/Core 취소, 모달 중 백엔드 진행, 초기화 중 닫기와
부분 생성 실패 시나리오를 통과한 뒤 기존 `windows-bun-window-api.ts`의 150초
기한을 넘겼다. 그 창 API를 단독 재실행한 결과도 `WebView cleanup timed out`으로
실패했다. WebView2 브라우저 자식 프로세스가 정리 기한 뒤에도 남아 있었다.
따라서 전체 Windows 제품 호스트 회귀의 완료를 선언하지 않는다.
로그는 `build-host-windows.log`와 `build-window-api-retry.log`에 남겼다.

## 2026-10-10 창 이벤트와 구독 수명

최신 main `a74f7b3`의 창 상태와 geometry API 위에 이벤트 구현을 적용하고,
로컬 Windows x64와 고정한 Bun 1.4.2로 확인했다.
`windows.changed`는 호스트의 실제 관찰을 대상 창의 뷰 세션으로 전달한다.

- 계약 검사: `tests/lifecycle/window-events.test.ts`의 네 검사에서 전환 이름과 순서,
  중복 억제, 스키마 검증, typed SDK의 권한 거부와 해제, 재생성한 세션의 격리,
  종료 후 늦은 발행 차단을 확인했다. 실제 MessageChannel의 미확인 이벤트 상한
  128개와 독립된 종료 용량, Core 구독 큐 초과의 BUSY 종료도 확인했다.
  이 결과는 GUI 실행 결과가 아니다.
- 실제 Win32: `tests/lifecycle/windows-window-events.test.ts`에서 API와 네이티브
  시스템 메뉴 명령으로 표시, 숨김, 이동, 크기, 최소화, 최대화와 복원,
  전체화면 진입과 해제를 확인했다. query와 이벤트의 물리 outer bounds 일치,
  revision 증가, HWND 파괴 후 콜백 차단과 재생성 식별자 변경도 확인했다.
- 실제 WebView2: `tests/lifecycle/windows-window-events.ts`는 세 문서에서
  30개 이벤트를 받고 snapshot 복구, 권한 거부, 구독 해제, 문서 탐색과 창 재생성,
  정상 종료를 통과했다. 탐색한 두 문서는 같은 windowId이고 재생성한 문서는 새
  windowId였다. 보고서는 `build/windows-window-events/report.json`에 남긴다.
- `mise run host:windows`의 기존 Windows 호스트 회귀도 통과했다. 네이티브 창 API,
  저장과 앱 재시작, 다중 뷰 권한과 세션, 정상 및 비정상 종료를 포함한다.

이 실행 환경에서 Windows가 전경 전환을 거부해 실제 focus/blur 전환은 검증하지
못했다. focused 조회와 snapshot의 일치, focus/blur 변경 비교는 각각 네이티브와
계약 검사로 확인했다. 이를 실제 focus/blur 전환 성공으로 계산하지 않는다.
사용자의 물리 마우스 드래그와 다중 물리 모니터 이동은 이 시나리오에 포함하지 않았다.
현재 모니터에서 실행한 결과이며 다른 DPI나 다른 OS 지원을 주장하지 않는다.

재현은 네이티브 입력을 준비한 뒤
`bun test ./tests/lifecycle/window-events.test.ts ./tests/lifecycle/windows-window-events.test.ts`와
`bun --no-env-file tests/lifecycle/windows-window-events.ts`로 한다.
실제 WebView2 시나리오는 `mise run host:windows`에도 포함된다.

포맷, lint와 workspace 및 테스트 타입 검사는 통과했다. lint의 기존 경고는 유지했다.
`mise run check`는 기존 CLI 설정 검사가 기본 5초 기한을 넘겨 중단했다.
코드와 테스트 조건을 바꾸지 않고 `bun test ./tests --timeout 90000`으로 재실행한 결과는
678 통과, 64 skip, 5 실패였다. CLI 검사는 통과했고 실패 다섯 건은 macOS fixture 및
Info.plist 검사에서 파일 심볼릭 링크를 만들지 못한 Windows `EPERM`이다.
이번 변경에서 해당 macOS 검사나 OS 링크 생성 설정은 바꾸지 않았다.
`bun run docs:check`와 `bun run docs:build`도 통과했다.

## 이전 실행 기록

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

## 2026-10-10 창 상태 제어와 조회

Bun 1.4.2에서 `tests/lifecycle/windows-window-state.test.ts`로 실제 Win32 창을 만들고
최대화 후 최소화한 창의 `restore`가 최대화로 돌아가는지, `unmaximize`가 일반 크기를
적용하는지 확인했다. 숨긴 창에 상태 변경을 호출하면 표시되는 동작, 네이티브 API로
직접 바꾼 상태의 조회, 반복 호출, 현재 크기 제약과 전체화면 해제 후 표시 상태 복원도 통과했다.
포커스 조회는 실제 `GetForegroundWindow` 결과와 비교했다. OS의 포커스 획득 보장을 뜻하지 않는다.

`tests/lifecycle/windows-bun-window-api.ts`도 실제 WebView2와 UI Worker를 연결해 통과했다.
공개 다섯 제어와 다섯 조회, 권한 없는 뷰의 `PERMISSION_DENIED`, 전체화면 중 변경의
`INVALID_ARGUMENT`, 숨김 창 표시, 기존 닫기 확인과 창 생성, 재생성 및 세션 정리를 확인했다.
이 실행은 `build/windows-window-api/report.json`의 `pass: true`로 완료했다.

상태 API의 입력 및 출력 schema, 대상 권한과 미선언 뷰, 닫힌 창의 오류는 계약 테스트로
확인했다. 격리된 DLL 대체 실행에서는 최대화 요청을 OS가 적용하지 않은 상황을 만들고,
네이티브 상태 확인 후 내부 진단을 노출하지 않는 `INTERNAL` 결과를 확인했다.
실제 OS 작업 실패를 의도적으로 발생시킨 검증과는 구분한다.
실제 다른 DPI의 물리 모니터 이동, 초기 최대화 및 전체화면 옵션, 창 이벤트와 사용자
타이틀바, 다른 플랫폼 실행은 이번 상태 API 검증에 포함하지 않았다.
## 2026-10-10 네이티브 모달 이벤트 전송 보완

창 이동 모달 루프가 Bun 이벤트 루프를 막으면 Worker의 수신 확인을 처리하지 못해
네이티브 이벤트 용량 128개가 포화되는 문제를 재현했다. 기존 경로에서 5ms 간격으로
위치를 160번 바꾸면 이벤트 161개 중 33개가 BUSY로 거부됐다.

Win32 콜백은 기존 Channel에서 제한된 메시지 묶음을 읽어 수신 확인과 서버 전달을
진행한다. 자원을 바꾸는 나머지 패킷은 Bun 이벤트 루프가 재개된 뒤 처리하며,
중첩 읽기를 막는다. 이벤트 FIFO와 용량 제한, 권한 및 세션 검증은 유지한다.
새 `windows-modal-events.fixture.ts`는 실제 Win32 이동 모달 루프에서 5ms 간격으로
위치를 384번 변경하고, 양방향 순서와 모달 종료 전 서버 전달 및 정리를 검사했다.
이 검사는 물리 마우스 드래그를 실행하지 않는다.

실제 WebView2의 이벤트 전달, snapshot 복구, 구독 해제, 탐색, 재생성과 종료 검사는
통과했다. 실제 모달 시나리오도 분리 실행에서 백엔드 진행과 정상 정리를 통과했다.
전체 호스트를 다른 검사와 함께 실행한 첫 시도에서는 WebView 정리 기한을 초과했다.
로컬 실제 포커스 전환은 Windows가 활성화를 거부해 확인하지 못했다.

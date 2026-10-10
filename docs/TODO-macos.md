# macOS 데스크톱 기능 TODO

기준일: 2026-10-10. bunaway `5cabc6b`의 macOS arm64 구현과 기록된 실행 결과를 기준으로 갱신했다.
앱과 창의 수명 분리, 다중 창과 기본 창 API는 PR #77, #79와 #84의 병합 결과를 반영했다.
[Windows TODO](./TODO-windows.md)의 기능 영역을 기준으로 macOS의 현재 구현과
후속 작업을 정리한다. Tauri와 Electron의 비교 자료와 API 색인은 Windows TODO의
고정 스냅샷을 공유하며, 최신 API 전체를 새로 대조한 문서는 아니다.
공통 확장의 세부 요구사항은 해당 문서의 같은 번호 절을 함께 읽는다.

현재 제품 경로는 Bun 진입점, 메인 스레드의 AppKit/WKWebView 직접 FFI와 같은
프로세스의 백엔드 Worker다. 이전 C/ObjC++ 호스트와 Bun 자식 프로세스 실험의
완료 표시를 현재 구현으로 옮기지 않는다. 별도 개발자 진입점 없이 공통 앱 정의
하나를 사용하는 모델과 다중 창은 구현했다. 창 플러그인의 기본 제어를 제공하며,
`desktop`과 저장, 로그 등 다른 네이티브 플러그인 어댑터는 남아 있다.

## 상태와 작업 기준

- `[x]`는 기준 코드에 구현된 기능이다. 실제 실행 검증과 출시 지원은 별도로 판단한다.
- `[ ]`는 미구현, 부분 구현의 확장 또는 지원 방식을 결정해야 하는 작업이다.
- P1은 기본 실행과 앱 기능, P2는 기능 확장, P3은 고급 기능이다.
  개발 순서는 [Windows 우선 ADR](./decisions/0010-windows-first-platform-model.md)을 따른다.
- 호스트는 앱, 창, WebView와 세션 수명주기를 소유한다. 선택 플러그인은 개별 기능과
  자원을 관리하며 공통 실행, 권한, 이벤트와 종료 계약을 사용한다.
- 공유 TypeScript 계약이 있어도 macOS 어댑터가 없으면 완료로 표시하지 않는다.
  초기 창 설정과 실행 중 창 API, 프레임워크 진단과 앱 로그 API도 구분한다.
- 신뢰된 앱 백엔드는 Bun의 fetch, WebSocket, 파일, 프로세스 API를 사용할 수 있다.
  이것은 WebView에 정책을 적용해 제공하는 네이티브 기능과 별개의 실행 능력이다.
- GitHub Issues가 개별 작업과 상세 명세의 원본이다. 이슈를 만들면 해당 항목에 링크를 추가한다.
- 자동 업데이트와 선택 렌더러는 [PRD](./PRD.md)의 첫 릴리스 범위를 즉시 확대하는 결정이 아니다.

현재 구조는 [ADR 0015](./decisions/0015-macos-bun-ffi.md)와
[호스트 README](../native/macos/bun/README.md), 실제 실행 범위는
[Bun FFI 기록](./architecture/macos-bun-results.md)과
[플랫폼 지원 표](./platform-support/README.md)를 따른다.

| 영역 | 현재 구현 | 남은 범위 |
| --- | --- | --- |
| 실행 | 고정 Bun 1.4.2, 직접 FFI, 같은 PID의 백엔드 Worker, arm64 네이티브 CI 통과 | 최소 OS와 Intel 실행 검증 |
| 창 | 다중 창, 생성과 재생성, 기본 제어, 초기 크기 제약 | 준비 이벤트, 모달과 sheet, 상주 앱 |
| WebView | 명령, 이벤트, 정책, 자산 스킴, 탐색과 리소스 경계, 복구 | 영속 프로필과 세션 제어 API |
| 종료 | Worker 정리, 기한 초과 강제 종료, 프로세스 그룹 정리 | `desktop`, 종료 취소와 상주 앱 |
| 네이티브 플러그인 | 등록과 권한 검증, 기본 창 어댑터 | 저장, 로그, 기능 조회, opener와 창 제어 확장 |
| 배포 | compiled `.app`, 서명 및 DMG/PKG 조립 도구 | CLI 채널 연결, Developer ID, 공증, 설치와 Store 검증 |

## 01. 창 생성과 기본 수명주기

우선순위 P1. 소유자: 호스트와 창 API.

- [x] 공통 앱 정의와 `build.app`으로 단일 창을 생성한다.
- [x] 창 닫기와 앱 종료 요청에서 세션, 코어, Worker와 UI를 정리한다.
- [x] `app.windows`의 다중 창과 뷰별 정책, 세션, 임시 프로필을 지원한다. 한 뷰에 창 하나를 선언한다.
- [x] `startup: false` 창의 지연 생성, 닫은 창의 생성과 열린 창의 재생성을 제공한다.
- [x] 허용된 창 목록과 열림 여부, 개별 창의 표시와 포커스 여부를 조회한다.
- [ ] 창 ID, 현재 창, 포커스된 창과 마지막 활성 창을 조회한다.
- [x] 공개 show, hide, focus, close API를 제공한다.
- [ ] 숨긴 상태로 창을 생성하고 앱이 준비된 뒤 표시하는 초기 옵션을 제공한다.
- [ ] 포커스를 가져오지 않고 표시하는 `showInactive` API를 제공한다.
- [ ] 창 생성, 웹 문서 준비와 SDK 준비를 구분한 이벤트를 제공한다.
- [ ] 부모와 자식 창, 모달 창 및 sheet의 입력 차단과 종료 순서를 제공한다.
- [ ] 일반 close와 확인을 우회하는 destroy의 계약을 구분한다.
- [ ] 창 없는 상주 앱, 메뉴 막대 앱과 splashscreen 전환을 지원한다.
- [ ] 실행 중 창 옵션과 하나의 뷰에서 여러 창을 만드는 기능의 권한 및 식별자를 결정한다.

창과 뷰의 정책, 세션을 따로 관리하며 보조 창을 닫아도 다른 창과 백엔드는 유지한다.
재생성은 기존 세션을 폐기하고 새 세션을 만든다. 같은 뷰의 임시 WebKit 프로필은
앱 실행 중 유지하며 다른 뷰와 공유하지 않는다. 앱 종료 후 프로필은 남기지 않는다.
숨긴 창은 열린 창이며 마지막 열린 창을 닫으면 앱이 종료된다. 재생성 중에는 자동
종료를 보류한다. 생성 완료는 WebView 설정과 리소스 규칙 준비이며 웹 문서나 SDK
초기화 완료가 아니다. 공개 계약은 [창 API](./site/src/content/docs/reference/host/windows.mdx)를 따른다.

남은 공통 API는 Windows에서 계약과 구현을 먼저 확정한 뒤 macOS에 연결한다.
현재 지원 범위만 완료로 표시하며 01절 전체 완료를 뜻하지 않는다.
후속 계약과 선행 조건은 [이슈 #78](https://github.com/mathbook3948/bunaway/issues/78)에서 관리한다.

## 02. 창 크기와 위치, 최소 크기와 최대 크기 제약

우선순위 P1. 소유자: 호스트와 창 API.

- [x] 초기 내용 영역의 width와 height를 공통 창 설정에서 읽는다.
- [x] 초기 `minWidth`, `minHeight`, `maxWidth`, `maxHeight`를 AppKit 창에 적용한다.
- [x] 초기 크기를 제약 안으로 보정하고 사용자 크기 변경에도 제약을 적용한다.
- [x] 제약의 `null`과 생략은 제한 없음으로 처리하고 한 축만 제한할 수 있다.
- [x] 공통 설정 검증으로 200–4096 범위와 min > max 입력 오류를 처리한다.
- [ ] `setSize`, `setPosition`과 최소/최대 제약의 실행 중 변경 및 조회를 제공한다.
- [ ] content와 outer 크기, 위치, bounds와 최대화 전 normal bounds를 구분한다.
- [ ] AppKit 좌표와 공통 좌표의 원점, 논리 픽셀과 backing scale 변환을 정의한다.
- [ ] 초기 x, y, center, 실행 중 중앙 배치와 작업 영역 넘침 방지를 제공한다.
- [ ] 모니터 이동, 배율 변경과 전체화면 해제 뒤 현재 제약을 유지한다.
- [ ] resizable, movable, aspect ratio와 선택적 크기 및 위치 애니메이션을 제공한다.
- [ ] 실제 화면과 배율에 맞춰 공통 4096 상한의 유지 여부를 결정한다.

## 03. 창 상태, 외관과 사용자 타이틀바

우선순위 P1, 효과와 특수 창은 P2. 소유자: 호스트와 창 API.

현재 네이티브 창의 기본 버튼과 사용자 조작은 공개 창 제어 API의 구현으로 세지 않는다.
창 상태 변경과 크기, 위치, 전체화면 및 닫기 확인의 실행 중 macOS 호출은 `UNSUPPORTED`다.

- [ ] minimize, maximize, unmaximize, restore와 toggleMaximize를 공통 계약에 맞춘다.
- [x] `isVisible`과 `isFocused`로 실제 창의 표시 상태와 포커스 여부를 조회한다.
- [ ] 최소화, 최대화와 전체화면 상태를 조회한다.
- [ ] 초기 maximized/fullscreen 옵션과 실행 중 전체화면 전환을 제공한다.
- [ ] native fullscreen과 simple fullscreen, 전환 완료와 복원 동작을 구분한다.
- [ ] minimizable, maximizable, closable, fullscreenable과 focusable을 제공한다.
- [ ] 창 title과 icon의 실행 중 변경과 조회를 제공한다.
- [ ] decorations, titlebar style, traffic-light 위치와 버튼 표시를 제공한다.
- [ ] 사용자 타이틀바의 drag/no-drag 영역과 프로그램 이동 및 크기 조절을 제공한다.
- [ ] alwaysOnTop, 창 순서, 키오스크와 작업 공간 표시의 지원 범위를 결정한다.
- [ ] background color, 투명 배경, opacity, shadow와 vibrancy를 제공한다.
- [ ] content protection, click-through, cursor와 attention 기능의 지원 범위를 결정한다.
- [ ] 접근성용 창 제목과 신뢰된 어댑터의 NSWindow/WKWebView 접근 범위를 정한다.

## 04. 창 이벤트와 상태 저장

우선순위 P1. 소유자: 호스트와 선택 상태 저장 기능.

- [ ] created, ready, shown, hidden, closed와 destroyed 이벤트를 제공한다.
- [ ] focus/blur, move/resize와 현재 bounds, 최소화/최대화/복원 이벤트를 제공한다.
- [ ] 전체화면 전환, backing scale, 화면과 theme 변경 이벤트를 제공한다.
- [ ] close-requested와 비동기 저장 후 닫기 승인, 확인 메시지를 제공한다.
- [ ] 구독 해제와 창 재생성 및 종료 시 구독 정리를 보장한다.
- [ ] 위치, 크기, 최대화, 전체화면과 표시 상태의 선택적 저장 및 복원을 제공한다.
- [ ] 모니터 제거와 작업 영역 변경 뒤 보이는 위치로 복원한다.
- [ ] 모니터 모서리, 중앙과 메뉴 막대 아이콘 근처로 창을 배치한다.

## 05. 앱 수명주기와 실행 정보

우선순위 P1. 소유자: 호스트와 desktop API.

`app.desktop`을 선언하면 백엔드는 `UNSUPPORTED`로 시작을 거부한다.
Windows의 `beforeQuit`, `onOpen`과 트레이 종료 동작은 현재 macOS 기능이 아니다.

- [x] 번들 Bun을 앱 진입점으로 실행하고 AppKit 메인과 백엔드 Worker를 같은 PID에 둔다.
- [x] 시작 실패와 UI 초기화 실패에도 코어와 플러그인의 종료를 기다린다.
- [x] 종료 요청부터 5초 안에 Worker가 정리되지 않으면 강제 종료하고 실패를 기록한다.
- [x] 정상 종료와 SIGINT/SIGTERM에서 관리하는 프로세스 그룹을 정리한다.
- [x] 호스트 SIGKILL 뒤 감시 프로세스가 pipe EOF를 받아 같은 그룹의 자손을 정리한다.
- [ ] 공통 `desktop` 계약의 `onOpen`, `beforeQuit`와 종료 이유를 연결한다.
- [ ] 단일 인스턴스 잠금과 두 번째 실행의 argv/cwd, 파일과 URL 전달을 제공한다.
- [ ] ready 이전 파일 열기, URL 열기와 종료 요청의 순서를 정한다.
- [ ] 마지막 창 닫기, 앱 종료, app hide/show와 Dock 재활성화를 구분한다.
- [ ] 종료 취소 뒤 기존 창과 세션을 유지하고 개발 CLI 중단은 취소를 우회한다.
- [ ] ready, before-quit, will-quit, quit과 모든 창 닫힘의 공개 이벤트를 제공한다.
- [ ] exit, relaunch와 인자 보존, 앱 및 런타임 버전, 실행 경로와 packaged 상태를 조회한다.
- [ ] 앱 WebView와 일반 브라우저 및 SSR 실행을 구분하는 공개 기능을 제공한다.
- [ ] About 패널, 앱 이름과 데이터 경로 지정, 비정상 종료 이벤트를 제공한다.

## 06. 트레이와 메뉴 막대 아이콘

우선순위 P1. 소유자: 선택 기능, 앱 실행 유지와 종료는 호스트.

- [ ] 메뉴 막대 아이콘의 생성과 해제, tooltip, title과 메뉴를 제공한다.
- [ ] 일반, template와 pressed 이미지, Retina 표현과 접근성 이름을 제공한다.
- [ ] click, double-click, 우클릭, drop/drag와 아이콘 bounds를 제공한다.
- [ ] 숨김과 복원, 마지막 창 닫기 후 실행 유지와 Quit의 종료 승인을 연결한다.
- [ ] 앱 재활성화와 화면 변경 뒤 아이콘, 메뉴와 구독의 수명을 검증한다.

## 07. 메뉴와 키보드 단축키

우선순위 P1, 고급 메뉴는 P2. 소유자: 선택 메뉴 및 단축키 기능.

- [ ] 앱 메뉴, 창 메뉴와 context menu, item/submenu/separator를 제공한다.
- [ ] enabled, visible, checked, radio, icon과 accelerator를 제공한다.
- [ ] About, Quit, Edit, Help, Window와 Services 역할을 네이티브 메뉴에 연결한다.
- [ ] 메뉴 삽입, 변경, 삭제, 조회와 popup 위치 및 선택 결과를 제공한다.
- [ ] 앱 및 창 단축키와 전역 단축키의 등록, 조회와 해제를 제공한다.
- [ ] 등록 충돌, 사용자 단축키와 권한 거부, 종료 시 정리를 정의한다.
- [ ] 모든 전역 단축키의 일시 중지와 재개를 제공한다.
- [ ] 메뉴 header, palette, badge와 사용자 지정 accelerator의 필요성 및 최소 OS를 결정한다.

## 08. 로그인 시 자동 실행

우선순위 P1. 소유자: 선택 자동 실행 기능과 패키저.

- [ ] 로그인 항목 등록, 해제와 현재 상태 조회를 제공한다.
- [ ] 사용자가 승인 또는 비활성화한 상태와 앱 설정을 구분한다.
- [ ] 숨김 실행, 인자, 실행 경로 변경과 업데이트 후 등록 유지의 계약을 정한다.
- [ ] 직접 배포와 App Sandbox에서의 helper, 서명과 허용 경로를 검증한다.

## 09. OS 셸, 파일 연결과 Dock

우선순위 P1, 확장은 P2. 소유자: opener, desktop과 패키저.

- [ ] HTTP/HTTPS URL을 기본 브라우저에서 여는 macOS opener 어댑터를 제공한다.
- [ ] 파일 및 폴더 열기, 지정 앱 열기, Finder에서 표시와 휴지통 이동을 제공한다.
- [ ] URL scheme과 파일 유형 연결의 plist 설정, OS 열기 요청과 `onOpen`을 연결한다.
- [ ] universal link의 설정, 검증과 시작 전 요청 처리를 제공한다.
- [ ] 기본 앱 등록 상태와 최근 문서의 추가, 조회 및 삭제를 제공한다.
- [ ] Dock icon, badge, bounce, menu와 진행 상태의 지원 범위를 정한다.
- [ ] Applications 위치 조회와 앱 이동을 제공하고 실행 중 이전 경로 처리를 정의한다.

## 10. 알림

우선순위 P1, 예약과 확장은 P2. 소유자: 선택 알림 기능.

- [ ] 지원 상태와 OS 권한 조회, 요청 및 거부 결과를 제공한다.
- [ ] 제목, 본문, 아이콘과 소리를 가진 로컬 알림을 제공한다.
- [ ] 클릭, action, 응답과 종료 이벤트를 앱 수명주기에 연결한다.
- [ ] 알림 식별자, 갱신, 취소, 예약과 목록 조회를 제공한다.
- [ ] 직접 배포와 sandbox 앱의 식별자, 권한과 재실행 동작을 검증한다.

## 11. 대화상자와 파일 선택

우선순위 P1. 소유자: 선택 대화상자 기능과 호스트 UI 경로.

- [ ] message, confirm과 prompt, 버튼 및 취소 결과를 제공한다.
- [ ] open/save panel의 파일, 폴더, 다중 선택과 유형 필터를 제공한다.
- [ ] 부모 창의 sheet와 앱 모달, 부모 창 종료 및 요청 취소를 연결한다.
- [ ] 선택한 파일의 접근 범위와 security-scoped bookmark의 수명 및 해제를 정의한다.
- [ ] 기본 위치, 파일명, 덮어쓰기 확인, 확장자 처리와 오류를 정의한다.

## 12. 클립보드와 이미지 리소스

우선순위 P1, 확장은 P2. 소유자: 선택 기능.

- [ ] 텍스트, HTML, 이미지와 파일 목록의 읽기, 쓰기 및 비우기를 제공한다.
- [ ] pasteboard 유형 조회, 사용자 지정 형식과 변경 감지의 지원 범위를 정한다.
- [ ] 이미지 파일과 bytes의 로드, 크기 조회, resize와 PNG 내보내기를 제공한다.
- [ ] Retina 이미지, template 이미지와 네이티브 이미지 자원의 해제를 정의한다.
- [ ] 민감한 클립보드 데이터와 비동기 접근의 실패 및 종료 동작을 정의한다.

## 13. 모니터, 테마, 접근성과 전원

우선순위 P1, 고급 기능은 P2. 소유자: 선택 시스템 기능과 호스트.

- [ ] 화면 목록, 주 화면, 현재 화면과 점에 해당하는 화면을 조회한다.
- [ ] 화면 크기, 작업 영역, backing scale과 좌표 변환을 제공한다.
- [ ] 화면 연결 및 제거, 배율 변경과 창 이동 이벤트를 제공한다.
- [ ] light/dark/system 설정, 실제 theme와 대비 및 동작 줄이기를 조회한다.
- [ ] 테마 및 접근성 설정 변경 이벤트와 WebView 반영을 제공한다.
- [ ] 접근성 지원 상태, trust 조회와 사용자 승인 요청을 제공한다.
- [ ] VoiceOver, 키보드 탐색, IME와 사용자 타이틀바 접근성을 검증한다.
- [ ] suspend/resume, 잠금, 전원과 배터리 상태 및 변경 이벤트를 제공한다.
- [ ] 화면 및 시스템 절전 방지의 시작, 해제와 종료 정리를 제공한다.

## 14. WebView 생성, 배치와 기본 제어

우선순위 P1, 배치 확장은 P2. 소유자: 호스트와 렌더러 API.

- [x] 단일 WKWebView에 로컬 자산과 검증한 개발 서버를 연결한다.
- [x] 비영속 `WKWebsiteDataStore`를 사용한다.
- [x] WebContent 프로세스 종료 시 이전 세션을 폐기하고 home을 다시 로드한다.
- [ ] 뷰별 영속 프로필과 저장소 식별자, 데이터 경로 및 수명을 제공한다.
- [ ] 생성, 조회, close와 WebView별 bounds, 표시 및 포커스 API를 제공한다.
- [ ] 한 창의 여러 WebView, native child view와 배치 및 순서를 제공한다.
- [ ] URL, HTML과 로컬 파일 로드, reload, cache 무시 reload와 stop을 제공한다.
- [ ] zoom, background, user agent와 렌더러 상태를 조회 및 설정한다.
- [ ] 준비, 로드 완료, 실패와 복구의 공개 이벤트를 제공한다.

## 15. WebView 탐색, 편집, 스크립트와 입력

우선순위 P2. 소유자: 렌더러 API와 호스트 정책.

- [x] 네이티브 탐색 delegate에서 허용 origin과 실제 frame을 확인한다.
- [x] 문서 교체는 세션을 폐기하고 History API의 같은 문서 이동은 세션을 유지한다.
- [x] 허용되지 않은 탐색, iframe 탐색과 새 창 요청을 차단한다.
- [ ] 뒤로, 앞으로, history 조회와 탐색 승인 및 취소의 공개 API를 제공한다.
- [ ] find, selection, 편집 명령과 spelling 기능을 제공한다.
- [ ] 스크립트 실행, isolated world와 preload의 권한 및 수명을 정의한다.
- [ ] frame tree, URL과 origin 조회, frame별 작업의 지원 범위를 정한다.
- [ ] 입력 전 이벤트, 입력 주입, IME, cursor와 gesture를 제공한다.
- [ ] 파일 drop과 앱 밖으로 drag, File 객체와 OS 경로의 안전한 연결을 제공한다.
- [ ] audio muted/audible, media 상태와 링크 hover 이벤트를 제공한다.

## 16. WebView 세션, 네트워크와 프로토콜

우선순위 P2. 소유자: 렌더러, 세션과 호스트 정책.

- [x] 호스트 소유 자산 스킴을 공통 `https://app.bunaway.local` origin 계약에 연결한다.
- [x] 로컬 자산의 실제 경로를 확인하고 자산 루트 밖 접근을 거부한다.
- [x] `WKContentRuleList`로 선언한 리소스 origin을 제한한다.
- [x] 앱과 뷰에 고정한 규칙 식별자로 재실행 시 기존 규칙을 교체한다.
- [ ] cookie 조회, 설정, 삭제와 변경 이벤트, flush를 제공한다.
- [ ] cache와 localStorage, IndexedDB 및 service worker 데이터 조회와 삭제를 제공한다.
- [ ] 영속 여부, storage path와 origin 또는 기간별 정리를 제공한다.
- [ ] proxy, 인증 및 client certificate, 인증서 오류의 지원 범위를 정한다.
- [ ] 요청 취소, redirect, header 및 응답 stream 변경의 지원 범위를 정한다.
- [ ] online 상태, network log와 네트워크 진단을 제공한다.
- [ ] 사용자 지정 protocol의 등록, 해제와 bytes/file/text/stream 응답을 제공한다.
- [ ] MIME, range, CORS, secure origin과 service worker 지원을 명시한다.
- [ ] scope를 검사하는 로컬 파일 표시 URL 변환을 제공한다.
- [ ] preload, service/shared worker와 브라우저 extension 지원 범위를 정한다.

## 17. WebView 권한과 장치

우선순위 P2. 소유자: 호스트 권한 중재와 기능별 어댑터.

- [x] `WKUIDelegate`에서 카메라와 마이크 capture 요청을 거부한다.
- [ ] 권한 check/request 훅, 실제 origin/frame 검사와 결정 저장 및 초기화를 제공한다.
- [ ] 앱 정책, 기능 지원과 OS 동의를 구분하는 조회 및 요청 흐름을 제공한다.
- [ ] 프로덕션 CSP와 devCSP, nonce/hash 및 HMR origin을 정의하고 실제 차단을 검증한다.
- [ ] 자산 응답의 보안 헤더와 WKURLSchemeHandler의 적용 가능 범위를 정의한다.
- [ ] 카메라/마이크, 위치, 알림과 클립보드 권한 및 설명 설정을 연결한다.
- [ ] 화면 capture, fullscreen, pointer/wake lock과 파일 접근을 연결한다.
- [ ] Bluetooth, USB, Serial, HID, MIDI와 WebAuthn의 WKWebView 지원 또는 미지원 결과를 정한다.
- [ ] 미지원 기능을 선택 렌더러 필요 여부 또는 `UNSUPPORTED`로 명시한다.

## 18. 다운로드, 인쇄와 캡처

우선순위 P2. 소유자: 렌더러 API와 선택 전송 및 capture 기능.

- [x] 탐색에서 다운로드로 전환한 `WKDownload`를 취소한다.
- [ ] 다운로드 승인, 저장 위치 선택과 URL, filename 및 MIME 조회를 제공한다.
- [ ] 진행률, 완료와 실패, pause/resume/cancel과 중단 후 재개를 제공한다.
- [ ] 업로드와 다운로드의 취소, timeout과 stream을 제공한다.
- [ ] 프린터 조회, 인쇄 대화상자와 옵션, PDF 내보내기를 제공한다.
- [ ] 페이지 및 영역 snapshot과 HTML 저장을 제공한다.
- [ ] 화면과 창 capture source, 사용자 선택과 OS 권한을 연결한다.
- [ ] 화면 및 시스템 audio 공유의 지원 OS와 API 범위를 정한다.

## 19. 파일 시스템, 경로와 데이터 저장

우선순위 P1, 확장은 P2. 소유자: 선택 저장 기능.

현재 fixture의 메모는 Bun 메모리 상태다. 이전 호스트의 파일 저장 성공 기록은
현재 `@bunaway/plugin-storage` macOS 어댑터의 검증이 아니다.

- [ ] appData/temp 범위의 UTF-8 읽기와 쓰기, exists/stat 어댑터를 제공한다.
- [ ] 경로 순회, symlink, hardlink와 대상 교체를 막고 파일 핸들의 소유권을 정의한다.
- [ ] binary/append/open 핸들, 디렉터리 목록과 생성 및 삭제를 제공한다.
- [ ] copy/rename/move, watch, 원자적 저장과 대용량 stream을 제공한다.
- [ ] 파일 metadata와 OS 권한, 디렉터리 재귀 용량의 오류 및 취소를 정의한다.
- [ ] 파일 선택으로 얻은 범위와 security-scoped bookmark의 영속화 및 철회를 제공한다.
- [ ] 사용자 디렉터리, appData/cache/logs/temp/resource 경로를 제공한다.
- [ ] Unicode 정규화, 대소문자 구분 파일 시스템과 sandbox container 경로를 검증한다.
- [ ] key-value store의 load/save, 변경 이벤트와 autosave를 제공한다.
- [ ] defaults 병합, reload, reset과 저장 실패 시 원본 보존을 정의한다.
- [ ] SQLite의 query/execute, transaction과 migration 지원 범위를 정한다.
- [ ] 신뢰된 백엔드의 직접 Bun 파일 및 SQLite 사용과 정책 중재 API를 문서에서 구분한다.

## 20. OS 정보, HTTP, WebSocket와 프로세스

우선순위 P2. 소유자: 선택 기능, 기본 실행 능력은 번들 Bun.

- [x] 플러그인 정리 후 같은 그룹의 하위 프로세스와 `unref()` 프로세스를 정리한다.
- [x] 별도 그룹의 프로세스를 종료하지 않는다. 앱이 새 세션이나 그룹으로 분리한 자손은 관리 범위 밖이다.
- [ ] OS, CPU, locale, 언어, 메모리와 translation 상태를 조회한다.
- [ ] URL scope를 적용한 HTTP, stream, 취소와 timeout을 제공한다.
- [ ] 정책을 적용한 WebSocket 연결과 backpressure를 제공한다.
- [ ] 실행 파일과 argv scope, stdin/stdout/stderr, exit와 signal 계약을 제공한다.
- [ ] shell 문자열과 argv 실행, timeout 및 앱 종료 정리를 구분한다.
- [ ] 번들 sidecar의 서명, helper 배치, 라이선스와 sandbox 실행을 검증한다.
- [ ] utility process, 양방향 메시지와 독립 프로세스 오류를 제공한다.
- [ ] CLI argument schema와 선택 localhost 자산 서버의 필요성을 결정한다.

## 21. 암호화 저장과 시스템 인증

우선순위 P2. 소유자: 선택 보안 기능.

- [ ] Keychain의 secret 저장, 조회, 삭제와 지원 상태를 제공한다.
- [ ] 암호화 및 복호화, 키 교체와 재암호화 필요 여부를 제공한다.
- [ ] 잠긴 저장소와 영구 실패를 구분하고 취소, 기한과 재시도를 정의한다.
- [ ] 평문 fallback을 묵시적으로 사용하지 않고 손상 입력과 저장 실패를 처리한다.
- [ ] Touch ID 지원 조회, 사용자 확인과 취소를 제공한다.
- [ ] vault 방식의 lock/unlock/save, 암호 변경과 키 작업의 필요성을 결정한다.
- [ ] 다른 사용자, 재설치와 기기 이동, Keychain 접근 그룹의 오류를 검증한다.

## 22. 자동 업데이트와 앱 배포 기능

우선순위 P2, 첫 공개 릴리스 준비는 P1. 소유자: 패키저, 호스트와 updater.

- [x] 고정 Bun으로 호스트, 앱 정의와 Worker를 compiled 실행 파일로 만든다.
- [x] 실행 파일을 `Contents/MacOS/bunaway-host`, 웹 자산과 정책을 `Contents/Resources`에 둔다.
- [x] 별도 Bun 설치와 C 컴파일러 없이 `.app`을 만들고 ad-hoc 서명한다.
- [x] 앱 메타데이터와 자산 inventory를 검증한 뒤 앱 코드와 UI를 시작한다.
- [x] 서명 도구에서 compiled 호스트의 Bun JIT 및 FFI entitlements를 적용한다.
- [x] staged 복사본을 서명하고 번들 서명 검증 후 게시한다. 실패 시 이전 앱 보존 경로가 있다.
- [x] mac-direct DMG와 mac-store PKG 조립 도구가 있다.
- [x] notarytool 제출 결과 확인과 stapling, ZIP 재조립 도구가 있다.
- [ ] 공통 CLI `bunaway package mac-direct/mac-store`에 채널 어댑터를 연결한다.
- [ ] compiled 실행 파일의 서명 후 해시 기록을 공통 배포 manifest 규칙에 맞춘다.
- [ ] 실제 Developer ID 서명, 공증과 Gatekeeper 검증을 완료한다.
- [ ] sandbox와 실제 배포 인증서로 서명한 현재 제품의 WKWebView와 프로세스 감시를 검증한다.
- [ ] 설치, 업데이트, 제거와 앱 데이터 및 파일 연결 보존을 검증한다.
- [ ] 업데이트 조회, channel/target, 서명 검증과 다운로드 진행 및 취소를 제공한다.
- [ ] 종료 승인, 설치, relaunch와 실패 복구 및 rollback을 연결한다.
- [ ] Store 업데이트와 자체 updater의 사용 조건을 구분한다.
- [ ] 프레임워크 및 선택 패키지의 공개 배포, 라이선스와 릴리스 자동화를 완료한다.

도구 구현과 인증서를 사용한 실행 성공, 설치 및 스토어 승인은 별개다.
현재 도구는 [패키징 README](../packages/packaging/README.md)와
[macOS 배포 스크립트](../packages/packaging/scripts/README.md)를 따른다.
[이전 Sandbox 기록](./architecture/macos-sandbox-results.md)은 실험 자료이며
현재 Bun FFI 호스트의 안정성과 App Store 적합성을 증명하지 않는다.

## 23. 명령, 이벤트와 전송 확장

우선순위 P1은 현재 계약 유지, 확장은 P2. 소유자: SDK, 코어와 프로토콜.

- [x] 공통 SDK의 invoke, 입력 및 출력 schema와 앱 정의의 타입 추론을 제공한다.
- [x] 이벤트 구독, 해제와 정책에 따른 전달을 WKWebView 브리지에 연결한다.
- [x] 출처와 frame, 호출 컨텍스트, 취소, deadline과 늦은 응답을 검사한다.
- [x] 문서 교체와 종료 시 요청 및 구독을 정리한다.
- [x] Worker 채널의 패킷 검증, 수신 확인과 용량 제한을 Windows와 공유한다.
- [x] 네이티브 JSON 직렬화 전 변환 불가 메시지를 거부하고 정상 메시지 처리를 유지한다.
- [x] macOS 네이티브 플러그인 카탈로그와 기본 창 어댑터를 공통 등록 및 권한 계약에 연결한다.
- [ ] 기능 지원 조회에서 실제 macOS 작업과 OS 권한 상태를 보고한다.
- [ ] once와 native 이벤트, binary payload, stream/channel과 transferable 자원 계약을 제공한다.
- [ ] UI 명령 및 이벤트의 타입과 정책 목록 생성, 브라우저 테스트 transport를 제공한다.
- [ ] 동기 IPC와 UI의 임의 Node/Bun 접근은 PRD와의 충돌을 먼저 결정한다.

UI 초기화에서 `CommandsOf`와 `EventsOf`로 타입을 지정한 client를 만들고 실패를
처리하는 방식을 권장한다. 직접 함수 API도 유지하며 컴포넌트 정리는 구독만 해제한다.
macOS 브리지의 변경에서도 두 사용 방식의 공통 SDK 계약을 유지한다.

## 24. 개발 도구, 진단과 성능 API

우선순위 P1은 개발 흐름, 확장은 P2. 소유자: CLI, 호스트와 로그 플러그인.

- [x] 검증한 외부 UI 개발 URL과 HMR 리소스를 WKWebView에 연결한다.
- [x] 앱 코드 변경에서 전체 앱을 재시작하는 CLI 경로가 있다.
- [x] 웹 build.command와 앱 빌드를 통합한다.
- [x] 플러그인 없이 호스트 시작, 탐색, 권한 거부, 복구와 종료 진단을 남긴다.
- [x] UI 타이머 밖 Cocoa 호출에도 autorelease pool을 사용해 임시 객체를 정리한다.
- [x] 단일 WKWebView의 idle run loop와 4KB 응답 24,000개 전달의 측정 및 재현 방법을 기록했다.
- [ ] 앱 로그 플러그인의 macOS 어댑터, level/target/rotation/retention과 flush를 제공한다.
- [ ] WKWebView inspector 설정과 DevTools 열기, 닫기 및 상태 조회를 제공한다.
- [ ] 백엔드 `dev --inspect`를 macOS Worker에 연결한다. 현재 CLI는 Windows만 허용한다.
- [ ] Windows의 호환 명령 교체를 macOS에 적용할 필요성과 Worker 경계를 결정한다.
- [ ] 각 템플릿의 실제 macOS dev, HMR, build와 package 실행을 검증한다.
- [ ] 시작 시간, 메모리, 패키지 크기와 명령 지연을 재현 가능한 입력 규모로 측정한다.
- [ ] tracing, crash report, network log와 사용자 선택 업로드의 지원 범위를 정한다.

## 25. 선택 렌더러와 고급 데스크톱 기능

우선순위 P3. 소유자: 선택 렌더러와 기능 패키지.

- [ ] 선택 Chromium 렌더러를 같은 SDK, 정책과 공통 앱 정의에 연결한다.
- [ ] 엔진별 기능 조회와 미지원 결과, Web API 차이를 검증한다.
- [ ] offscreen rendering, frame subscription과 shared texture의 지원 범위를 정한다.
- [ ] guest WebView, extension과 native View tree의 권한 및 자원 수명을 정의한다.
- [ ] 신뢰된 백엔드의 별도 프로세스 격리가 필요한지 결정한다.
- [ ] 실험적인 AI 및 GPU 기능은 실제 앱 요구와 배포 비용을 확인한 뒤 결정한다.

## 26. macOS 전용 기능

우선순위 P2, 특수 하드웨어와 고급 연동은 P3. 소유자: 호스트와 선택 기능.

- [x] 일반 activation policy로 AppKit 앱을 시작한다.
- [ ] activation policy 변경과 Dock visibility, app hide/show를 제공한다.
- [ ] 창 tab의 추가, 분리와 이동, tab bar를 제공한다.
- [ ] represented filename, document edited와 sheet 이벤트를 제공한다.
- [ ] Mission Control 숨김과 모든 workspace 표시, first-mouse 및 gesture를 제공한다.
- [ ] Quick Look와 선택 단어 사전 기능을 제공한다.
- [ ] Touch Bar 구성과 자원 해제의 지원 필요성을 결정한다.
- [ ] Services 및 Share menu를 메뉴 및 파일 접근 계약에 연결한다.
- [ ] NSUserDefaults, local/distributed/workspace notification을 제공한다.
- [ ] Handoff와 user activity의 시작, 갱신 및 종료를 제공한다.
- [ ] secure keyboard entry와 접근성 trust 요청을 제공한다.
- [ ] Store in-app purchase와 transaction 복원, APNs 등록 및 수신을 제공한다.

## 27. 다른 플랫폼과 공유하는 범위

Linux와 모바일 전용 기능은 이 문서의 macOS 완료 항목에 포함하지 않는다.
공통 명령, 이벤트와 앱 정의를 유지하며 해당 플랫폼의 실행, 권한과 배포 작업은
[Windows TODO의 27절](./TODO-windows.md#27-모바일-전용-공식-기능)과 PRD에서 관리한다.
iOS의 WKWebView 구현은 macOS 구현만으로 완료 처리하지 않는다.

## 28. 플랫폼 지원과 완료 검증

우선순위 P1. 소유자: 기능 구현 담당자와 배포 도구.

아래 완료 표시는 저장소에 기록된 실행 결과를 뜻한다. 이 문서를 작성하면서 해당
네이티브 실행을 새로 수행한 것은 아니다.

- [x] 고정 arm64 Bun의 버전, revision과 해시를 확인하고 C 컴파일 없는 빌드를 제공한다.
- [x] macOS 26.7.1 arm64 로컬 GUI에서 실제 WKWebView 회귀 7개를 통과했다.
- [x] ad-hoc `.app`에서 같은 회귀 7개와 배포 도구 회귀를 통과했다.
- [x] 로컬 mac-direct hardened runtime 서명 뒤 WKWebView 보고서와 정상 종료를 확인했다.
- [x] 실제 Worker의 명령, 세션 폐기와 플러그인 종료, UI 초기화 실패와 종료 기한을 검사했다.
- [x] 일반 및 `unref()` 자손, 무한 종료 훅과 SIGKILL의 프로세스 그룹 정리를 검사했다.
- [x] 실제 창의 초기 크기 보정과 최소/최대 제약, 제한 해제를 검사했다.
- [x] 설치된 네이티브 delegate로 카메라/마이크 거부를 검사했다. 실제 장치를 열지는 않았다.
- [x] JSON 변환 불가 메시지, 응답 전달 메모리와 리소스 규칙 교체 회귀를 검사했다.
- [x] compiled 앱에서 다중 창, 지연 생성과 반복 재생성, 뷰별 권한 및 세션 분리, 마지막 창의 자기 재생성과 종료를 검증했다.
- [x] GitHub Actions의 macOS 15 arm64에서 실제 WKWebView와 서명한 `.app` 회귀를 통과했다. [기준 커밋의 CI 실행](https://github.com/mathbook3948/bunaway/actions/runs/38042996617/job/114186820712)에 결과를 기록했다.
- [ ] 최소 지원 macOS와 WKWebView 환경을 실제 기기에서 확정한다. plist의 14.0 값만으로 지원을 선언하지 않는다.
- [ ] Intel Bun pin, FFI ABI, 빌드와 실제 실행을 지원하거나 제외를 확정한다.
- [ ] 다중 화면과 Retina, 다른 배율의 이동, fullscreen/Spaces와 화면 제거를 검증한다.
- [ ] IME, keyboard layout, VoiceOver와 접근성, suspend/resume 및 잠금을 검증한다.
- [ ] 저장 등 추가 네이티브 플러그인과 공통 메모 샘플의 파일 저장을 실제 앱에서 검증한다. 기본 창 어댑터와 다중 창 검증은 위 완료 항목에 포함한다.
- [ ] Developer ID 서명, 공증 및 stapling 뒤 깨끗한 Mac의 Gatekeeper와 설치를 검증한다.
- [ ] App Sandbox에서 현재 compiled 앱의 JIT/FFI, WebKit XPC와 감시 프로세스를 검증한다.
- [ ] Apple Distribution 및 provisioning, Store 제출, 심사와 설치 결과를 각각 기록한다.
- [ ] 설치, 최초 실행, 덮어쓰기 업데이트와 제거에서 데이터와 연결을 검증한다.
- [ ] 지원 목록, CLI 진단, 앱 개발 문서와 배포 산출물을 같은 릴리스로 맞춘다.

## 다음 작업 묶음

1. 저장, 로그, 기능 조회 및 opener의 macOS 어댑터: 09, 19, 23, 24. 카탈로그와 기본 창 어댑터는 구현했다.
2. 창 식별과 조회, 숨긴 초기 창, `showInactive`, 준비 이벤트, 모달 및 desktop 수명주기: 01–05. 공통 선행 계약은 #78에서 관리한다.
3. 메뉴 막대 아이콘, 메뉴, 자동 실행, 알림, 파일 선택과 클립보드: 06–12.
4. 영속 WebView 프로필, 권한 중재, 모니터와 접근성: 13–18.
5. CLI 배포 채널 연결, 최소 지원 OS와 Intel, Developer ID, 설치 및 Sandbox 검증: 22, 28. 현재 arm64 제품의 CI는 통과했다.
6. 업데이트, 보안 저장과 고급 macOS 연동: 20, 21, 25, 26. PRD 범위와 별도로 우선순위를 결정한다.

## 구현과 검증 근거

- [다중 창 설정과 카탈로그 권한 검증](../native/macos/bun/config.ts)
- [AppKit 앱 수명과 뷰별 임시 프로필](../native/macos/bun/application.ts)
- [개별 창 소유권, 생성과 정리 및 세션 경계](../native/macos/bun/windows.ts)
- [백엔드 Worker와 Host API, desktop 미지원 처리](../native/macos/bun/backend.ts)
- [시작과 Worker 종료](../native/macos/bun/entry.ts)
- [AppKit, WKWebView, 정책과 리소스 경계](../native/macos/bun/webview.ts)
- [프로세스 그룹 소유와 감시](../native/macos/bun/process-group.ts)
- [CLI 빌드](../packages/cli/src/build.ts)와 [compiled 앱 생성](../packages/cli/src/macos-compile.ts)
- [macOS 서명](../packages/packaging/src/channels/macos/sign.ts),
  [공증](../packages/packaging/src/channels/macos/notarize.ts)과
  [DMG/PKG 조립](../packages/packaging/src/channels/macos/package.ts)
- [계약 및 실제 네이티브 검사 구분](../tests/README.md)
- [실제 compiled 앱의 다중 창 및 기본 창 API 회귀](../tests/lifecycle/macos-window-api.ts)
- [기준 커밋의 macOS 네이티브 CI 결과](https://github.com/mathbook3948/bunaway/actions/runs/38042996617/job/114186820712)
- [현재 Bun FFI 실행 결과](./architecture/macos-bun-results.md),
  [이전 네이티브 기록](./architecture/macos-native-results.md)과
  [이전 Sandbox 기록](./architecture/macos-sandbox-results.md)

# 데스크톱 기능 TODO: Tauri와 Electron 비교

기준일: 2026-10-08. bunaway `38c233b`의 Windows 구현과 이후 compiled EXE 배포 전환을 반영했다.
Tauri v2의 기본 API와 공식 플러그인, Electron의 공개 API를 기능별로 대조한다.
창 최소 크기와 최대 크기처럼 초기 설정, 실행 중 변경, 조회, 이벤트가 따로 필요한
기능은 각각 작업으로 기록한다. 비교 대상의 메서드 이름이나 바이너리와의 호환을
요구하는 문서가 아니라, 같은 앱 요구사항을 해결하기 위한 개발 목록이다.

## 상태와 작업 기준

- `[x]`는 아래 기준 코드에 구현된 Windows 기능이다. 출시 지원 전체의 완료를 뜻하지 않는다.
- `[ ]`는 미구현, 부분 구현의 확장 또는 지원 방식을 결정해야 하는 작업이다.
- P1은 일반 데스크톱 앱의 기본 기능, P2는 기능 확장, P3은 고급 기능과 다른 플랫폼의 후속 작업이다.
- 각 절의 소유자는 권장안이다. 호스트는 앱, 창, WebView와 세션의 최종 수명주기를 소유한다.
  선택 플러그인은 개별 기능과 자원을 관리하며 호스트의 실행, 이벤트, 종료 계약을 사용한다.
- 내장 기능, 선택 패키지, 플러그인이라는 배포 형태와 실행 책임을 구분한다.
  트레이와 메뉴를 선택 패키지로 제공하더라도 호스트와 같은 UI 실행 경로를 사용할 수 있다.
- 기존 플러그인 구조 개편 자체는 이 목록에 넣지 않는다. 플러그인으로 제공할 앱 기능은 포함한다.
- 각 미완료 항목은 공개 입력과 결과, 초기값, 권한, 오류, 이벤트와 자원 정리를 정하고,
  대상 Windows에서 실제 동작을 검증한 뒤 체크한다. 설정 지원만으로 런타임 API도 완료 처리하지 않는다.
- GitHub Issues가 개별 작업과 상세 명세의 원본이다. 이 문서는 전체 기능 목록이며,
  이슈를 만들면 해당 체크 항목에 링크를 추가한다.

개발 순서는 [Windows 우선 ADR](./decisions/0010-windows-first-platform-model.md)을 따른다.
현재 구현 근거는 [Windows 실행 기록](./architecture/windows-bun-results.md),
[플랫폼 지원 표](./platform-support/README.md), [창 API](./site/src/content/docs/reference/host/windows.mdx),
[데스크톱 수명주기 ADR](./decisions/0013-desktop-lifecycle.md)에서 확인한다.
자동 업데이트와 Chromium 렌더러 등의 후속 항목은 [PRD](./PRD.md)의 첫 릴리스 범위를
즉시 확대하는 결정이 아니다. 구현 순서와 지원 여부를 해당 작업에서 결정한다.

## 01. 창 생성과 기본 수명주기

우선순위 P1. 소유자: 호스트와 창 API. 출처: [T-window], [T-webview], [E-window], [E-app].

- [x] `app.windows`로 여러 창을 선언하고 시작 창을 생성한다.
- [x] `startup: false`인 사전 선언 창을 API로 생성한다.
- [x] 닫은 보조 창을 다시 생성하고 열린 창을 재생성한다.
- [x] 허용된 창의 목록과 열림 여부를 조회한다.
- [x] 창 show, hide, focus, close를 제공한다.
- [x] 창 재생성에서 이전 세션을 정리하고 새 세션을 만든다.
- [x] 창별 권한, WebView 프로필과 렌더러 복구를 분리한다.
- [ ] 창 ID로 조회하고 현재 창, 포커스된 창과 마지막 활성 창을 조회한다.
- [ ] 창 생성, 웹 문서 준비, SDK 준비를 구분한 완료 이벤트를 제공한다.
- [ ] 숨긴 상태로 창을 생성하고 준비된 뒤 표시하는 옵션을 제공한다.
- [ ] 포커스를 가져오지 않고 창을 표시하는 `showInactive`를 제공한다.
- [ ] blur와 활성 창 전환 API를 제공한다.
- [ ] 창의 visible, focused, destroyed, normal 상태를 조회한다.
- [ ] 일반 close와 확인을 우회하는 trusted destroy의 계약을 구분한다.
- [ ] 실행 중 창 생성 옵션을 지정하는 기능의 지원 범위와 권한을 결정한다. 현재는 사전 선언만 지원한다.
- [ ] 하나의 뷰에서 여러 창을 만드는 기능과 식별자, 정책의 관계를 결정한다. 현재는 뷰별 창 하나다.
- [ ] 부모 창, 자식 창, owner 관계를 설정하고 조회한다.
- [ ] 부모에 종속된 모달 창과 부모의 입력 차단, 종료 순서를 제공한다.
- [ ] 창 enabled 상태의 변경과 조회를 제공한다.
- [ ] 창이 없는 상주 앱과 트레이만 있는 앱의 시작을 지원한다. 현재 설정은 시작 창 하나 이상을 요구한다.
- [ ] splashscreen을 앱 준비 후 닫고 주 창으로 전환하는 흐름을 제공한다.

## 02. 창 크기와 위치, 최소 크기와 최대 크기 제약

우선순위 P1. 소유자: 호스트와 창 API. 출처: [T-window], [T-config], [E-window], [E-window-options].

현재 `width`, `height`의 200–4096 입력 검사는 앱별 최소와 최대 창 크기 기능이 아니다.
운영체제에서 사용자가 드래그할 때 적용할 제약과 공개 변경 API가 별도로 필요하다.

- [x] 내용 영역의 크기와 창 바깥쪽 위치를 실행 중 변경한다.
- [ ] 초기 설정에 `minWidth`와 `minHeight`를 추가한다.
- [ ] 초기 설정에 `maxWidth`와 `maxHeight`를 추가한다.
- [ ] 실행 중 최소 크기를 변경하고 조회하는 API를 제공한다.
- [ ] 실행 중 최대 크기를 변경하고 조회하는 API를 제공한다.
- [ ] `setSizeConstraints`로 최소 크기와 최대 크기 제약을 함께 변경한다.
- [ ] 제약 해제, 한 축만 제한, 기본값과 min > max 입력 오류를 정의한다.
- [ ] 초기 크기와 `setSize`가 제약을 벗어날 때 거부 또는 보정 규칙을 정의한다.
- [ ] Windows의 사용자 크기 조절, 최대화, 복원에도 최소 크기와 최대 크기 제약을 적용한다.
- [ ] DPI 변경, 모니터 이동과 전체화면 해제 뒤에도 크기 제약을 유지한다.
- [ ] content와 outer 크기, 위치, bounds를 구분해 조회하고 설정한다.
- [ ] 최대화 전 normal bounds를 조회한다.
- [ ] logical와 physical 좌표 및 크기의 변환을 제공한다.
- [ ] 초기 x, y, center와 content-size 기준 옵션을 지원한다.
- [ ] 실행 중 창을 현재 또는 지정 모니터의 작업 영역 중앙에 배치한다.
- [ ] 초기 창 위치와 크기가 작업 영역을 넘지 않게 하는 prevent-overflow 옵션을 제공한다.
- [ ] 고정 aspect ratio와 해제 API를 제공한다.
- [ ] resizable과 movable을 설정하고 조회한다.
- [ ] 설정과 런타임 크기 제한을 실제 모니터, DPI에 맞게 재검토한다. 현재의 4096 상한을 유지할지 결정한다.
- [ ] 위치와 크기의 선택적 애니메이션을 지원하거나 플랫폼별 미지원으로 명시한다.

## 03. 창 상태, 외관과 사용자 타이틀바

우선순위 P1, 효과와 특수 창은 P2. 소유자: 호스트와 창 API. 출처: [T-window], [E-window], [E-window-options].

- [x] 현재 모니터의 전체화면과 이전 표시 상태, 위치 복원을 제공한다.
- [ ] minimize, maximize, unmaximize, restore와 toggleMaximize API를 제공한다.
- [ ] 최소화, 최대화, 전체화면 상태를 조회한다.
- [ ] 초기 maximized와 fullscreen 옵션을 지원한다.
- [ ] minimizable, maximizable, closable, fullscreenable을 설정하고 조회한다.
- [ ] 초기 및 실행 중 focusable을 설정하고 조회한다.
- [ ] 창 title과 icon을 실행 중 변경하고 조회한다.
- [ ] decorations와 frame의 초기 설정, 변경과 조회를 제공한다.
- [ ] 사용자 타이틀바의 drag 영역, no-drag 영역과 resize 영역을 제공한다.
- [ ] 프로그램에서 창 이동과 방향별 크기 조절을 시작한다.
- [ ] 네이티브 제목 표시줄 버튼을 유지하는 title-bar overlay를 제공한다.
- [ ] alwaysOnTop의 설정과 조회를 제공한다.
- [ ] alwaysOnBottom 및 창 Z 순서 이동의 지원 범위를 결정한다.
- [ ] skipTaskbar의 설정과 조회를 제공한다.
- [ ] 키오스크 모드와 일반 전체화면의 차이를 정의한다.
- [ ] 창 background color, 투명 배경과 opacity를 제공한다.
- [ ] shadow의 설정과 조회를 제공한다.
- [ ] Windows Mica, Acrylic와 배경 material, accent color를 제공한다.
- [ ] 모서리와 창 shape의 지원을 결정한다. Electron shape는 실험 기능이다.
- [ ] roundedCorners와 corner-smoothing CSS를 지원하거나 렌더러별 차이를 명시한다.
- [ ] Windows thickFrame과 noRedirectionBitmap 같은 생성 옵션의 필요성과 지원 범위를 결정한다.
- [ ] 스크린샷과 화면 공유에서 창을 제외하는 content protection을 제공한다.
- [ ] mouse click-through와 이동 이벤트 전달 여부를 제공한다.
- [ ] cursor icon, visible, position과 grab의 지원 범위를 제공한다.
- [ ] 창 포커스 요청과 별개로 작업 표시줄을 점멸하는 attention API를 제공한다.
- [ ] 지정 모니터에서 전체화면으로 전환하고 모니터 제거 시 복원한다.
- [ ] Windows snapped와 tablet-mode 상태 조회의 지원을 결정한다.
- [ ] 접근성용 창 제목을 일반 제목과 별도로 설정한다.
- [ ] 신뢰된 네이티브 어댑터에 HWND와 native WebView 접근을 제공하는 범위를 정한다.
- [ ] Windows message hook의 등록, 조회, 개별 해제와 전체 해제를 제공한다.

## 04. 창 이벤트와 상태 저장

우선순위 P1. 소유자: 창 이벤트는 호스트, 영속 저장은 선택 기능. 출처: [T-window], [E-window], [T-window-state], [T-positioner].

- [x] 닫기 확인 메시지의 승인과 거절을 처리한다.
- [ ] created, ready, shown, hidden, closed, destroyed 이벤트를 제공한다.
- [ ] focus와 blur 이벤트를 제공한다.
- [ ] move, moved, resize와 resized 이벤트 및 현재 bounds를 제공한다.
- [ ] will-move와 will-resize의 취소 가능 여부를 정의한다.
- [ ] minimize, maximize, unmaximize와 restore 이벤트를 제공한다.
- [ ] 전체화면 진입과 해제, always-on-top 변경 이벤트를 제공한다.
- [ ] close-requested 이벤트와 비동기 저장 후 닫기 승인 흐름을 제공한다. 현재 확인 메시지는 비동기 저장 훅이 아니다.
- [ ] DPI, theme 변경 이벤트를 제공한다.
- [ ] Windows shutdown, logoff의 query-session-end와 session-end를 처리한다.
- [ ] app-command와 system-context-menu 이벤트를 제공한다.
- [ ] 창 이벤트 구독 해제, 재생성 후 새 구독, 종료 시 정리를 보장한다.
- [ ] 크기, 위치, 최대화, 전체화면과 표시 상태의 저장 항목을 선택한다.
- [ ] 앱 재실행 시 창 상태를 복원하고 상태를 삭제하는 API를 제공한다.
- [ ] 저장했던 모니터가 사라진 경우 보이는 작업 영역으로 창을 복원한다.
- [ ] 모니터 모서리와 중앙, 트레이 아이콘 근처로 창을 배치하는 positioner를 제공한다.

## 05. 앱 수명주기와 실행 정보

우선순위 P1. 소유자: 호스트와 desktop API. 출처: [T-app], [E-app], [T-single-instance], [T-process].

- [x] 단일 인스턴스에 두 번째 실행의 argv와 cwd를 전달한다.
- [x] 초기 실행과 두 번째 실행의 파일, URL 입력을 `onOpen`으로 전달한다.
- [x] `beforeQuit`에서 종료를 취소하고 기존 세션을 유지한다.
- [x] 트레이 숨김과 복원, 마지막 창 닫기와 앱 종료를 구분한다.
- [x] 개발 CLI 중단과 재시작은 사용자 종료 취소를 우회하고 자원을 정리한다.
- [x] 정상 종료와 강제 종료에서 관리하는 하위 프로세스를 정리한다.
- [ ] 앱 ready, before-quit, will-quit, quit과 모든 창 닫힘의 공개 이벤트를 정의한다.
- [ ] 종료 코드 지정, 강제 exit, relaunch와 인자 보존 API를 제공한다.
- [ ] 앱 이름, 버전, 식별자, 프레임워크와 Bun, WebView 버전을 조회한다.
- [ ] 앱 패키지 경로, 실행 파일, 리소스 경로와 packaged/dev 상태를 조회한다.
- [ ] 앱 전체 포커스, 활성 상태와 창 생성 이벤트를 제공한다.
- [ ] 단일 인스턴스의 추가 데이터 전달과 lock 상태 조회, 해제 필요성을 결정한다.
- [ ] 앱 ready 전에 들어온 외부 활성화 요청과 종료 요청의 순서를 공개 계약으로 정한다.
- [ ] 렌더러와 관리 프로세스의 비정상 종료 이벤트를 앱에 제공한다.
- [ ] 앱 About 패널과 이름, 버전, 저작권, 라이선스 정보를 제공한다.
- [ ] 환경변수와 실행 인자의 설정, 개발 옵션과 배포 옵션의 적용 범위를 정의한다.
- [ ] command-line switch와 argument의 추가, 조회, 존재 확인과 제거에 대응하는 설정 API를 제공한다.
- [ ] 앱 이름과 데이터 경로의 사용자 지정, 기본 file icon과 bundle type 조회를 제공한다.

## 06. 트레이

우선순위 P1. 소유자: 선택 데스크톱 기능, 앱 실행 유지와 종료는 호스트.
출처: [T-tray], [E-tray]. Tauri는 별도 설치 플러그인이 아닌 기본 패키지의 내장 tray 플러그인을 사용한다.

- [x] tooltip, 앱 아이콘과 Open/Quit 메뉴로 트레이를 생성한다. 앱 아이콘을 지정하지 않으면 기본 아이콘을 사용한다.
- [x] 트레이 클릭으로 살아 있는 창을 복원하고 Quit에 앱 종료 확인을 적용한다.
- [x] Explorer 재시작 후 트레이 아이콘을 다시 등록한다.
- [ ] 앱 아이콘과 별도로 트레이용 ICO, PNG 또는 이미지 리소스를 지정한다.
- [ ] 아이콘과 tooltip을 실행 중 변경한다.
- [ ] 트레이 생성, 조회, 표시, 숨김, 제거와 제거 여부 조회 API를 제공한다.
- [ ] 여러 트레이 아이콘과 고유 ID, Windows GUID를 지원한다.
- [ ] 사용자 정의 메뉴와 메뉴의 동적 교체, 제거를 지원한다.
- [ ] 클릭, 더블 클릭, 우클릭, 가운데 클릭과 버튼 상태를 앱 이벤트로 전달한다.
- [ ] 포인터 위치와 트레이 bounds, mouse enter/leave/move를 제공한다.
- [ ] 클릭에 따른 메뉴 표시 여부와 창 복원 동작을 설정한다.
- [ ] 지정 위치의 팝업 메뉴 열기, 닫기와 트레이 포커스를 제공한다.
- [ ] Windows balloon 표시, 제거와 show/click/closed 이벤트의 지원을 결정한다.
- [ ] 트레이 자원 제거 뒤 숨긴 앱의 실행 유지와 종료 규칙을 정의한다.

## 07. 메뉴와 키보드 단축키

우선순위 P1. 소유자: 메뉴는 선택 데스크톱 API, 전역 단축키는 공식 플러그인 후보.
출처: [T-menu], [E-menu], [E-menu-item], [E-shortcut], [T-global-shortcut].

- [ ] 앱 메뉴바와 창별 메뉴를 생성, 교체, 조회하고 제거한다.
- [ ] 메뉴바 visible과 auto-hide를 설정하고 조회한다.
- [ ] 지정 창과 위치에 컨텍스트 메뉴를 표시하고 닫는다.
- [ ] 일반, separator, checkbox, radio, icon과 submenu 항목을 제공한다.
- [ ] 메뉴 ID 조회, append, prepend, insert, remove와 목록 조회를 제공한다.
- [ ] 항목 label, enabled, visible, checked와 icon을 실행 중 변경한다.
- [ ] 메뉴 click 이벤트와 소유 창 정보를 전달한다.
- [ ] accelerator, 표시 문자열과 실제 등록 여부를 구분한다.
- [ ] Undo, Redo, Cut, Copy, Paste, Select All 등 기본 menu role을 제공한다.
- [ ] About, Quit, 창 전환과 도움말 등 플랫폼 기본 메뉴 항목을 제공한다.
- [ ] 메뉴 sublabel과 접근성 label의 플랫폼별 지원을 결정한다.
- [ ] 전역 단축키를 하나 또는 여러 개 등록한다.
- [ ] 전역 단축키의 등록 상태 조회, 개별 해제와 전체 해제를 제공한다.
- [ ] 전역 단축키의 pressed/released 이벤트와 키 조합을 제공한다.
- [ ] 단축키 충돌, 예약 키, 중복 등록과 종료 정리를 처리한다.
- [ ] WebView 포커스 시 메뉴 단축키와 UI 입력의 우선순위를 정의한다.

## 08. 로그인 시 자동 실행

우선순위 P1. 소유자: 공식 autostart 플러그인 후보. 출처: [T-autostart], [E-app].

- [ ] 로그인 시 실행을 등록하고 해제한다.
- [ ] 등록 여부와 실제 실행 경로, 인자 상태를 조회한다.
- [ ] 로그인 시작에 전달할 인자와 숨김 시작 옵션을 지원한다.
- [ ] 수동 실행과 로그인 실행을 앱에서 구분한다.
- [ ] 사용자 범위 등록을 기본으로 하고 관리자 범위 지원 여부를 결정한다.
- [ ] 앱 이동, 업데이트와 제거 후 오래된 등록을 갱신하거나 정리한다.
- [ ] Windows 작업 관리자에서 사용자가 비활성화한 상태를 반영한다.
- [ ] 설치 프로그램의 opt-in 설정과 런타임 설정을 연결한다.

## 09. OS 셸, 파일 연결과 작업 표시줄

우선순위 P1, 작업 표시줄 고급 기능은 P2. 소유자: opener/deep-link 플러그인과 패키저, 창 연동은 호스트.
출처: [E-shell], [E-app], [E-window], [T-opener], [T-deep-link].

- [ ] 기본 브라우저에서 URL을 연다.
- [ ] 기본 앱 또는 지정 앱으로 파일과 URL을 연다.
- [ ] Explorer에서 파일을 선택해 표시한다.
- [ ] 파일을 휴지통으로 보내고 실패를 반환한다.
- [ ] Windows 바로가기 생성, 읽기와 변경을 제공한다.
- [ ] OS beep와 이모지 패널의 지원을 결정한다.
- [ ] URL scheme을 등록, 해제하고 기본 처리 앱 여부를 조회한다.
- [ ] 파일 확장자, MIME, 표시 이름과 파일 아이콘을 설치에 등록한다.
- [ ] 설치와 제거에서 연결을 정리하고 기존 기본 앱 설정을 존중한다.
- [ ] URL의 연결 앱 이름과 실행 정보를 조회한다.
- [ ] AppUserModelID와 toast activation 식별자를 설정하고 설치와 일치시킨다.
- [ ] Recent Documents의 추가, 조회와 삭제를 제공한다.
- [ ] Jump List와 사용자 task, category, 제거된 항목 조회를 제공한다.
- [ ] 작업 표시줄 progress와 상태를 설정한다.
- [ ] overlay icon과 접근성 설명을 설정한다.
- [ ] thumbnail toolbar 버튼과 클릭 이벤트를 제공한다.
- [ ] thumbnail clip과 tooltip을 설정한다.
- [ ] 창별 앱 표시 이름, relaunch 명령과 아이콘을 설정한다.
- [ ] Windows elevation과 de-elevation 실행 요구사항의 지원 범위를 결정한다.

## 10. 알림

우선순위 P1. 소유자: 공식 notification 플러그인 후보, 외부 활성화 전달은 호스트.
출처: [E-notification], [T-notification].

- [ ] OS 알림 지원 여부와 필요한 OS 권한 상태를 조회하고 요청한다.
- [ ] 제목, 본문, 아이콘, 이미지와 소리를 지정해 알림을 표시한다.
- [ ] show, click, close와 failed 이벤트를 제공한다.
- [ ] 알림 ID, 그룹과 취소, 교체 동작을 정의한다.
- [ ] 액션 버튼과 인라인 응답 입력을 제공한다.
- [ ] 앱이 종료된 상태의 toast activation을 앱 시작과 `onOpen`에 연결한다.
- [ ] silent, timeout과 표시 우선순위의 플랫폼별 동작을 정의한다.
- [ ] Windows toast XML과 고급 알림 콘텐츠의 지원을 결정한다.
- [ ] OS에 남은 알림 조회와 개별, 그룹, 전체 제거의 플랫폼별 지원을 결정한다.
- [ ] 예약 알림과 pending 조회, 취소의 플랫폼별 지원을 제공한다.
- [ ] 첨부 파일과 클릭 액션 종류를 등록한다.
- [ ] OS 알림 설정으로 이동하는 흐름과 사용자에 의한 차단 상태를 제공한다.

## 11. 대화상자와 파일 선택

우선순위 P1. 소유자: 공식 dialog 플러그인 후보. 출처: [E-dialog], [T-dialog].

- [ ] 메시지, 확인, 오류와 사용자 버튼 대화상자를 제공한다.
- [ ] 버튼 결과, 기본 버튼, cancel 버튼과 ESC 동작을 정의한다.
- [ ] 상세 메시지와 checkbox 결과를 제공한다.
- [ ] 파일 열기와 저장 대화상자를 제공한다.
- [ ] 폴더 선택, 다중 파일과 폴더 선택을 제공한다.
- [ ] 파일 형식 필터, 기본 경로와 파일 이름, 기본 확장자를 제공한다.
- [ ] 숨긴 파일, 새 폴더 생성, overwrite 확인 등 옵션을 제공한다.
- [ ] 부모 창을 지정해 모달 대화상자를 연결한다.
- [ ] 선택 취소, 호출 취소와 부모 창 종료의 결과를 정의한다.
- [ ] 선택한 파일 접근 권한의 수명과 영속화 여부를 정의한다.
- [ ] 인증서 신뢰 확인 대화상자의 지원 범위를 결정한다.
- [ ] 동기 대화상자는 동일 기능의 비동기 API로 대체할지 결정한다. 앱 백엔드 진행을 막지 않는다.

## 12. 클립보드와 이미지 리소스

우선순위 P1. 소유자: clipboard 플러그인과 공통 이미지 리소스 API 후보.
출처: [E-clipboard], [E-image], [T-clipboard], [T-image].

- [ ] 클립보드 텍스트 읽기, 쓰기와 지우기를 제공한다.
- [ ] 이미지 읽기와 쓰기를 제공한다.
- [ ] HTML, RTF, 파일 목록과 bookmark 형식의 지원을 제공한다.
- [ ] 사용 가능한 MIME 형식과 지정 형식 존재 여부를 조회한다.
- [ ] 여러 형식을 한 번에 읽고 쓰는 API를 제공한다.
- [ ] 사용자 정의 binary 형식을 읽고 쓰는 범위와 제한을 정의한다.
- [ ] 클립보드 변경 이벤트의 지원을 결정한다.
- [ ] 파일, bytes, bitmap, RGBA와 data URL에서 이미지 리소스를 만든다.
- [ ] 이미지 크기, 빈 이미지 여부와 픽셀 데이터를 조회한다.
- [ ] PNG, JPEG, bitmap과 data URL로 이미지를 내보낸다.
- [ ] crop, resize와 scale-factor별 이미지 representation을 제공한다.
- [ ] 파일 아이콘과 이미지 thumbnail을 생성한다.
- [ ] 이미지 리소스 ID와 명시적 해제, 호출 취소와 앱 종료 정리를 제공한다.

## 13. 모니터, 테마, 접근성과 전원

우선순위 P1, 전원 고급 기능은 P2. 소유자: 창에 연결된 기능은 호스트, 독립 OS 기능은 플러그인 후보.
출처: [T-window], [E-screen], [E-theme], [E-system], [E-power], [E-power-blocker].

- [ ] 전체, 주, 현재 모니터를 조회한다.
- [ ] 점과 사각형에 가장 가까운 모니터를 조회한다.
- [ ] 모니터 이름, bounds, work area, 배율, rotation과 refresh rate를 조회한다.
- [ ] 모니터 추가, 제거와 display metrics 변경 이벤트를 제공한다.
- [ ] 커서의 화면 좌표와 physical/logical 좌표 변환을 제공한다.
- [ ] system/light/dark 테마를 앱과 창에 지정하고 조회한다.
- [ ] 테마, accent color와 시스템 색 변경을 알린다.
- [ ] 고대비, forced colors, inverted colors 상태를 조회한다.
- [ ] reduced motion과 transparency 등 접근성 환경설정을 조회한다.
- [ ] 스크린 리더와 접근성 활성 상태, 변경 이벤트를 제공한다.
- [ ] WebView 접근성 트리와 사용자 타이틀바의 키보드 탐색을 검증한다.
- [ ] suspend, resume, 화면 잠금과 잠금 해제 이벤트를 제공한다.
- [ ] AC와 배터리 상태 조회, 변경 이벤트를 제공한다.
- [ ] idle 상태와 idle 시간을 조회한다.
- [ ] 시스템 절전과 화면 꺼짐을 방지하는 blocker를 시작, 조회하고 해제한다.
- [ ] blocker의 중복 요청과 앱 종료 자동 정리를 처리한다.
- [ ] CPU speed-limit, thermal-state와 종료 이벤트의 플랫폼별 지원을 정의한다.

## 14. WebView 생성, 배치와 기본 제어

우선순위 P2. 소유자: 호스트와 렌더러 API. 출처: [T-webview], [T-webview-rust], [E-contents], [E-view].

- [x] 로컬 앱 자산과 개발 서버를 WebView에 연결한다.
- [x] 허용 origin을 검사하고 탐색 시 기존 세션을 폐기한다.
- [x] 뷰별 영속 프로필과 렌더러 복구를 제공한다.
- [ ] WebView ID 조회, 현재와 포커스된 WebView, 전체 목록을 제공한다.
- [ ] 하나의 창에 여러 WebView를 생성하고 별도 bounds, 표시와 포커스를 제어한다.
- [ ] 창 크기 변경에 따른 auto-resize와 콘텐츠 크기 기반 배치를 제공한다.
- [ ] WebView를 다른 창으로 reparent하는 기능과 새 세션 규칙을 정의한다.
- [ ] WebView만 닫고 재생성하는 공개 API를 제공한다.
- [ ] URL과 로컬 파일 로드, reload, cache를 무시한 reload와 stop을 제공한다.
- [ ] 현재 URL, title, loading, destroyed와 focus 상태를 조회한다.
- [ ] 탐색 전 허용와 거부, redirect와 popup 새 창 처리 훅을 제공한다.
- [ ] 로드 시작, DOM ready, 완료와 실패 이벤트를 제공한다.
- [ ] 문서, 프레임과 same-document 탐색 이벤트를 제공한다.
- [ ] title, favicon과 preferred-size 변경 이벤트를 제공한다.
- [ ] renderer gone, unresponsive와 responsive 이벤트를 제공한다.
- [ ] console 메시지, 스크립트 초기화 실패와 context-menu 이벤트를 제공한다.
- [ ] WebView 배경색, 투명 배경과 scrollbar 옵션을 제공한다.
- [ ] 처음 숨긴 WebView의 paint, visibility와 ready-to-show 관계를 정의한다.
- [ ] user agent, accept languages, proxy와 incognito 옵션을 제공한다.
- [ ] 프로필 디렉터리와 데이터 저장소 선택, 조회와 삭제를 제공한다.
- [ ] JavaScript, 이미지, WebGL, autoplay와 background throttling 설정을 제공한다.
- [ ] 기본 글꼴, 글꼴 크기, encoding과 이미지 animation 정책의 지원을 결정한다.
- [ ] textarea resize, preferred-size와 focus-on-navigation 옵션의 지원을 결정한다.
- [ ] zoom을 origin별로 공유할지 WebView별로 독립 관리할지 설정한다.
- [ ] 브라우저 기본 대화상자, context menu와 zoom hotkey 설정을 제공한다.
- [ ] autofill, password autosave와 HTTP authentication의 명시적 설정을 제공한다.
- [ ] HTML 전체화면과 네이티브 창 전체화면의 연동 및 이벤트를 제공한다.

## 15. WebView 탐색, 편집, 스크립트와 입력

우선순위 P2. 소유자: 렌더러 API. 출처: [E-contents], [E-history], [E-frame], [E-frame-main], [T-webview-rust].

- [ ] 뒤로, 앞으로, offset과 index 이동 및 가능 여부 조회를 제공한다.
- [ ] 탐색 history의 조회, 삭제, 전체 초기화와 복원을 제공한다.
- [ ] zoom factor, level과 visual zoom 최소와 최대 한도를 설정하고 조회한다.
- [ ] 페이지 find, 결과 이벤트와 검색 종료를 제공한다.
- [ ] undo, redo, cut, copy, paste, plain-text paste와 select-all을 제공한다.
- [ ] selection 변경, 텍스트 삽입과 교체, scroll-to-top/bottom을 제공한다.
- [ ] 맞춤법 검사 활성화, 언어, dictionary와 사용자 단어를 관리한다.
- [ ] misspelling 조회, suggestion과 교체 API를 제공한다.
- [ ] 신뢰된 앱 백엔드의 JavaScript 실행과 결과 반환 계약을 제공한다.
- [ ] 문서 초기화 script와 CSS 삽입, 제거를 제공한다.
- [ ] isolated world와 preload의 사용 범위, frame별 적용과 자원 정리를 정의한다.
- [ ] WebView에서 Node/Bun을 직접 사용하는 Electron nodeIntegration 옵션의 대체 또는 미지원 결정을 기록한다.
- [ ] frame tree, frame URL과 origin 조회, frame별 작업의 지원 범위를 정의한다.
- [ ] 키보드, 마우스와 wheel의 before-input 이벤트와 취소를 제공한다.
- [ ] 입력 이벤트 주입, cursor 변경과 IME composition의 지원을 결정한다.
- [ ] 파일 drop의 enter, over, leave와 drop 이벤트, 경로와 좌표를 제공한다.
- [ ] WebView의 File 객체와 OS 파일 경로를 안전하게 연결한다.
- [ ] 파일을 앱 밖으로 드래그하고 표시할 drag 이미지를 제공한다.
- [ ] audio muted와 audible 상태를 변경, 조회하고 이벤트를 제공한다.
- [ ] caret browsing 활성화, selection 가운데 표시와 image-at-point 복사를 제공한다.
- [ ] media 시작과 중단, HTML theme-color와 링크 hover URL 이벤트를 제공한다.

## 16. WebView 세션, 네트워크와 프로토콜

우선순위 P2. 소유자: 세션과 렌더러 API. 출처: [E-session], [E-cookies], [E-request], [E-protocol], [E-net], [T-webview-rust].

- [ ] cookies 조회, 설정, 삭제, 변경 이벤트와 flush를 제공한다.
- [ ] cache 크기 조회, cache와 localStorage, IndexedDB, service worker 데이터 삭제를 제공한다.
- [ ] 저장소 종류, origin과 기간별 데이터 삭제를 제공한다.
- [ ] 인증 cache, DNS cache와 code cache의 조회 또는 삭제를 제공한다.
- [ ] 세션의 persistent 여부와 storage path를 조회한다.
- [ ] 세션별 proxy 설정, 조회, 재적용과 모든 연결 종료를 제공한다.
- [ ] HTTP 요청 전 취소, redirect와 URL filter를 제공한다.
- [ ] 요청과 응답 header 조회, 변경 및 response stream 처리의 지원을 결정한다.
- [ ] 요청 완료, 실패와 redirect 이벤트를 제공한다.
- [ ] authentication과 client certificate 선택을 처리한다.
- [ ] certificate 검증 오류, 사용자 trust 판단과 SSL 설정의 지원 범위를 정의한다.
- [ ] OS proxy, DNS, NTLM과 integrated authentication을 사용하는 네트워크 경로를 제공한다.
- [ ] online 상태와 변경 이벤트, host와 proxy resolve를 제공한다.
- [ ] 오프라인, latency와 bandwidth emulation을 제공한다.
- [ ] preconnect, connection 정리와 network log를 제공한다.
- [ ] 사용자 정의 앱 protocol의 등록, 해제와 등록 상태 조회를 제공한다.
- [ ] protocol 응답에 파일, bytes, text, HTTP와 stream을 사용한다.
- [ ] protocol의 MIME, range, CORS, secure origin과 서비스 워커 지원을 정의한다.
- [ ] protocol과 세션별 정책을 연결하고 origin 검사와 세션 폐기 계약을 유지한다.
- [ ] 세션에 preload 등록, 조회와 해제를 제공한다.
- [ ] service worker 등록, 실행 상태와 console 이벤트를 제공한다.
- [ ] service worker와 shared worker 조회, 시작과 IPC의 지원 범위를 결정한다.
- [ ] 브라우저 extension 설치, 조회, 제거와 이벤트의 지원을 결정한다.
- [ ] extension이 사용할 수 있는 Chrome API subset을 명시한다.
- [ ] shared dictionary와 압축 dictionary cache 관리의 지원을 결정한다.

## 17. WebView 권한과 장치

우선순위 P2. 소유자: 호스트 권한 중재와 기능별 어댑터. 출처: [E-session], [E-system], [E-contents], [T-webview-rust].

현재 WebView OS 권한 요청은 일괄 거부한다. 지원 기능, 앱 정책과 사용자의 OS 동의를
구분하는 요청와 조회 흐름을 추가해야 한다.

- [ ] 권한 check와 request 훅, origin과 frame별 허용와 거부를 제공한다.
- [ ] 권한 결정의 영속화, 조회와 초기화를 제공한다.
- [ ] 카메라와 마이크의 OS 권한 확인 및 요청을 연결한다.
- [ ] geolocation, notification과 clipboard 권한을 연결한다.
- [ ] display capture, fullscreen, pointer lock과 wake lock 권한을 연결한다.
- [ ] file system access와 파일 선택 범위를 연결한다.
- [ ] Bluetooth 장치 선택과 pairing 이벤트를 제공한다.
- [ ] USB 장치 선택, 추가, 제거와 권한 revoke 이벤트를 제공한다.
- [ ] Serial port 선택, 추가, 제거와 권한 revoke 이벤트를 제공한다.
- [ ] HID 장치 선택, 추가, 제거와 권한 revoke 이벤트를 제공한다.
- [ ] MIDI, sensors와 protected media 권한의 지원 범위를 결정한다.
- [ ] WebAuthn authenticator와 account 선택의 지원 범위를 결정한다.
- [ ] WebView2가 제공하지 않는 장치 API는 선택 렌더러 필요 여부 또는 `UNSUPPORTED`를 명시한다.
- [ ] WebRTC IP handling policy와 UDP port range 설정의 지원을 결정한다.

## 18. 다운로드, 인쇄와 캡처

우선순위 P2. 소유자: WebView 연동은 렌더러 API, 독립 전송과 캡처는 플러그인 후보.
출처: [E-download], [E-contents], [E-capture], [T-webview-rust], [T-upload].

- [ ] WebView 다운로드의 시작 승인, 거부와 저장 경로 선택을 제공한다.
- [ ] 다운로드 URL, redirect chain, filename, MIME과 initiator를 조회한다.
- [ ] total/received bytes, 속도, 진행률과 완료와 실패 이벤트를 제공한다.
- [ ] pause, resume, cancel과 재개 가능 여부를 제공한다.
- [ ] 중단 다운로드의 metadata 저장과 재개를 제공한다.
- [ ] 파일 업로드와 다운로드에 progress, 취소, timeout을 제공한다.
- [ ] 프린터 목록과 기본 프린터를 조회한다.
- [ ] 인쇄 대화상자, silent print와 인쇄 옵션을 제공한다.
- [ ] PDF 내보내기와 용지, 방향, 여백, 페이지 범위, 배경 옵션을 제공한다.
- [ ] 페이지 이미지 capture와 지정 영역 capture를 제공한다.
- [ ] 페이지를 HTML 또는 리소스를 포함한 형태로 저장한다.
- [ ] 화면과 창 capture source 목록, 이름, thumbnail과 식별자를 제공한다.
- [ ] 사용자의 source 선택과 getDisplayMedia 흐름을 연결한다.
- [ ] 화면 공유, 화면과 시스템 audio capture의 플랫폼별 지원을 정의한다.
- [ ] frame별 PDF, 비디오 frame 이미지 복사와 저장의 지원을 결정한다.

## 19. 파일 시스템, 경로와 데이터 저장

우선순위 P1, 데이터베이스와 확장은 P2. 소유자: 공식 기능 플러그인.
출처: [T-fs], [T-path], [T-store], [T-sql], [T-persisted-scope], [E-app].

- [x] appData/temp 범위의 UTF-8 텍스트 읽기와 쓰기를 제공한다.
- [x] 저장 경계에서 경로 탈출, junction, hardlink와 대상 교체를 거부한다.
- [ ] binary 읽기와 쓰기, append와 open/read/write/seek/close 핸들을 제공한다.
- [ ] 파일과 디렉터리 존재, stat, metadata와 권한을 조회한다.
- [ ] 디렉터리 목록, 재귀 목록과 생성, 삭제를 제공한다.
- [ ] 파일과 디렉터리 copy, rename, move, truncate를 제공한다.
- [ ] 파일 watch와 recursive watch, 이벤트 구독 해제를 제공한다.
- [ ] 원자적 저장, 충돌 처리와 대용량 stream I/O를 제공한다.
- [ ] 파일 대화상자로 획득한 범위의 일시 허용과 영속화를 제공한다.
- [ ] home, documents, downloads, desktop, pictures, music과 video 경로를 제공한다.
- [ ] appConfig, appData, appLocalData, cache, logs, temp와 resource 경로를 제공한다.
- [ ] path join, resolve, normalize, basename, dirname, extname과 isAbsolute를 제공한다.
- [ ] Windows drive, UNC, extended-length와 Unicode 경로 동작을 정의한다.
- [ ] key-value store의 load, get, set, delete, clear와 목록 조회를 제공한다.
- [ ] store 변경 이벤트, save, reload와 autosave를 제공한다.
- [ ] SQLite의 query, execute, transaction과 migration을 제공한다.
- [ ] Tauri SQL의 다른 backend와 원격 DB 지원 필요성을 결정한다.
- [ ] Bun 파일, path와 SQLite API를 직접 사용하는 trusted backend 경로와 권한 중재 API를 구분해 문서화한다.

## 20. OS 정보, HTTP, WebSocket와 프로세스

우선순위 P2. 소유자: 선택 기능 플러그인, 기본 실행 능력은 번들 Bun.
출처: [T-os], [T-http], [T-websocket], [T-shell], [T-process], [T-cli], [T-localhost], [E-net], [E-utility].

Bun의 trusted backend는 이미 기본 fetch, WebSocket, 파일 I/O와 프로세스 API를 사용할 수 있다.
아래는 이를 없던 기능으로 다시 구현하는 작업이 아니라 정책을 적용한 공개 기능과 OS 연동의 작업이다.

- [ ] OS 종류, 버전, architecture, hostname과 실행 환경 정보를 제공한다.
- [ ] locale, country code, preferred languages와 OS 언어를 조회한다.
- [ ] CPU, 메모리와 프로세스 사용량, PID와 translation 상태 조회를 제공한다.
- [ ] origin과 URL scope를 적용한 HTTP 요청과 응답을 제공한다.
- [ ] HTTP header, body, redirect, proxy와 OS 인증의 지원 범위를 정의한다.
- [ ] HTTP stream, timeout, 취소와 progress를 제공한다.
- [ ] WebSocket 연결, 메시지, close, 상태와 backpressure를 공개 계약으로 제공한다.
- [ ] 허용된 실행 파일과 인자 scope로 command 실행을 제공한다.
- [ ] shell 문자열 실행과 argv 실행을 구분한다.
- [ ] spawn, stdout/stderr, stdin, exit code와 signal을 제공한다.
- [ ] process kill, timeout과 앱 종료 시 process tree 정리를 연결한다.
- [ ] 번들 sidecar의 플랫폼 선택, 실행 경로, 라이선스와 패키징을 제공한다.
- [ ] 앱 restart와 exit를 desktop 수명주기에 연결한다.
- [ ] CLI argument와 subcommand schema, help, 오류와 match 결과를 제공한다.
- [ ] utility process의 독립 실행과 양방향 메시지, 종료와 오류 이벤트를 제공한다.
- [ ] localhost 자산 서버는 선택 기능으로 지원 여부를 결정한다. 기본 통신 경로는 기존 로컬 자산과 브리지다.
- [ ] HTTP client-request와 incoming-message의 stream 기능을 Bun 대체 API에 매핑한다.

## 21. 암호화 저장과 시스템 인증

우선순위 P2. 소유자: 공식 보안 기능 플러그인 후보. 출처: [E-safe], [T-stronghold], [T-biometric].

- [ ] OS 암호화 저장 지원 여부를 조회한다.
- [ ] Windows DPAPI를 사용하는 문자열과 bytes 암호화, 복호화를 제공한다.
- [ ] OS credential store에 secret을 저장, 조회하고 삭제하는 기능의 지원을 결정한다.
- [ ] Stronghold 방식의 vault, client, key와 record 관리 기능을 제공한다.
- [ ] vault unlock, lock, save와 암호 변경을 제공한다.
- [ ] 키 생성과 cryptographic operation을 secret 노출 없이 실행한다.
- [ ] vault 암호 파생 함수와 salt의 설정, 생성과 보관 방법을 제공한다.
- [ ] 재설치, 다른 사용자와 다른 머신에서 복호화할 수 없는 경우의 오류를 정의한다.
- [ ] 일반 평문 store와 암호화 저장을 구분하고 평문 fallback은 명시적으로 선택한다.
- [ ] Windows Hello를 통한 사용자 확인은 추가 기능으로 지원 여부를 결정한다. Tauri 공식 biometric의 모바일 지원과 구분한다.

## 22. 자동 업데이트와 앱 배포 기능

우선순위 P2, 첫 공개 릴리스 준비는 P1. 소유자: updater 플러그인, 패키저와 호스트.
출처: [T-updater], [E-updater], [T-config], [E-app].

- [x] 고정 Bun으로 앱 코드와 웹 자산, 설정과 정책을 compiled EXE에 포함한 Windows 앱 패키지를 만든다.
- [x] Inno Setup 기반 direct와 Store unpackaged 채널의 설치 파일 생성 경로가 있다.
- [x] 앱 이름과 ICO 아이콘을 가진 GUI EXE로 실행하고 시작 실패 대화상자와 로그를 제공한다.
- [ ] 설치 옵션에 autostart, 파일 연결과 URL scheme의 opt-in을 연결한다.
- [ ] 설치 위치 변경과 업데이트에서 앱 데이터, 연결과 바로가기를 유지한다.
- [ ] 서명된 compiled EXE 앱의 설치, 덮어쓰기 업데이트와 제거를 검증한다.
- [ ] WebView2 없는 PC의 설치, offline 배포와 최소 runtime 버전을 처리한다.
- [ ] MSIX 활성화와 안전한 런타임 시작 경로를 구현하고 검증한다.
- [ ] 업데이트 endpoint, channel, target와 architecture를 지정한다.
- [ ] 현재 버전과 최신 버전 비교, release notes와 업데이트 유무를 조회한다.
- [ ] 다운로드 progress, 취소, timeout과 실패 재시도를 제공한다.
- [ ] 업데이트 서명과 해시를 검증한다.
- [ ] 설치, 종료 승인과 relaunch를 연결한다.
- [ ] downgrade, partial failure와 rollback의 지원 범위를 결정한다.
- [ ] Store 업데이트와 자체 updater의 사용 조건을 구분한다.
- [ ] framework와 공식 기능 패키지의 공개 배포, 라이선스와 릴리스 자동화를 완료한다.
- [ ] 설치된 프레임워크 업그레이드와 설정 변경의 migration 도구를 제공한다.

## 23. 명령, 이벤트와 전송 확장

우선순위 P2. 소유자: SDK, 코어와 프로토콜. 출처: [T-core], [T-event], [E-ipc], [E-bridge], [E-message].

- [x] 명령 invoke, schema 검증과 앱 정의에서 입력과 출력 타입 추론을 제공한다.
- [x] 이벤트 구독, 해제, broadcast와 지정 뷰 전달을 제공한다.
- [x] 권한, 취소, deadline과 종료된 세션의 늦은 응답 처리를 제공한다.
- [x] 기본 WebView 연결을 공유하고 HMR과 pagehide에서 수명을 관리한다.
- [ ] once 구독과 대상 창, WebView, backend 이벤트 전달의 공개 계약을 제공한다.
- [ ] native 이벤트를 동일한 typed 구독 API로 전달한다.
- [ ] binary payload와 JSON 외 데이터의 전송 계약을 추가한다.
- [ ] 연속 결과와 대용량 데이터의 channel 또는 stream 전송을 제공한다.
- [ ] MessagePort와 transferable resource에 해당하는 기능을 제공한다.
- [ ] 백엔드에서 UI로 요청하고 결과를 받는 기능의 필요성을 결정한다.
- [ ] native resource handle의 생성, 참조와 해제 계약을 제공한다.
- [ ] UI에 노출할 명령과 이벤트의 타입, 계약과 정책 목록을 생성하는 도구를 제공한다.
- [ ] 브라우저 테스트용 transport와 mock API를 제공한다.
- [ ] context bridge와 preload의 역할을 기존 SDK와 정책으로 대체하는 범위를 정한다.
- [ ] 동기 IPC와 프런트엔드의 임의 Node/Bun 접근은 PRD와 충돌하므로 도입 여부를 별도 ADR에서 결정한다.

## 24. 개발 도구, 진단과 성능 API

우선순위 P2, 실험 API는 P3. 소유자: CLI와 호스트, 앱 로그는 공식 기능 플러그인.
출처: [E-debugger], [E-tracing], [E-crash], [E-net-log], [E-process], [T-log], [T-mocks].

- [x] UI HMR과 백엔드 변경 재시작을 제공한다.
- [x] 웹 build.command와 앱 빌드를 통합하고 프로세스 종료를 관리한다.
- [x] Windows 개발 모드 DevTools와 `dev --inspect`를 제공한다.
- [x] UI와 백엔드 소스맵과 원본 명령 오류 스택을 제공한다.
- [x] 앱 로그와 플러그인 없이 남기는 프레임워크 진단을 구분한다.
- [ ] DevTools 열기, 닫기, 상태 조회와 이벤트 API를 제공한다.
- [ ] 요소, service worker와 shared worker 검사 API의 지원을 결정한다.
- [ ] DevTools workspace의 추가와 제거, dock 위치, 별도 창과 title을 설정한다.
- [ ] device emulation의 viewport, 화면 배율과 입력 설정을 제공한다.
- [ ] debugger protocol 연결, 명령 실행과 이벤트를 제공한다.
- [ ] 개발 도구 확장 설치와 실행 범위를 제공한다.
- [ ] startup, CPU, 메모리, GPU와 렌더러 지표를 조회한다.
- [ ] GPU 정보, hardware acceleration 상태와 변경 옵션을 제공한다.
- [ ] tracing category 조회, 기록 시작와 중단과 buffer usage를 제공한다.
- [ ] network log 시작, 종료와 결과 경로를 제공한다.
- [ ] crash report, minidump와 최근 crash 조회를 제공한다.
- [ ] crash metadata와 사용자가 선택하는 업로드를 제공한다. 기본 외부 전송은 비활성화한다.
- [ ] 로그 level, target, rotation, retention과 flush를 제공한다.
- [ ] 시작 시간, 유휴 메모리, 패키지 크기와 명령 지연의 기준 측정을 기록한다.
- [ ] 각 UI 템플릿의 실제 Windows dev, HMR, build와 package 실행을 검증한다.
- [ ] 고급 process crash, hang, heap snapshot과 JavaScript stack 수집의 지원 범위를 결정한다.

## 25. 선택 렌더러와 고급 데스크톱 기능

우선순위 P3. 소유자: 선택 렌더러와 기능 패키지. 출처: [E-view], [E-contents], [E-extensions], [E-texture], [E-ai].

- [ ] CEF 등 선택 Chromium 렌더러를 동일한 SDK와 정책 계약에 연결한다.
- [ ] renderer capability에 따라 미지원 기능을 명시하고 엔진 선택 방법을 제공한다.
- [ ] offscreen rendering의 frame, dirty region과 frame rate를 제공한다.
- [ ] painting 시작, 중단, 상태 조회와 invalidate를 제공한다.
- [ ] WebContents clone과 frame subscription의 지원을 결정한다.
- [ ] GPU shared texture의 가져오기, 전달, 수명과 동기화를 제공한다.
- [ ] View tree와 native child view의 배치, 순서, bounds, clipping과 visibility를 제공한다.
- [ ] native ImageView, border radius와 background blur의 지원을 결정한다.
- [ ] `<webview>` 태그와 같은 UI 내 guest WebView의 필요성과 권한 경계를 결정한다.
- [ ] 브라우저 확장과 Chrome API 호환 subset을 제공한다.
- [ ] Chromium feature flag, V8 code-cache와 sandbox 설정은 Bun과 WebView2의 대체 또는 미지원으로 매핑한다.
- [ ] trusted backend sandbox가 필요한 앱에 별도 프로세스 격리 모델을 제공할지 결정한다.
- [ ] WebRTC, WebGL, shared worker와 Web API의 엔진별 지원 차이를 검증한다.
- [ ] Electron localAIHandler와 LanguageModelUtility의 실험 기능에 대응할 필요성을 결정한다.
- [ ] obsolete BrowserView와 protocol API는 현대 View와 protocol 기능에 매핑하고 구 API 호환 여부를 기록한다.

## 26. macOS와 Linux 전용 기능

우선순위 P3. Windows 완성 후 진행한다. 소유자: 플랫폼 호스트와 공식 기능 패키지.
출처: [T-window], [T-app], [E-window], [E-app], [E-dock], [E-touch], [E-system], [E-share], [E-purchase], [E-push].

- [ ] macOS를 같은 Bun 앱 정의와 desktop, window, WebView 계약에 맞춘다.
- [ ] Linux 호스트와 렌더러를 구현하고 X11/Wayland별 기능 차이를 명시한다.
- [ ] macOS activation policy, app hide/show와 Dock visibility를 제공한다.
- [ ] Dock icon, badge, bounce, menu와 recent documents를 제공한다.
- [ ] macOS titlebar style, traffic-light 위치, 버튼 표시와 hidden title을 제공한다.
- [ ] macOS native fullscreen, simple fullscreen과 fullscreen transition을 제공한다.
- [ ] macOS window tab의 추가, 분리, 이동과 tab bar를 제공한다.
- [ ] represented filename, document edited와 sheet 이벤트를 제공한다.
- [ ] Mission Control 숨김과 모든 workspace 표시를 제공한다.
- [ ] vibrancy, window effects와 shadow 갱신을 제공한다.
- [ ] Quick Look 파일 미리보기와 선택 단어 사전 기능을 제공한다.
- [ ] Touch Bar button, slider, group, picker, scrubber와 popover를 제공한다.
- [ ] macOS 메뉴 Help/Window 역할, Services와 Share menu를 제공한다.
- [ ] macOS 트레이 title, template와 pressed 이미지, drop과 drag 이벤트를 제공한다.
- [ ] NSUserDefaults와 distributed/local/workspace notification을 제공한다.
- [ ] Handoff와 user activity의 시작, 갱신과 종료를 제공한다.
- [ ] macOS camera/microphone 요청, Touch ID와 accessibility trust를 제공한다.
- [ ] secure keyboard entry와 security-scoped bookmark를 제공한다.
- [ ] 앱의 Applications 위치 조회와 이동을 제공한다.
- [ ] macOS Store in-app purchase의 상품, 결제와 transaction 복원을 제공한다.
- [ ] macOS APNs push 등록, token과 수신 이벤트를 제공한다.
- [ ] Linux desktop name, badge와 desktop-file 연결을 제공한다.
- [ ] Linux primary-selection 클립보드를 제공한다.
- [ ] Linux notification urgency, secret-store backend와 인증서 import를 제공한다.
- [ ] Wayland의 전역 단축키, 포커스, 위치와 화면 캡처에 portal을 연결한다.
- [ ] 플랫폼별 window gesture, cursor auto-hide와 first-mouse 동작을 제공한다.
- [ ] Intel, ARM64와 translation 환경의 runtime pin, 실행과 배포를 검증한다.

## 27. 모바일 전용 공식 기능

우선순위 P3. Windows 완성 후 플랫폼 실행 모델을 검증한다.
출처: [T-biometric], [T-geolocation], [T-barcode], [T-haptics], [T-nfc], [T-notification], [T-app], [T-config].

- [ ] Android와 iOS의 호스트, Bun 실행, 중단과 복귀, 배포 경로를 구현한다.
- [ ] native permission 요청, 거부, 재요청과 시스템 설정 이동을 제공한다.
- [ ] 앱 foreground/background, resume, pause와 back-button 이벤트를 제공한다.
- [ ] 모바일 다중 창, Android activity와 iOS scene 식별, 지원 여부 조회를 제공한다.
- [ ] geolocation 단일 위치, 연속 watch와 해제를 제공한다.
- [ ] biometric 지원 상태 조회와 authenticate, 취소를 제공한다.
- [ ] barcode/QR scan, 카메라 권한과 종료를 제공한다.
- [ ] haptic impact, notification, selection과 vibration을 제공한다.
- [ ] NFC 지원 조회, tag scan, 취소와 NDEF 읽기와 쓰기를 제공한다.
- [ ] 모바일 notification channel, action type, attachment와 예약을 제공한다.
- [ ] 모바일 deep link, universal/app link와 파일 연결을 제공한다.
- [ ] Android content URI와 iOS file URI의 파일 선택와 접근 수명을 제공한다.
- [ ] 모바일 data store 식별자 조회와 삭제와 웹 프로필 수명을 제공한다.
- [ ] 모바일 keyboard accessory, link preview, scrollbar와 safe-area 옵션을 제공한다.
- [ ] Android/iOS 권한 설명, entitlements와 앱 패키지 설정을 검증한다.

## 28. 플랫폼 지원과 완료 검증

우선순위 P1. 소유자: 각 기능의 구현 담당자와 배포 도구.

- [ ] Windows 10/11의 지원 최소 버전과 실제 검증 환경을 확정한다.
- [ ] WebView2 최소 버전과 Evergreen, Fixed Version 배포 지원을 확정한다.
- [ ] Windows ARM64 지원과 x64 emulation 범위를 확정한다.
- [ ] 최소와 최대 크기, DPI와 다중 모니터 회귀를 실제 사용자 조작으로 검증한다.
- [ ] IME, keyboard layout, 고대비와 스크린 리더 회귀를 검증한다.
- [ ] tray, autostart, file association과 toast를 깨끗한 Windows 설치에서 검증한다.
- [ ] suspend/resume, 잠금과 Explorer 재시작 후 자원과 구독을 검증한다.
- [ ] WebView 장애, 전체 앱 비정상 종료와 강제 종료 뒤 자원 정리를 검증한다.
- [ ] 각 플랫폼의 supported/experimental/unsupported와 OS permission 값을 실제 구현에 맞춘다.
- [ ] 지원 목록, CLI 진단, 문서와 배포 산출물을 같은 릴리스로 갱신한다.

## 다음 작업 묶음

1. 창 최소와 최대 크기, 기본 상태 제어와 창 이벤트: 02, 03, 04.
2. 트레이 개별 아이콘과 메뉴, autostart, 전역 단축키: 06, 07, 08.
3. 파일 대화상자, 클립보드, opener와 알림: 09, 10, 11, 12.
4. 모니터와 DPI, 테마, 창 상태 저장과 OS 연결: 04, 09, 13.
5. WebView와 세션 확장, 전송과 데이터 기능: 14–21, 23.
6. 업데이트, 선택 렌더러와 다른 플랫폼: 22, 25–27. PRD의 출시 범위와 별도로 우선순위를 결정한다.

## 공식 API 대조 범위

아래 출처는 이번에 확인한 스냅샷으로 고정했다. main/dev에는 실험 기능과 다음 버전의
기능이 포함될 수 있다. 실제 구현을 시작할 때 대상 안정 버전의 지원 플랫폼과
deprecated/experimental 상태를 확인하고 해당 체크 항목에 기록한다.
같은 기능의 setter, getter, 초기 설정과 이벤트는 본문의 기능 항목에 함께 연결한다.
구형 API, 엔진 내부 API와 플랫폼 전용 API도 삭제하지 않고 대체와 지원 결정 대상으로 남긴다.

- Tauri API와 Rust/config: `a916205db2c21a2475502452efa9b70132ae52f3`.
- Tauri 공식 기능 문서: `712e12a755d349303f7bcf96edd4165d0e1480db`.
- Electron API 문서: `054d1a159f4dcf775bceefb038134366578980db`.

### Tauri 기본 API와 공식 기능

| API 또는 공식 기능 | 본문 절 |
| --- | --- |
| app | 05, 13, 26, 27 |
| core, event, mocks | 23, 24 |
| dpi, window, webviewWindow | 01–04, 13, 14, 26, 27 |
| webview, Rust Webview와 WebviewWindow | 14–18 |
| image | 12 |
| menu, tray | 06, 07, 26 |
| path | 19 |
| autostart, global-shortcut, single-instance | 05, 07, 08 |
| notification, dialog, clipboard | 10–12, 27 |
| deep-link (문서: deep-linking), opener | 05, 09, 27 |
| positioner, window-state | 04 |
| file-system, persisted-scope, store, sql | 19 |
| os-info, http-client, websocket, upload | 18, 20 |
| shell, process, cli, localhost | 05, 20 |
| logging, updater, stronghold | 21, 22, 24 |
| biometric, geolocation, barcode-scanner, haptics, nfc | 21, 27 |
| window/webview/app/security/bundle 설정 | 01–03, 14–17, 22, 23, 25–28 |

### Electron 전체 API 모듈

구조체 문서는 이를 사용하는 모듈과 초기 옵션에 연결한다. Node.js와 일반 Web API의
내부 구현을 복제하는 것이 아니라 Bun 또는 WebView의 기능과 공개 앱 계약을 연결한다.

| API 모듈 | 본문 절 |
| --- | --- |
| app | 05, 08, 09, 13, 22, 24, 26 |
| BaseWindow, BrowserWindow | 01–04, 09, 14, 26 |
| BrowserView (deprecated), View, WebContentsView, ImageView (experimental) | 14, 25 |
| webContents, webFrame, webFrameMain, navigationHistory | 14–18, 24 |
| session, cookies, protocol, webRequest | 16, 17 |
| downloadItem | 18 |
| net, ClientRequest, IncomingMessage, WebSocket | 16, 20 |
| clipboard, ClipboardItem, nativeImage | 12 |
| dialog, Menu, MenuItem, Tray, globalShortcut | 06, 07, 11 |
| Notification | 10 |
| screen, nativeTheme, systemPreferences | 13, 17, 26 |
| powerMonitor, powerSaveBlocker | 13 |
| shell | 09 |
| safeStorage | 21 |
| autoUpdater | 22 |
| ipcMain, ipcRenderer, contextBridge | 23 |
| MessageChannelMain, MessagePortMain, parentPort | 20, 23 |
| utilityProcess, process | 20, 24 |
| serviceWorkers, ServiceWorkerMain, ipcMainServiceWorker | 16, 23 |
| extensions, Extensions API | 16, 25 |
| desktopCapturer, webUtils | 15, 18 |
| debugger, contentTracing, netLog, crashReporter | 24 |
| commandLine, command-line switches, environment variables | 05, 25 |
| webview tag, window.open | 14, 25 |
| sharedTexture, localAIHandler, LanguageModelUtility (experimental) | 25 |
| dock, ShareMenu, inAppPurchase, pushNotifications | 26 |
| TouchBar와 모든 TouchBar 구성 요소 | 26 |
| corner smoothing CSS | 03, 25 |
| BaseWindowConstructorOptions, BrowserWindowConstructorOptions, WebPreferences | 01–03, 14, 17, 25, 26 |

## 참고 자료

[T-window]: https://github.com/tauri-apps/tauri/blob/a916205db2c21a2475502452efa9b70132ae52f3/packages/api/src/window.ts
[T-webview]: https://github.com/tauri-apps/tauri/blob/a916205db2c21a2475502452efa9b70132ae52f3/packages/api/src/webview.ts
[T-webview-rust]: https://github.com/tauri-apps/tauri/blob/a916205db2c21a2475502452efa9b70132ae52f3/crates/tauri/src/webview/mod.rs
[T-config]: https://github.com/tauri-apps/tauri/blob/a916205db2c21a2475502452efa9b70132ae52f3/crates/tauri-utils/src/config.rs
[T-app]: https://github.com/tauri-apps/tauri/blob/a916205db2c21a2475502452efa9b70132ae52f3/packages/api/src/app.ts
[T-tray]: https://github.com/tauri-apps/tauri/blob/a916205db2c21a2475502452efa9b70132ae52f3/packages/api/src/tray.ts
[T-menu]: https://github.com/tauri-apps/tauri/blob/a916205db2c21a2475502452efa9b70132ae52f3/packages/api/src/menu.ts
[T-image]: https://github.com/tauri-apps/tauri/blob/a916205db2c21a2475502452efa9b70132ae52f3/packages/api/src/image.ts
[T-path]: https://github.com/tauri-apps/tauri/blob/a916205db2c21a2475502452efa9b70132ae52f3/packages/api/src/path.ts
[T-core]: https://github.com/tauri-apps/tauri/blob/a916205db2c21a2475502452efa9b70132ae52f3/packages/api/src/core.ts
[T-event]: https://github.com/tauri-apps/tauri/blob/a916205db2c21a2475502452efa9b70132ae52f3/packages/api/src/event.ts
[T-mocks]: https://github.com/tauri-apps/tauri/blob/a916205db2c21a2475502452efa9b70132ae52f3/packages/api/src/mocks.ts
[T-single-instance]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/single-instance.mdx
[T-process]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/process.mdx
[T-window-state]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/window-state.mdx
[T-positioner]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/positioner.mdx
[T-global-shortcut]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/global-shortcut.mdx
[T-autostart]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/autostart.mdx
[T-opener]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/opener.mdx
[T-deep-link]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/deep-linking.mdx
[T-notification]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/notification.mdx
[T-dialog]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/dialog.mdx
[T-clipboard]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/clipboard.mdx
[T-upload]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/upload.mdx
[T-fs]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/file-system.mdx
[T-store]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/store.mdx
[T-sql]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/sql.mdx
[T-persisted-scope]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/persisted-scope.mdx
[T-os]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/os-info.mdx
[T-http]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/http-client.mdx
[T-websocket]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/websocket.mdx
[T-shell]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/shell.mdx
[T-cli]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/cli.mdx
[T-localhost]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/localhost.mdx
[T-stronghold]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/stronghold.mdx
[T-biometric]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/biometric.mdx
[T-log]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/logging.mdx
[T-updater]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/updater.mdx
[T-geolocation]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/geolocation.mdx
[T-barcode]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/barcode-scanner.mdx
[T-haptics]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/haptics.mdx
[T-nfc]: https://github.com/tauri-apps/tauri-docs/blob/712e12a755d349303f7bcf96edd4165d0e1480db/src/content/docs/plugin/nfc.mdx
[E-window]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/base-window.md
[E-window-options]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/structures/base-window-options.md
[E-app]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/app.md
[E-tray]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/tray.md
[E-menu]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/menu.md
[E-menu-item]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/menu-item.md
[E-shortcut]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/global-shortcut.md
[E-shell]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/shell.md
[E-notification]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/notification.md
[E-dialog]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/dialog.md
[E-clipboard]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/clipboard.md
[E-image]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/native-image.md
[E-screen]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/screen.md
[E-theme]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/native-theme.md
[E-system]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/system-preferences.md
[E-power]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/power-monitor.md
[E-power-blocker]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/power-save-blocker.md
[E-contents]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/web-contents.md
[E-view]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/web-contents-view.md
[E-history]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/navigation-history.md
[E-frame]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/web-frame.md
[E-frame-main]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/web-frame-main.md
[E-session]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/session.md
[E-cookies]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/cookies.md
[E-request]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/web-request.md
[E-protocol]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/protocol.md
[E-net]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/net.md
[E-download]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/download-item.md
[E-capture]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/desktop-capturer.md
[E-utility]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/utility-process.md
[E-safe]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/safe-storage.md
[E-updater]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/auto-updater.md
[E-ipc]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/ipc-main.md
[E-bridge]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/context-bridge.md
[E-message]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/message-port-main.md
[E-debugger]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/debugger.md
[E-tracing]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/content-tracing.md
[E-crash]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/crash-reporter.md
[E-net-log]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/net-log.md
[E-process]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/process.md
[E-extensions]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/extensions.md
[E-texture]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/shared-texture.md
[E-ai]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/language-model-utility.md
[E-dock]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/dock.md
[E-touch]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/touch-bar.md
[E-share]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/share-menu.md
[E-purchase]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/in-app-purchase.md
[E-push]: https://github.com/electron/electron/blob/054d1a159f4dcf775bceefb038134366578980db/docs/api/push-notifications.md

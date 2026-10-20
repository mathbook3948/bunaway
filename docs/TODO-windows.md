# Windows 데스크톱 기능 TODO: Tauri와 Electron 비교

macOS의 현재 구현과 후속 작업은 [macOS TODO](./TODO-macos.md)에서 관리한다.

기준일: 2026-10-11. bunaway main `2b78dc5` 기반 창 준비 변경과 저장소에 기록된 실행 결과를 기준으로 갱신했다.
Tauri v2의 기본 API와 공식 플러그인, Electron의 공개 API를 기능별로 대조한다.
창 최소 크기와 최대 크기처럼 초기 설정, 실행 중 변경, 조회, 이벤트가 따로 필요한
기능은 각각 작업으로 기록한다. 비교 대상의 메서드 이름이나 바이너리와의 호환을
요구하는 문서가 아니라, 같은 앱 요구사항을 해결하기 위한 개발 목록이다.

2026-10-08 보완은 당시 main `c0d3d45bb1f36651ee417c25455fe077ba293ed0`의
28영역, 483항목을 다시 대조했다. 기존 완료 표시와 우선순위를 유지하고 누락된 기능과
완료 조건을 보완했다. 아래 API 표는 기능별 탐색을 돕는 색인이며 모든 API, 옵션,
이벤트의 전수 매핑을 완료했다는 뜻은 아니다.

2026-10-09 갱신은 이후 병합된 창 크기 제약, HTTP/HTTPS opener, 저장소 메타데이터와
설치 바로가기 보존 구현을 반영했다. 완료 표시는 기준 코드의 구현 여부로 판단한다.
Tauri와 Electron 비교 자료의 기준 버전은 이전 스냅샷을 유지한다.

2026-10-10 갱신은 창 상태 변경 5개와 상태 조회 5개, content/outer/normal 좌표 조회 7개와
DPI 변환 2개, content 위치와 outer 크기, content/outer bounds 설정 4개,
`windows.changed` 창 이벤트와 `getSnapshot`, 호환되는 개발 앱의 명령 구현 교체를 반영했다.
파일 opener와 Explorer 선택, 텍스트 클립보드, 사용자 범위 autostart의 구현도 포함한다.
focus/blur와 물리 드래그 검증을 다중 물리 모니터 검증과 구분하고, 전체 Windows 호스트
회귀의 실패와 실제 로그인 실행 등 남은 검증을 기록한다. 27절에는 Android 단일 뷰 호스트와
debug APK 개발 경로를 반영하고 iOS 및 모바일 후속 작업을 분리한다.
공통 Worker 채널과 앱 manifest 정리, Bun 기반 네이티브 실행기 전환도
현재 구현 근거에 포함한다. 비교 대상의 API 목록은 새로 전수 대조하지 않았다.

## 상태와 작업 기준

- `[x]`는 기준 코드에 구현된 기능이다. 플랫폼별 항목은 해당 절에 명시한 플랫폼에만 적용하며,
  출시 지원 전체의 완료를 뜻하지 않는다.
- 지원 결정만 완료한 항목은 `[x] 결정 완료`로 명시하고 구현 후속 항목은 별도로 `[ ]`로 유지한다.
- `[ ]`는 미구현, 부분 구현의 확장 또는 지원 방식을 결정해야 하는 작업이다.
- P1은 일반 데스크톱 앱의 기본 기능, P2는 기능 확장, P3은 고급 기능과 다른 플랫폼의 후속 작업이다.
- 각 절의 소유자는 권장안이다. 호스트는 앱, 창, WebView와 세션의 최종 수명주기를 소유한다.
  선택 플러그인은 개별 기능과 자원을 관리하며 호스트의 실행, 이벤트, 종료 계약을 사용한다.
- 내장 기능, 선택 패키지, 플러그인이라는 배포 형태와 실행 책임을 구분한다.
  트레이와 메뉴를 선택 패키지로 제공하더라도 호스트와 같은 UI 실행 경로를 사용할 수 있다.
- 기존 플러그인 구조 개편 자체는 이 목록에 넣지 않는다. 플러그인으로 제공할 앱 기능은 포함한다.
- 각 기능은 해당 항목의 구현이 있으면 체크한다. 실행 검증은 별도 작업으로 관리한다.
  초기 설정과 런타임 API는 각각의 구현 여부로 판단한다.
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
- [x] `getById`, `getCurrent`, `getFocused`, `getLastActive`로 창 ID, 현재 창, 포커스된 창과 마지막 활성 창을 조회한다.
- [x] `windows.readiness`와 `getReadiness`로 네이티브 창 생성, 현재 문서 완료와 SDK 협상 확인을 구분한다.
- [x] `visible: false`, `showWhenReady: "document" | "sdk"`로 처음부터 숨겨서 생성하고 첫 준비 뒤 표시한다.
- [x] 포커스를 가져오지 않고 창을 표시하는 `showInactive`를 제공한다.
- [x] blur와 활성 창 전환 API를 제공한다.
- [x] `isVisible`과 `isFocused`로 실제 창의 표시 상태와 전경 창 여부를 조회한다.
- [x] `isDestroyed`와 `isNormal`로 창의 destroyed와 normal 상태를 조회한다.
- [x] 일반 close와 확인을 우회하는 trusted destroy의 계약을 구분한다.
- [x] 결정 완료: 실행 중 창 생성 옵션은 사전 선언 창의 호출별 제목, 크기와 제약, 표시 및 준비 후 표시로 제한한다. 각 생성 작업의 operation 권한을 허용한다. [ADR 0016](./decisions/0016-window-creation-contract.md).
- [x] Windows create/recreate에 ADR 0016의 선택적 `options`와 생성별 검증, 실패 정리를 구현했다. 실제 네이티브 회귀는 CI의 windows-native에서 수행한다. [#102](https://github.com/mathbook3948/bunaway/issues/102).
- [x] 결정 완료: 뷰는 화면과 정책의 생성 정의이며 single 기본값과 multiple 선택으로 창 인스턴스를 생성한다. 창별 ID와 세션, 프로필 공유 및 격리, 선언 및 인스턴스 상한은 [ADR 0017](./decisions/0017-multiple-windows-per-view.md)을 따른다. Windows는 이 계약을 구현하며 실제 네이티브 회귀는 CI로 검증한다.
- [x] Windows의 동일 뷰 다중 창 생성과 ID별 제어, 창별 세션 라우팅, 프로필 소유권과 상한을 구현했다. 실제 WebView2 검증은 CI의 windows-native 작업에서 수행한다. [#104](https://github.com/mathbook3948/bunaway/issues/104).
- [x] 부모 창, 자식 창, owner 관계를 설정하고 조회한다.
- [x] 부모에 종속된 모달 창과 부모의 입력 차단, 종료 순서를 제공한다.
- [x] 창 enabled 상태의 변경과 조회를 제공한다.
- [x] 창이 없는 상주 앱과 트레이만 있는 앱의 시작을 지원한다. 빈 창 선언 또는 모든 `startup: false`를 허용하며 트레이 또는 `closeBehavior: "keep-alive"`를 요구한다.
- [x] 앱 초기화 뒤 `completeSplashscreen`으로 준비된 주 창을 먼저 표시하고 splashscreen을 닫는다.

2026-10-11 main `49ed0a5` 이후 ADR 0017로 같은 뷰의 여러 창 보류를 변경했다.
호출별 옵션과 다중 인스턴스를 구현했다. single 기본값과 중복 선언의 시작 전 진단,
열린 뷰의 create에 대한 BUSY와 자원 보존, 허용하지 않은 생성 필드와 임의 ID 거부,
식별자 개행 거부 및 128개 선언 상한 검사는 유지한다. #102와 #104는 실제 구현과 검증 뒤 닫는다.

2026-10-11 창 없는 시작은 트레이 또는 명시적 keep-alive로 실행 유지 조건을 검증한다.
keep-alive는 마지막 창을 닫아도 백엔드를 유지하고 Quit 또는 `DesktopContext.quit()`으로 종료한다.
트레이 Open과 show는 살아 있는 창을 복원하며 열린 창이 없으면 첫 사전 선언 창을 생성한다.
빈 선언 배열이면 창을 만들지 않는다. 종료 취소, 창 없는 상태의 개발 CLI 중단과
강제 종료 검증 범위는 [실행 기록](./architecture/windows-bun-results.md)을 따른다.

세 항목의 완료 조건, 이벤트 수신 권한, 구독 뒤 상태 복구, 탐색과 재생성 초기화 및 실패,
취소와 기한은 [창 API](./site/src/content/docs/reference/host/windows.mdx)를 따른다.
Windows 11 Pro x64, Bun 1.4.2의 실제 WebView2에서 문서와 SDK 순서, 준비 실패와 취소,
SDK 기한 초과 및 전환 중 마지막 창 종료 억제를 확인했다.
별도 Win32, WinEvent 관찰에서는 숨김 생성 중 순간 표시와 활성화, 포커스가 없고 입력 포커스가 유지됐다.
검증 범위는 [실행 기록](./architecture/windows-bun-results.md)에 구분한다. macOS 후속 구현은 포함하지 않는다.

2026-10-10 창 탐색 구현은 기존 `getSnapshot`의 `windowId`와 정책 `viewId`를 재사용한다.
문서 탐색은 ID를 유지하고 네이티브 재생성은 새 ID를 발급한다. 없는 창, 닫힌 창과
허용되지 않은 탐색 대상은 `null`이다. 현재 창은 인증된 호출 출처에서 구하며 백엔드는
`null`이다. 실제 활성화만 마지막 활성 기록을 갱신하고 그 창을 파괴하면 이전 창으로
되돌리지 않고 기록을 지운다. 공개 권한과 오류는 [창 API](./site/src/content/docs/reference/host/windows.mdx)를 따른다.

구현 검증과 실행 검증을 구분한다. 계약 테스트는 입력과 출력 schema, 목록 권한과 대상
권한, 호출 출처, 닫힘 상태와 취소를 확인한다. Windows Server 2022 실제 HWND 테스트는
외부 전경 창, 활성화 이력, 숨김과 파괴, 조회 중 표시와 포커스 유지를 확인했다.
실제 WebView2와 UI Worker 실행은 문서 탐색의 ID 유지, 재생성의 ID 교체, 닫힌 창과
이전 ID 조회, normal과 destroyed 상태, 뷰별 권한 거부를 확인했다. 다중 물리 모니터와
사용자 입력에 의한 모든 포커스 전환을 검증했다는 뜻은 아니다.

`showInactive`는 숨김만 해제하며 최소화, 최대화 상태와 다른 창의 입력 포커스를 유지한다.
`activate`는 표시된 비최소화 창을 지정해 전환하고 실제 전경 여부를 반환한다.
`blur`는 같은 호출 컨텍스트에서 제어 권한이 있는 적격 앱 창을 설정 순서로 선택한다.
OS 거부와 후보 없음, 기존 show, hide, focus와의 차이는 [창 API](./site/src/content/docs/reference/host/windows.mdx)의 공개 계약을 따른다.
실제 두 Win32 창과 입력 필드의 포커스 보존, 전경 전환의 검증 한계는
[실행 기록](./architecture/windows-bun-results.md)에 구분한다.

2026-10-11 부모와 모달 구현은 main `488f88a`의 네이티브 창 식별자와 준비 계약을
유지한다. `setParent`, `getParent`, `getOwner`, `getChildren`, `setEnabled`, `isEnabled`와
백엔드 전용 `destroy`를 제공한다. 일반 close는 확인과 종료 취소를 유지하며,
destroy는 별도 권한으로 확인을 우회한다. 여러 모달의 차단과 이전 enabled 상태 복원,
자식부터의 자원 정리, 재생성 중 부모 수명 종료를 처리한다. 초기 설정의 관계 지정과
child HWND 임베딩은 지원하지 않는다. 계약과 실제 HWND 검증은 통과했으며,
WebView2 실행 검증 결과와 남은 정리 문제는 [실행 기록](./architecture/windows-bun-results.md)에 구분한다.

## 02. 창 크기와 위치, 최소 크기와 최대 크기 제약

우선순위 P1. 소유자: 호스트와 창 API. 출처: [T-window], [T-config], [E-window], [E-window-options].

초기 크기 제약과 실행 중 변경, 크기와 위치 조회, DPI 변환을 구현했다.
`minWidth`, `minHeight`, `maxWidth`, `maxHeight`와 `setSize`는 96 DPI 기준 논리 픽셀을
사용하고 입력 범위는 200–4096이다. 제약 기본값은 모두 `null`이며 한 축만 제한하거나
해제할 수 있다. 초기 크기와 실행 중 크기는 제약 안으로 보정하고 min > max는 거부한다.
전체화면에서는 제약 적용을 보류하고 해제할 때 다시 적용한다.
content/outer/normal 조회는 기본적으로 물리 픽셀을 반환하며 `unit: "logical"`로
96 DPI 기준 논리 픽셀을 조회할 수 있다. 조회와 변환은 사용한 대상 창의 `dpi`를 함께 반환한다.
`setSize`는 내용 영역의 논리 크기, `setPosition`은 창 바깥쪽의 물리 화면 좌표를 받는다.
공개 계약은 [창 API](./site/src/content/docs/reference/host/windows.mdx)를 따른다.

- [x] 내용 영역의 크기와 창 바깥쪽 위치를 실행 중 변경한다.
- [x] 초기 설정에 `minWidth`와 `minHeight`를 제공한다.
- [x] 초기 설정에 `maxWidth`와 `maxHeight`를 제공한다.
- [x] 실행 중 `setMinSize`와 `getMinSize`로 최소 크기를 변경하고 조회한다.
- [x] 실행 중 `setMaxSize`와 `getMaxSize`로 최대 크기를 변경하고 조회한다.
- [x] `setSizeConstraints`와 `getSizeConstraints`로 최소 크기와 최대 크기를 함께 변경하고 조회한다.
- [x] 제약 해제, 한 축만 제한, 기본값과 min > max 입력 오류를 정의한다.
- [x] 초기 크기와 `setSize`가 제약을 벗어날 때 거부 또는 보정 규칙을 정의한다.
- [x] Windows의 사용자 크기 조절, 최대화, 복원에도 최소 크기와 최대 크기 제약을 적용한다.
- [x] DPI 변경, 모니터 이동과 전체화면 해제 뒤에도 크기 제약을 유지한다.
- [x] `getContentSize`, `getOuterSize`, `getContentPosition`, `getOuterPosition`,
  `getContentBounds`, `getOuterBounds`로 content와 outer 크기, 위치, bounds를 구분해 조회한다.
- [x] `setContentPosition`, `setOuterSize`, `setContentBounds`, `setOuterBounds`로
  content 위치, outer 크기와 content/outer bounds를 지정해 설정한다.
  단위 기본값은 물리 픽셀이며 논리 입력, content 기준 크기 제약과 반올림을 정의한다.
  숨김 상태를 유지하고 최소화와 최대화 중에는 일반 복원 영역만 변경한다. 전체화면은 거부한다.
- [x] `getNormalBounds`로 최소화, 최대화와 전체화면에서 복원할 일반 창의 outer bounds를 조회한다.
- [x] `toLogical`과 `toPhysical`로 대상 창 DPI를 사용해 좌표, 크기와 bounds를 변환한다.
  반올림, 정수 범위와 오류, 대상 창 권한과 닫힌 창의 동작은 창 API 계약을 따른다.
- [x] 초기 x, y, center와 content-size 기준 옵션을 구현했다. ADR 0019의 필드별 병합과 예약 전 검증을 single/multiple 생성 및 재생성에 적용한다.
- [x] `windows.center`로 실행 중 창을 현재 모니터의 작업 영역 중앙에 배치한다. 숨김과 최소화, 최대화 상태를 유지하며 최소화와 최대화 중에는 일반 복원 영역만 배치한다.
- [x] `windows.center`의 `monitorId`로 공개 모니터 ID가 가리키는 모니터의 작업 영역 중앙에 배치한다. 호출 시점에 ID를 해석하며 연결되지 않은 ID는 주 모니터로 대체하지 않고 거부한다. Windows Server 2022의 모니터 1개와 DPI 96에서 실제 HWND로 확인했다.
- [ ] 실행 중 `windows.center`의 `monitorId` 배치를 최소화와 최대화 창을 포함해 다중 물리 모니터와 혼합 DPI에서 실행 검증한다. 합성 입력과 CI는 이 범위를 대신하지 않는다.
- [x] 초기 창 위치와 크기를 작업 영역에 맞추는 preventOverflow를 구현했다. 최소 content 크기와 프레임을 유지할 수 없으면 예약 및 기존 창 종료 전에 거부한다.
- [x] 초기 배치의 순수 계산과 오류 경계 검증을 완료했다. 음수 좌표, signed 32-bit 경계, DPI 96/120/144/192, content/outer, 제약 충돌과 선언 보존을 검사했다.
- [x] 초기 배치의 실제 HWND 및 WebView2 집중 검증을 완료했다. Windows Server 2022의 모니터 1개와 DPI 96에서 초기 선언 및 single/multiple 생성과 재생성을 확인했다. multiple은 isolated 프로필이다.
- [ ] 초기 배치를 다중 물리 모니터, 혼합 DPI와 실제 높은 DPI에서 실행 검증한다. 합성 입력과 CI는 이 범위를 대신하지 않는다.
- [x] `setAspectRatio`와 `getAspectRatio`로 내용 영역의 너비/높이 비율(0.1–10, `null`은 해제)을 고정하고 조회한다.
  설정 시 현재 크기는 바꾸지 않고(Electron과 같음) 이후 사용자 크기 조절의 `WM_SIZING` 사각형만 조정한다.
  끄는 테두리(`WMSZ_*`)에 따라 기준 축과 고정 모서리를 정하며, 비율은 내용 영역 기준이고 기존 크기 제약을
  현재 DPI의 물리 픽셀로 변환하고 시스템 최소, 최대 추적 크기와 교차해 함께 적용한다.
  범위가 겹치지 않으면 최소가 이기고, 범위와 비율이 충돌하면 범위를 우선한다.
  최대화, 전체화면, 스냅과 프로그램의 크기 변경은 비율을 강제하지 않으며 macOS는 `UNSUPPORTED`다.
  순수 계산과 계약은 단위 테스트로, 실제 HWND의 합성 `WM_SIZING`은 Windows CI에서 확인한다.
- [x] `setResizable`, `isResizable`, `setMovable`, `isMovable`로 Windows 사용자 크기 조절과 이동을 설정하고 조회한다. 프로그램의 geometry API는 계속 허용하며 전체화면 뒤에도 설정을 유지한다.
- [ ] 설정과 런타임 크기 제한을 실제 모니터, DPI에 맞게 재검토한다. 현재의 4096 상한을 유지할지 결정한다.
- [ ] 위치와 크기의 선택적 애니메이션을 지원하거나 플랫폼별 미지원으로 명시한다.

## 03. 창 상태, 외관과 사용자 타이틀바

우선순위 P1, 효과와 특수 창은 P2. 소유자: 호스트와 창 API. 출처: [T-window], [E-window], [E-window-options].

- [x] 현재 모니터의 전체화면과 이전 표시 상태, 위치 복원을 제공한다.
- [x] minimize, maximize, unmaximize, restore와 toggleMaximize API를 제공한다.
- [x] `isMinimized`, `isMaximized`, `isFullscreen`으로 최소화, 최대화, 전체화면 상태를 조회한다.
- [x] 최소화 전 최대화 상태의 복원, 일반 크기 복원과 반복 호출의 동작을 정의한다.
- [x] 숨긴 창의 상태 변경은 창을 표시하고, 전체화면 중 다섯 상태 변경은 `INVALID_ARGUMENT`로 거부한다.
- [x] 상태 조회에도 해당 operation 권한을 검사하고 닫힌 창의 오류를 처리한다.
- [x] Windows 선언과 생성별 `options.window`의 `maximized`, `fullscreen`을 지원한다. 숨김과 준비 후 표시를 유지하고 두 옵션을 함께 켜면 전체화면 해제 뒤 최대화 상태를 복원한다.
- [x] Windows `setMinimizable`/`isMinimizable`, `setMaximizable`/`isMaximizable`, `setClosable`/`isClosable`로 네이티브 버튼과 사용자 동작을 설정하고 조회한다. 프로그램의 상태 및 close API는 유지한다.
- [x] Windows `setFullscreenable`/`isFullscreenable`로 창 인스턴스별 전체화면 진입 허용(기본 true)을 설정하고 조회한다. false이면 진입을 `INVALID_ARGUMENT`로 거부하고 전체화면 중 변경은 현재 상태를 유지하며 해제는 항상 허용한다.
- [x] Windows 선언과 생성별 `window.focusable`, 실행 중 `setFocusable`와 `isFocusable`을 제공한다. 비활성 표시와 사용자 및 호스트 활성화 차단, 현재 포커스와 별도 조회 및 재생성 기본값을 유지한다.
- [x] `setTitle`과 `getTitle`로 Windows 창 title을 실행 중 변경하고 조회한다. 선언과 다른 인스턴스를 변경하지 않으며 닫기 확인 창에도 현재 title을 사용한다.
- [ ] 창 icon을 실행 중 변경하고 조회한다. 이미지 입력과 배포 리소스 계약을 정의한다.
- [ ] decorations와 frame의 초기 설정, 변경과 조회를 제공한다. `titlebar: "custom"`과 CSS drag는 구현됐으며 전체 decorations/frame API는 남아 있다.
- [x] Windows `titlebar: "custom"`과 WebView2 CSS `app-region: drag/no-drag`, 네이티브 resize 테두리를 제공한다. 전체 테두리 제거와 caption overlay는 미지원이며 물리 마우스 및 접근성 도구 검증은 별도다.
- [x] 프로그램에서 창 이동과 방향별 크기 조절을 시작한다. 사용자 CSS `app-region: drag` 이동과 함께 `startDragging`, `startResizeDragging(direction)`으로 코드에서 이동과 크기 조절을 시작한다.
- [ ] 네이티브 제목 표시줄 버튼을 유지하는 title-bar overlay를 제공한다.
- [x] `window.alwaysOnTop`, `setAlwaysOnTop`, `isAlwaysOnTop`으로 활성화 없는 topmost 설정과 조회를 제공한다.
- [ ] alwaysOnBottom 및 창 Z 순서 이동의 지원 범위를 결정한다.
- [x] `window.skipTaskbar`, `setSkipTaskbar`, `isSkipTaskbar`를 제공한다. 실행 중 변경은 숨겨진 일반 창에서만 허용하며 tool-window style로 작업 표시줄과 Alt+Tab에서 제외한다.
- [ ] 키오스크 모드와 일반 전체화면의 차이를 정의한다.
- [x] 창 opacity를 설정하고 조회한다. layered window의 상수 alpha로 WebView를 포함한 창 전체에 적용하며 1이면 layered 스타일을 제거한다.
- [ ] 창 background color와 투명 배경을 제공한다.
- [x] shadow의 설정과 조회를 제공한다(`windows.setHasShadow`, `hasShadow`). `titlebar: "custom"` 창은 DWM 비클라이언트 렌더링 정책으로 끄고 같은 값으로 조회하며, 네이티브 제목 표시줄 창은 항상 shadow가 있어 `false` 설정을 `UNSUPPORTED`로 거부한다. macOS는 아직 없다.
- [ ] Windows Mica, Acrylic와 배경 material, accent color를 제공한다.
- [ ] 모서리와 창 shape의 지원을 결정한다. Electron shape는 실험 기능이다.
- [ ] roundedCorners와 corner-smoothing CSS를 지원하거나 렌더러별 차이를 명시한다.
- [ ] Windows thickFrame과 noRedirectionBitmap 같은 생성 옵션의 필요성과 지원 범위를 결정한다.
- [x] `window.contentProtection`, `setContentProtection`, `isContentProtected`를 제공한다. Windows는 `WDA_EXCLUDEFROMCAPTURE`를 쓰며 Windows 10 2004 이전은 이 값을 `WDA_MONITOR`처럼 처리하고, 호출이 거부되면 `WDA_MONITOR`로 다시 시도한다. macOS는 `sharingType`을 사용한다.
- [x] 창 mouse click-through를 설정하고 조회한다(`windows.setIgnoreMouseEvents`, `isIgnoreMouseEvents`). `WS_EX_LAYERED | WS_EX_TRANSPARENT`로 WebView를 포함한 창 전체의 마우스 입력을 아래 창으로 통과시키며 불투명도와 layered 스타일을 공유한다.
- [ ] click-through 중 마우스 이동 이벤트를 WebView에 전달하는 `forward` 옵션의 지원 여부를 결정한다.
- [ ] cursor icon, visible, position과 grab의 지원 범위를 제공한다.
- [x] 창 포커스 요청과 별개로 작업 표시줄을 점멸하는 attention API를 제공한다. `requestAttention`과 `cancelAttention`을 제공하며 Windows는 FlashWindowEx로 포커스 이동 없이 작업 표시줄 버튼을 점멸하고 untilFocused와 continuous 모드를 지원한다.
- [ ] 지정 모니터에서 전체화면으로 전환하고 모니터 제거 시 복원한다.
- [ ] Windows snapped와 tablet-mode 상태 조회의 지원을 결정한다.
- [x] 접근성용 창 제목을 일반 제목과 별도로 설정한다. `IAccPropServices.SetHwndPropStr`로 접근성 이름만 바꾸고 빈 문자열은 설정을 제거하며, Narrator 등 스크린 리더의 실제 낭독 확인은 수동 검증으로 따로 남긴다.
- [ ] 신뢰된 네이티브 어댑터에 HWND와 native WebView 접근을 제공하는 범위를 정한다.
- [ ] Windows message hook의 등록, 조회, 개별 해제와 전체 해제를 제공한다.

`restore`는 최소화 전의 일반 또는 최대화 상태를 복원하고 `unmaximize`는 일반 크기를
적용한다. `isVisible`은 다른 창에 가려졌거나 화면 밖에 있는지 판정하지 않는다.
기본 `focusable: true`에서는 최소화를 제외한 상태 변경이 활성화를 요청하지만 포커스 획득을 보장하지 않는다.
`focusable: false`이면 표시와 상태 변경, 네이티브 버튼은 새 활성화를 요청하지 않는다.
현재 계약과 오류는 [창 API](./site/src/content/docs/reference/host/windows.mdx)를 따른다.

## 04. 창 이벤트와 상태 저장

우선순위 P1. 소유자: 창 이벤트는 호스트, 영속 저장은 선택 기능. 출처: [T-window], [E-window], [T-window-state], [T-positioner].

- [x] 닫기 확인 메시지의 승인과 거절을 처리한다.
- [x] `windows.changed`로 shown과 hidden 전환을 제공한다.
- [x] `windows.lifecycle`로 created, ready, closed, destroyed 이벤트를 windowId마다 한 번씩 순서대로 제공한다. 수신에는 이벤트 정책과 `windows.listInstances` 권한이 필요하다. 실제 WebView2 검증은 CI windows-native에서 실행한다. [ADR 0020](./decisions/0020-close-and-quit-lifecycle.md)을 따른다.
- [x] `windows.changed`로 실제 전경 창 상태의 focus와 blur 전환을 제공한다.
- [x] move와 resize 전환에 현재 outer bounds와 DPI를 함께 제공한다.
- [x] Windows의 네이티브 이동과 크기 조절 루프가 끝나면 `windows.changed`에 `moved`, `resized`를 제공한다. 시작과 최종 geometry의 실제 차이를 판정하고 최종 bounds와 별도 revision을 전달한다.
- [ ] will-move와 will-resize의 취소 가능 여부를 정의한다.
- [x] minimize, maximize, unmaximize와 restore 전환을 제공한다.
- [x] enterFullscreen과 leaveFullscreen 전환을 제공한다.
- [x] `windows.changed`로 enterAlwaysOnTop과 leaveAlwaysOnTop 전환을 제공한다. API 호출과 `SetWindowPos` topmost 변경을 같은 창 위치 알림으로 관찰하고 함께 바뀐 owner와 owned 창도 알리며 동일 값은 생략한다.
- [x] `windows.closeRequested`와 `windows.respondClose`로 비동기 저장 후 닫기 승인 흐름을 제공한다. 창의 문서가 구독할 때만 사용자 닫기를 대기시키고 자동 기한은 두지 않는다. 대기 중 마지막 구독을 해제하면 요청을 취소하고 창을 유지한다. 실제 WebView2 검증은 CI windows-native에서 실행한다. [ADR 0020](./decisions/0020-close-and-quit-lifecycle.md)을 따른다.
- [x] DPI 변경을 resize 전환과 bounds의 `dpi`로 전달한다.
- [x] theme 변경 이벤트를 제공한다. Windows는 `appearance.changed`로 테마, 고대비와 접근성 설정을 알리며 동일 값은 생략한다. 13절 테마 항목과 같다.
- [x] Windows 로그오프와 시스템 종료의 WM_QUERYENDSESSION은 항상 허용하고 WM_ENDSESSION은 `"session-end"` 원인의 취소 불가 종료로 처리한다. UI 스레드는 최대 4초 동안 `onWillQuit`과 플러그인 StopHook을 기다리며 차단 API는 제공하지 않는다. 실제 HWND 검증은 CI windows-native에서 실행한다. [ADR 0020](./decisions/0020-close-and-quit-lifecycle.md)을 따른다.
- [ ] 선택적으로 ShutdownBlockReasonCreate 기반의 종료 지연 API를 제공한다. 차단 사유 문자열, 해제 규칙, 차단 중 메시지 처리와 `onQuit` 보장 범위를 먼저 정한다.
- [ ] app-command와 system-context-menu 이벤트를 제공한다.
- [x] 창 이벤트 구독 해제, 탐색과 재생성 후 새 구독, 종료 시 정리를 보장한다.
- [x] `getSnapshot`으로 windowId, revision, 상태와 bounds를 조회하고 구독 후 현재 상태를 복구한다.
- [ ] 크기, 위치, 최대화, 전체화면과 표시 상태의 저장 항목을 선택한다.
- [ ] 앱 재실행 시 창 상태를 복원하고 상태를 삭제하는 API를 제공한다.
- [ ] 저장했던 모니터가 사라진 경우 보이는 작업 영역으로 창을 복원한다.
- [ ] 모니터 모서리와 중앙, 트레이 아이콘 근처로 창을 배치하는 positioner를 제공한다.

창 이벤트는 대상 창의 정책 뷰에 기존 typed `listen`으로 전달한다. `windows.changed`
구독에는 이벤트 권한이, `getSnapshot`에는 windows.getSnapshot 작업 권한이 필요하다.
`windows.lifecycle`은 이벤트 권한과 `windows.listInstances` 작업 권한을 가진 모든 열린 뷰에,
`windows.closeRequested`는 닫히는 창 자신의 문서에만 전달한다.
초기 이벤트와 과거 이력은 재전송하지 않으며, 같은 값의 반복 관찰은 이벤트를 만들지 않는다.
창별 windowId와 revision, 구독 수명 및 용량 초과의 `BUSY` 처리 계약은
[창 API](./site/src/content/docs/reference/host/windows.mdx#창-이벤트)를 따른다.

## 05. 앱 수명주기와 실행 정보

우선순위 P1. 소유자: 호스트와 desktop API. 출처: [T-app], [E-app], [T-single-instance], [T-process].

- [x] 단일 인스턴스에 두 번째 실행의 argv와 cwd를 전달한다.
- [x] 초기 실행과 두 번째 실행의 파일, URL 입력을 `onOpen`으로 전달한다.
- [x] `beforeQuit`에서 종료를 취소하고 기존 세션을 유지한다.
- [x] 트레이 숨김과 복원, 마지막 창 닫기와 앱 종료를 구분한다.
- [x] 개발 CLI 중단과 재시작은 사용자 종료 취소를 우회하고 자원을 정리한다.
- [x] 정상 종료와 강제 종료에서 관리하는 하위 프로세스를 정리한다.
- [x] `desktop`의 `onReady`, `beforeQuit`, `onWillQuit`, `onQuit`, `onAllWindowsClosed` 훅과 `ShutdownReason`을 Windows에서 제공한다. `onWillQuit`과 `onQuit`은 각각 3초 기한을 둔다. 실제 실행 검증은 CI windows-native에서 수행한다. [ADR 0020](./decisions/0020-close-and-quit-lifecycle.md)을 따른다.
- [x] 종료 코드 지정, 강제 exit, relaunch와 인자 보존 API를 제공한다. `DesktopContext`의 `quit({ exitCode })`, `exit()`, `relaunch()`이며 [ADR 0020](./decisions/0020-close-and-quit-lifecycle.md)을 따른다. macOS도 같은 계약을 지원한다([ADR 0021](./decisions/0021-macos-desktop-lifecycle.md)). CI windows-native의 `windows-app-exit.ts`가 실제 프로세스로 종료 코드, `exit`의 훅 생략, relaunch 뒤 argv와 lock 획득을 확인한다(`boot.ts` 시작 단계는 시나리오가 같은 순서로 재현한다).
- [x] 앱 이름, 버전, 식별자, 프레임워크와 Bun, WebView 버전을 조회한다. 백엔드 `ctx.app`으로 제공하며 [CommandContext](site/src/content/docs/reference/backend/context.mdx)와 [ADR 0022](decisions/0022-app-info-context.md)에 정리했다.
- [x] 앱 패키지 경로, 실행 파일, 리소스 경로와 packaged/dev 상태를 조회한다. `ctx.app.isPackaged`와 `ctx.app.paths`로 제공하며 [CommandContext](site/src/content/docs/reference/backend/context.mdx)와 [ADR 0022](decisions/0022-app-info-context.md)에 정리했다.
- [x] 일반 브라우저와 bunaway 앱 WebView 실행 여부를 구분하는 공개 기능을 제공한다. [T-core-live]의 `isTauri`에 대응하는 요구다.
  `@bunaway/client`의 동기 함수 `isBunaway()`가 호스트 브리지(`window.chrome.webview`) 유무로 판별하며, SSR과 일반 브라우저는 `false`, 앱 WebView는 `true`다.
  단위 테스트(`tests/api/is-bunaway.test.ts`)와 Windows host 회귀(`tests/fixtures/desktop/host/web/app.js`, 본문 끝 스크립트 시작 시점 샘플)로 검증한다. 문서 첫 스크립트부터 `true`라는 주입 시점은 Windows 실측이 아니라 호스트별 주입 방식(macOS와 iOS 문서 시작 사용자 스크립트, Android 문서 시작 스크립트, Windows WebView2 제공)을 근거로 한 서술이다.
  결과는 위조 가능하므로 권한 판단에 쓰지 않는다고 문서화하고, 백엔드와 플러그인 `.ts` 소스가 `isBunaway` 심벌을 참조하지 않음을 소스 스캔 테스트로 확인한다.
- [ ] 앱 전체 포커스와 활성 상태를 제공한다. 창 생성은 `windows.lifecycle`로 제공하며 앱 전체 포커스와 활성 상태가 남았다.
- [ ] 단일 인스턴스의 추가 데이터 전달과 lock 상태 조회, 해제 필요성을 결정한다.
- [ ] 앱 ready 전에 들어온 외부 활성화 요청과 종료 요청의 순서를 공개 계약으로 정한다.
- [ ] 렌더러와 관리 프로세스의 비정상 종료 이벤트를 앱에 제공한다. [#78](https://github.com/mathbook3948/bunaway/issues/78).
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
- [ ] 앱 선언에서 앱 아이콘과 별도로 트레이용 ICO, PNG 또는 이미지 리소스를 지정한다. 실행 중 `tray.setIcon` ICO bytes 적용은 구현됐다.
- [x] `tray.setIcon`으로 ICO bytes를 적용하거나 앱 아이콘으로 복원하고 `tray.setTooltip`으로 tooltip을 실행 중 변경한다.
- [ ] 트레이 생성, 조회, 표시, 숨김, 제거와 제거 여부 조회 API를 제공한다. 조회와 표시, 숨김은 `tray.get`의 `visible`과 `tray.setVisible`(`NIS_HIDDEN`)로 구현했다. 생성과 제거는 `desktop.tray` 선언이 소유하므로 남아 있다.
- [ ] 여러 트레이 아이콘과 고유 ID, Windows GUID를 지원한다.
- [x] 사용자 정의 메뉴와 메뉴의 동적 교체, 제거를 지원한다. `menu.setTrayMenu`로 공유 메뉴 리소스를 연결한다.
- [x] 왼쪽, 오른쪽, 가운데 버튼의 down/up, double-click과 context-menu 알림을 `tray.input` 및 창 없는 백엔드 `waitForEvent`로 전달한다.
- [x] 처리 시 관측한 포인터 위치와 `tray.getBounds`의 shell 물리 bounds를 제공한다. 조회 실패는 null이다.
- [x] 트레이 mouse enter/leave/move를 클릭 계열 `tray.input`과 분리한 `tray.hover` 이벤트(`{ state, position }`)로 제공한다. hover 대기 함수는 없다. 첫 `WM_MOUSEMOVE`가 enter, 이후는 50ms 스로틀 move이며, leave는 100ms 타이머로 커서와 `Shell_NotifyIconGetRect`를 비교해 판단한다(최대 약 100ms 지연). 영역을 읽지 못하면 200ms 동안 move가 없을 때 leave이며 지연은 최대 약 300ms다.
- [x] `tray.setClickBehavior`로 오른쪽 메뉴 표시와 왼쪽 창 복원 동작을 설정한다.
- [x] `tray.focus`로 OS의 트레이 focus 요청 결과를 반환한다.
- [x] 트레이에서 지정 위치의 팝업 메뉴 열기와 닫기를 제공한다. `tray.popUpContextMenu({ position? })`가 `menu.setTrayMenu`로 연결한 메뉴를 물리 화면 좌표(생략하면 포인터)에 표시하고 선택은 `menu.clicked`(windowId null)로 전달한다(Electron `tray.popUpContextMenu`). 닫기는 호출의 AbortSignal 취소이며 `CANCELLED`로 끝난다. 별도 `closeContextMenu` 작업은 모달 루프 중 일반 요청을 처리할 수 없어 제공하지 않는다. 연결한 메뉴가 없으면 `INVALID_ARGUMENT`, 팝업 중 재호출은 `BUSY`이며 우클릭 팝업과 foreground 설정, WM_NULL 전송을 공유한다. 호출마다 다른 메뉴를 넘기는 `menu` 인자는 제공하지 않는다.
- [x] Windows balloon 표시와 제거, show/click/closed 이벤트를 제공한다. `tray.displayBalloon({ title, content, iconType?, silent? })`(제목 63, 본문 255 UTF-16 단위, 큰 아이콘과 사용자 지정 아이콘 제외)와 `tray.removeBalloon`, `tray.balloon`(`{ state: "show" | "click" | "closed" }`)이며 Electron의 displayBalloon에 대응한다(옵션 이름 `silent`, 빈 제목 허용, 기본 아이콘 `none`이 다르다). 성공은 shell의 요청 수락이고 실제 표시는 `show`로만 알 수 있다.
- [ ] 트레이 자원 제거 뒤 숨긴 앱의 실행 유지와 종료 규칙을 정의한다.

실행 중 제어의 입력과 소유권은 [tray API](./site/src/content/docs/reference/plugins/tray.mdx)를 따른다.
실제 shell 회귀의 합성 입력과 재등록 알림은 물리 마우스와 Explorer process 재시작 검증을 대신하지 않는다.

## 07. 메뉴와 키보드 단축키

우선순위 P1. 소유자: 메뉴는 선택 데스크톱 API, 전역 단축키는 공식 플러그인 후보.
출처: [T-menu], [E-menu], [E-menu-item], [E-shortcut], [T-global-shortcut].

- [x] 창별 메뉴바를 연결, 교체, 조회하고 분리한다.
- [ ] 앱 전체 기본 메뉴바를 자동으로 연결한다.
- [x] 메뉴바 visible을 설정하고 조회한다. `menu.setWindowMenuVisible({ windowId, visible })`와 `menu.getWindowMenuVisible({ windowId })`가 창별 값(기본 true)을 다룬다(Electron `setMenuBarVisibility`, `isMenuBarVisible`). 숨기면 `SetMenu(hwnd, NULL)`로 HMENU만 분리하고 트리와 연결은 유지하며, 다시 표시하면 같은 트리를 붙인다. 창 바깥 크기는 그대로이고 내용 영역이 메뉴바 높이만큼 커진다. 숨긴 상태의 연결과 교체도 숨김을 유지하고, 메뉴 없는 창의 값도 저장해 이후 연결에 적용한다. 닫힌 창은 조회할 수 없다. 계약은 `window-menu.test.ts`, 실제 HMENU 분리와 재연결과 내용 영역 크기는 `windows-window-menu.test.ts`가 검증한다.
- [ ] 메뉴바 auto-hide(Alt 키로 임시 표시)를 설정하고 조회한다.
- [x] 지정 창과 물리 화면 좌표에 컨텍스트 메뉴를 표시하고 선택 또는 취소로 닫는다. AbortSignal 취소로 닫으며 별도 close 작업은 제공하지 않는다.
- [x] 공유 메뉴 리소스에서 일반, separator, checkbox, radio와 submenu 항목을 제공한다.
- [x] 메뉴 icon 항목을 제공한다. `type: "item"`(role 포함)과 submenu의 선택 필드 `icon`(tray `setIcon`과 같은 base64 ICO, null이면 없음)이며 checkbox, radio, separator는 `INVALID_ARGUMENT`로 거부한다(Electron `MenuItem.icon`, Tauri `IconMenuItem`). `SM_CXSMICON` 크기의 32bpp premultiplied-alpha DIB section을 메뉴 인스턴스마다 만들어 `hbmpItem`에 설정하고 인스턴스 해제 때 DeleteObject한다. 잘못된 ICO는 `INVALID_ARGUMENT`, 비트맵 생성 실패는 `INTERNAL`.
- [x] 메뉴 리소스 ID 조회, create, replace, remove와 목록 조회, 항목 insert와 remove를 제공한다. `insert`의 index 0과 배열 길이로 prepend와 append를 처리한다.
- [x] 메뉴 리소스의 항목 label, enabled, visible와 checked를 실행 중 변경한다. 연결한 트레이의 다음 팝업과 창 메뉴바에 반영한다.
- [x] 메뉴 항목 icon을 실행 중 변경한다. `updateItem.changes.icon`(ICO bytes | null)이며 다른 변경과 같이 연결된 트레이의 다음 팝업과 창 메뉴바에 반영한다.
- [x] 트레이 메뉴 선택을 `menu.clicked`로 전달한다. 앱 창에 속하지 않아 `windowId`는 null이다.
- [x] 창 메뉴바와 컨텍스트 팝업 선택을 `menu.clicked`로 전달하고 소유 windowId를 포함한다.
- [x] accelerator, 표시 문자열과 실제 등록 여부를 구분한다. item, checkbox, radio의 선택 필드 `accelerator`(`Ctrl+Shift+N` 형식, `updateItem.changes`로 변경, null이면 없음)는 항목 오른쪽에 그리는 표시 문자열일 뿐이며 단축키를 등록하거나 실행하지 않는다(키 처리는 앱 책임). 등록과 WebView 키 입력 우선순위는 아래 단축키 항목에서 다룬다.
- [x] Undo, Redo, Cut, Copy, Paste, Select All 등 기본 menu role을 제공한다. 6개 role을 `type: "item"`의 선택 필드로 두고, 선택하면 창 WebView의 포커스된 document에 CDP `Runtime.evaluate`와 `document.execCommand`로 실행한다(키 이벤트 없음, paste는 호스트가 읽은 클립보드 텍스트를 `Input.insertText`로 삽입, cross-origin iframe은 건너뜀)(`menu.clicked`와 click waiter 없음). label을 생략하면 Electron 기본 label과 단축키 표시를 쓰며 트레이 메뉴의 role은 `INVALID_ARGUMENT`로 거부한다.
- [ ] About, Quit, 창 전환과 도움말 등 플랫폼 기본 메뉴 항목을 제공한다.
- [ ] 메뉴 sublabel과 접근성 label의 플랫폼별 지원을 결정한다.
- [x] Windows 전역 단축키를 하나 또는 여러 개 등록한다. `globalShortcut.register`와 `registerMany`를 제공한다.
- [x] Windows 전역 단축키의 등록 상태 조회, 목록, 개별 해제와 전체 해제를 제공한다.
- [x] Windows에서 등록 목록을 유지한 채 전역 단축키 처리를 일시중지, 재개하고 중지 상태를 조회한다.
  [E-shortcut-live]의 `setSuspended`와 `isSuspended`는 최신 문서상 Electron 42.0.0 이상이다.
  중지 중 입력 미전달, 신규 등록 실패, 기존 등록 상태 유지, 재개 후 입력 전달과 반복 호출을 검증한다.
  플랫폼별 구현 가능 범위와 종료 시 등록 해제도 확인한다.
- [x] Windows 전역 단축키의 `globalShortcut.pressed` 이벤트와 명시적 key/modifiers 조합을 제공한다.
- [x] 전역 단축키의 `globalShortcut.released` 이벤트를 제공한다. RegisterHotKey는 키 해제를 알리지 않으므로 WM_HOTKEY 뒤 짧은 WM_TIMER로 주 키의 GetAsyncKeyState를 확인한다.
  별도 이벤트라서 `pressed`만 허용한 기존 뷰는 영향이 없다. 폴링 주기만큼 늦고 보안 데스크톱 전환 시 조기 발행될 수 있으며, 실제 물리 키보드 검증은 남아 있다.
- [x] Windows 단축키 충돌, F12와 OS 예약 키, 중복 등록, batch rollback과 종료 정리를 처리한다.
- [ ] WebView 포커스 시 메뉴 단축키와 UI 입력의 우선순위를 정의한다.

전역 단축키의 입력, 권한, 중지와 실패 복구 계약은 [globalShortcut API](./site/src/content/docs/reference/plugins/global-shortcut.mdx)를 따른다.
실제 RegisterHotKey와 SendInput 회귀를 Windows CI 실행기에 포함한다.
물리 키보드와 키보드 레이아웃별 사용자 입력, 다른 플랫폼은 별도 검증과 구현이 남아 있다.

공유 메뉴 계약과 트레이 연결은 [menu API](./site/src/content/docs/reference/plugins/menu.mdx)를 따른다.
실제 HMENU와 창 없는 UI Worker 회귀, 창 메뉴바 연결과 분리, 실제 Worker 컨텍스트 팝업 취소 회귀를 Windows 테스트에 포함한다.
메뉴바 자동 숨김, 편집 role과 accelerator는 미구현이다. 다중 행 메뉴바의 최소/최대 크기, 최소화 복원과 혼합 DPI는 별도 검증이 남아 있다.
사용자 포인터와 키보드 메뉴 조작, Explorer 재시작 중 사용자 정의 메뉴는 수동 검증이 남아 있다.

## 08. 로그인 시 자동 실행

우선순위 P1. 소유자: 공식 autostart 플러그인. 출처: [T-autostart], [E-app].

- [x] 로그인 시 실행을 사용자 HKCU Run에 등록하고 해제한다.
- [x] 등록 여부와 저장된 실제 실행 경로, 인자 상태를 조회한다.
- [x] 로그인 시작에 전달할 인자를 Windows argv 규칙으로 인코딩한다.
- [x] 숨김 시작 옵션과 트레이 수명주기를 연결한다. 트레이가 없는 등록과 시작은 거부하며 초기 SDK 준비도 창을 표시하지 않는다.
- [x] `onOpen.launchReason`으로 수동 실행과 자동 실행 호출 모드를 구분한다. 실행 인자 기반 메타데이터이며 Windows 로그인 출처의 인증이 아니다.
- [ ] 실제 로그아웃과 로그인에서 숨김 시작, 사용자 비활성화와 트레이 복원을 대화형 검증한다. CI의 직접 실행은 이 검증을 대신하지 않는다.
- [x] 사용자 범위 등록을 기본으로 하고 관리자 범위는 제공하지 않는다.
- [x] 앱 이동과 업데이트 후 명시적 재등록으로 오래된 경로와 인자를 갱신한다.
- [x] 제거 시 현재 ID의 등록을 해제하고 ID 변경 전 등록을 정리하는 설치 계약을 연결한다. Inno `UninstallAutostart`와 소유자 정리를 사용한다.
- [x] Windows 작업 관리자에서 사용자가 비활성화한 상태를 별도로 조회하고 갱신 시 보존한다.
- [x] 설치 프로그램의 opt-in 설정과 런타임 설정을 연결한다. Inno `unchecked checkedonce`와 `DesiredAutostartCommand`를 사용한다.
- [ ] MSIX manifest StartupTask와 사용자 동의 계약을 구현한다.

현재 `@bunaway/plugin-autostart`는 개발과 배포 앱 ID를 분리하며 등록 변경과 조회 권한도
분리한다. 전체 Run 명령줄은 260 UTF-16 코드 단위 이하다. Windows 활성 상태를
판독할 수 없으면 `unknown`이며 등록 존재 여부와 같다고 추정하지 않는다. 재등록은
Windows의 비활성화 기록을 수정하지 않는다.
[공개 계약](./site/src/content/docs/reference/plugins/autostart.mdx)과
[등록 방식 결정](./decisions/0016-windows-autostart.md)을 따른다.

## 09. OS 셸, 파일 연결과 작업 표시줄

우선순위 P1, 작업 표시줄 고급 기능은 P2. 소유자: opener/deep-link 플러그인과 패키저, 창 연동은 호스트.
출처: [E-shell], [E-app], [E-window], [T-opener], [T-deep-link].

- [x] 기본 브라우저에서 HTTP/HTTPS URL을 연다.
  `@bunaway/plugin-opener`의 `openUrl`과 `opener.openUrl`
  권한을 제공한다. Explorer에 실행을 위임하며 성공은 요청 접수를 뜻한다.
  커스텀 스킴과 지정 앱 열기는 지원하지 않는다.
  공개 계약은 [opener 문서](../plugins/opener/README.md)를 따른다.
- [x] `openFile`로 기본 연결 앱에서 파일을 연다. `opener.openFile` 권한과 유효한 절대 파일 경로를 요구한다.
- [x] `revealFile`로 Explorer에서 파일을 선택해 표시한다. `opener.revealFile` 권한과 유효한 절대 파일 경로를 요구한다.
  두 작업은 Unicode와 공백을 보존하며 파일 소실, 접근 거부와 OS 요청 실패를 반환한다.
  성공은 요청 접수이며 실제 앱 실행이나 Explorer 선택 완료를 뜻하지 않는다.
  현재 파일 검사와 셸 요청은 I/O Worker에서 실행한다. 기록된 Windows STA와 compiled EXE
  실행 결과는 초기 UI Worker 구현의 근거이며, 이관 후 구현의 실행 근거로 확대하지 않는다.
  계약 검사와 초기 실행 결과, 이관 후 검증 범위는
  [실행 기록](./architecture/windows-bun-results.md#2026-10-10-opener-파일-작업)에 구분한다.
- [x] `openFileWith`와 `openUrlWith`로 지정한 절대 `.exe` 앱에 파일과 HTTP/HTTPS URL 하나를 전달한다. 작업별 권한과 앱 및 파일 검사, Windows argv 인코딩을 제공하고 Explorer에 실행을 위임한다. 기본 연결은 변경하지 않는다. 실제 Windows 회귀는 CI의 `mise run host:windows`에서 수행하며 앱 표시와 수동 검증 완료를 뜻하지 않는다.
- [x] `trashFile`로 로컬 고정 드라이브의 파일을 휴지통으로 보내고 실패를 반환한다.
  `opener.trashFile` 권한과 기존 파일 검사를 적용한다. 휴지통 플래그가 없는 삭제 직전 콜백은 거부하고
  휴지통 이동 실패를 일반 삭제로 재시도하지 않는다. 성공은 OS가 휴지통 항목을
  반환했음을 뜻한다. UNC, 이동식 드라이브와 디렉터리는 지원하지 않는다.
  부모를 고정하고 삭제 직전 파일 ID를 다시 확인하지만 마지막 검사 이후의
  파일 자체 교체 경쟁은 남는다. Windows 네이티브 회귀는 `host:windows`에 포함한다.
  실제 Windows 실행 결과와 휴지통 비활성화, 용량 초과 및 경고 UI 수동 검증은 별도 확인이 필요하다.
- [ ] 휴지통 비활성화, 용량 초과와 영구 삭제 경고 UI의 동작을 실제 Windows에서 검증한다.
- [x] Windows 바로가기 생성, 읽기와 변경을 제공한다.
  `opener.readShortcutLink(path)`와 `opener.writeShortcutLink(path, details, operation)`이
  `IShellLinkW`와 `IPersistFile`로 `.lnk`의 `target`, `cwd`, `args`, `description`, `icon`,
  `iconIndex`를 읽고 쓴다(Electron `shell.readShortcutLink`, `shell.writeShortcutLink`).
  `create`는 새로 쓰거나 덮어쓰고, `replace`는 기존 바로가기를 덮어쓰며, `update`는 입력에 있는
  속성만 바꾼다. 경로 검사와 핸들 고정은 다른 파일 작업과 같다. 읽기와 쓰기는 별도 권한
  `opener.readShortcutLink`, `opener.writeShortcutLink`를 요구한다. AppUserModelID와 toast
  activator는 AppUserModelID 항목에서 다룬다. Windows 실행은 `host:windows`의
  `windows-opener-shortcut` 회귀가 속성 왕복, 부분 갱신, 오류와 junction 거부를 확인한다.
- [x] OS beep와 이모지 패널의 지원을 결정한다.
  `os.beep`은 `MessageBeep`로 default(`MB_OK`, Windows Default Beep), info, warning, error 소리를 재생하며 독립 `os.beep` 권한을 쓴다.
  이모지 패널은 Windows에 공식 API가 없고 Win+. 키 합성만 가능하므로 지원하지 않는다.
  Windows 실행은 `host:windows`의 `windows-os` 회귀에서 호출 성공만 확인하며 실제 소리 출력은 검증하지 않는다.
- [x] URL scheme을 등록, 해제하고 기본 처리 앱 여부를 조회한다.
  설치의 opt-in 처리 후보 등록과 제거는 구현했다. `opener.registerUrlScheme`, `unregisterUrlScheme`, `isUrlSchemeRegistered`는 `HKCU\Software\Classes`에 이 앱의 소유 표식과 명령을 쓰고, 조회는 그 등록이 온전한지만 읽는다. 사용자의 기본 앱 선택을 반영한 실제 처리 앱은 `getUrlHandler`가 알려 준다.
- [x] 파일 확장자, MIME, 표시 이름과 앱 EXE의 파일 아이콘을 설치에 등록한다.
- [x] 설치와 제거에서 앱이 소유한 처리 후보를 정리하고 기존 기본 앱 설정을 존중한다.
  Inno `associations` 작업은 새 설치에서 선택하지 않는다. 업데이트의 실행 파일명 변경,
  선언 제거와 선택 해제는 이전 후보를 정리한다. 기본값과 UserChoice는 쓰지 않는다.
  선택한 후보의 충돌을 설치와 이전 등록 정리 전에 검사하고 설치 후 레지스트리 실패도
  0이 아닌 종료 코드로 반환한다. 일부 등록의 자동 롤백은 제공하지 않는다.
  Windows 기본 앱 설정에서 선택 후 실제 파일과 링크 실행은 별도 수동 검증으로 남긴다.
- [x] URL의 연결 앱 이름과 실행 정보를 조회한다.
  `opener.getUrlHandler(url)`은 `openUrl`과 같은 URL 검증 뒤 scheme 기준으로
  `AssocQueryStringW(ASSOCF_IS_PROTOCOL)`을 호출해 `{ name, path }`(표시 이름과 실행 파일 경로)를
  반환하며 처리 앱이 없으면 `null`이다. 앱을 실행하지 않고 URL도 열지 않는다. 파일 경로가
  노출되므로 `opener.openUrl`과 분리된 `opener.getUrlHandler` 권한을 요구한다. 아이콘은
  반환하지 않으며 HTTP와 HTTPS scheme만 조회한다. 조회 실패, 빈 값, 상한 초과와 제어 문자는
  Electron과 Chromium처럼 실패 코드를 구분하지 않고 모두 `null`이다. macOS는 지원하지 않는다.
  Windows 실행은 `host:windows`의 opener lifecycle 회귀가 결과 구조와 연결 없음 `null`만
  확인하며, 처리 앱의 종류는 환경별로 다르다. 오류 분류는 `api` 단위 테스트가 검증한다.
- [ ] AppUserModelID와 toast activation 식별자를 설정하고 설치와 일치시킨다.
- [x] Recent Documents의 추가와 삭제를 제공한다. 조회는 지원하지 않는다.
  `opener.addRecentDocument`는 기존 파일 확인 뒤 `SHAddToRecentDocs(SHARD_PATHW)`를,
  `opener.clearRecentDocuments`는 `SHAddToRecentDocs(NULL)`을 호출해 사용자의 셸 최근 항목
  전체를 지운다(다른 앱 항목 포함, 앱 범위 아님). 각각 작업 권한을 요구하며 성공은 요청
  전달이다. 점프 목록 연결은 AppUserModelID 이후의 작업이다. 조회는 공식 API가 없고
  Recent 폴더의 `.lnk`가 앱별로 구분되지 않아 제공하지 않는다.
- [ ] Jump List와 사용자 task, category, 제거된 항목 조회를 제공한다.
- [x] 작업 표시줄 progress와 상태를 설정한다.
  `windows.setTaskbarProgress`는 창별 `none`, `indeterminate`, `normal`, `paused`, `error`를
  적용하며 determinate 상태에는 0~1의 진행률을 요구한다. 작업 권한과 창 수명을 검사하고
  작업 표시줄 버튼 생성 전에는 `BUSY`, 네이티브 실패에는 `INTERNAL`을 반환한다.
  Explorer 버튼 재생성 때 마지막 성공 값을 다시 적용하고 HWND 파괴 때 폐기한다.
  계약 및 수명 검사는 `window-taskbar.test.ts`, `taskbar-progress.test.ts`이며 실제 UI Worker와
  ITaskbarList3 호출은 기존 `windows-bun-window-api.ts`의 `host:windows` 회귀에 포함한다.
- [ ] 실제 Windows 작업 표시줄에서 진행률, 상태 색상, 그룹 우선순위와 Explorer 재시작 후 표시를 확인한다.
  네이티브 호출 회귀와 합성 버튼 재생성 검사를 물리 화면의 표시 검증으로 간주하지 않는다.
- [x] overlay icon과 접근성 설명을 설정한다.
  `windows.setOverlayIcon`은 창별로 `ico`(`tray.setIcon`과 같은 base64 ICO, `null`이면 제거)와
  `description`(`setThumbnailToolTip`과 같은 문자열 규칙, `ico`가 `null`이면 무시)을 받으며 Electron의
  `setOverlayIcon(overlay, description)`에 대응한다. ICO에서 창 DPI의 작은 아이콘 크기에 맞는 프레임으로
  HICON을 만들어 `ITaskbarList3::SetOverlayIcon`에 넘기고 다음 설정, 제거, 창 파괴 때 `DestroyIcon`으로 해제한다.
  작업 권한과 창 수명을 검사하고 버튼 생성 전에는 `BUSY`, 잘못된 ICO는 `INVALID_ARGUMENT`, 네이티브 실패는 `INTERNAL`,
  macOS는 `UNSUPPORTED`다. 버튼 재생성 때 마지막 성공 값을 다시 적용하고 HWND 파괴 때 폐기한다.
  ICO 검증과 HICON 생성은 windows 플러그인의 Windows 플랫폼 코드가 맡고 호스트는 아이콘 공급자를 받아 수명만 관리한다.
  계약 검증은 `window-overlay-icon.test.ts`, ICO 거부와 수명은 `taskbar-overlay-icon.test.ts`이며 실제 ITaskbarList3 호출은
  `windows-bun-window-api.ts`의 `host:windows` 회귀에 포함한다.
- [ ] thumbnail toolbar 버튼과 클릭 이벤트를 제공한다.
- [x] thumbnail clip과 tooltip을 설정한다.
  `windows.setThumbnailClip`은 내용 영역 기준 96 DPI 논리 픽셀 region(`null`이면 해제)을,
  `windows.setThumbnailToolTip`은 `setTitle`과 같은 형식의 문자열(`null` 또는 빈 문자열이면 해제)을 설정한다.
  작업 권한과 창 수명을 검사하고 버튼 생성 전에는 `BUSY`, 내용 영역을 넘는 region은 잘라 적용하고 비면 `INVALID_ARGUMENT`,
  macOS는 `UNSUPPORTED`다. 버튼 재생성 때 마지막 성공 값을 다시 적용하고 HWND 파괴 때 폐기한다.
  계약 검증은 `window-thumbnail.test.ts`, 변환과 복원은 `taskbar-thumbnail.test.ts`이며 실제 ITaskbarList3 호출은
  `windows-bun-window-api.ts`의 `host:windows` 회귀에 포함한다.
- [ ] 창별 앱 표시 이름, relaunch 명령과 아이콘을 설정한다.
- [x] Windows elevation과 de-elevation 실행 요구사항의 지원 범위를 결정한다. 상승은 `perMachine` 설치 프로그램에만 둔다. 설치 뒤 앱 실행은 `runasoriginaluser`로 상승 전 사용자 토큰을 쓴다. 앱 내부 상승 실행 API는 제공하지 않는다. [ADR 0023](./decisions/0023-windows-elevation.md)을 따른다. 생성한 설치 스크립트의 실행 항목은 `tests/packaging/windows.test.ts`가 확인한다.

## 10. 알림

우선순위 P1. 소유자: 공식 notification 플러그인 후보, 외부 활성화 전달은 호스트.
출처: [E-notification], [T-notification].

- [x] Windows toast API 지원 여부와 앱, 사용자, 정책의 알림 차단 상태를 조회한다.
- [ ] 필요한 OS 권한 요청의 플랫폼별 계약을 제공한다. Windows 데스크톱 경로에는 알림 동의 팝업이 없으며 설정 변경은 사용자에게 맡긴다.
- [x] 제목과 본문의 text-only toast, silent와 popup 억제 옵션을 제공한다.
- [x] 아이콘, 본문 이미지(inline/hero)와 시스템 소리를 제공한다. 이미지는 로컬 절대 경로, 확장자(png, jpg, jpeg, gif), 고정 드라이브, 디렉터리와 클라우드 파일 거부(링크는 따라감), 3,000,000바이트 검사 후 file URI로 전달하고, Windows 비패키지 앱은 임의 소리 파일을 재생할 수 없어 `ms-winsoundevent` 시스템 소리 이름과 loop만 지원한다. `silent`와 `sound`는 함께 줄 수 없다.
- [x] 실행 중 native clicked, dismissed와 failed callback을 전달한다. Show 접수는 반환값으로 구분한다.
- [ ] 실제 popup 표시 완료 이벤트와 사용자 클릭의 GUI 검증을 제공한다.
- [x] 앱 범위 ID/group, 같은 ID 교체와 개별 clear를 제공한다. 종료 시 이번 실행의 알림을 정리한다.
- [ ] 액션 버튼과 인라인 응답 입력을 제공한다.
- [ ] 앱이 종료된 상태의 toast activation을 앱 시작과 `onOpen`에 연결한다.
- [ ] timeout과 표시 우선순위의 플랫폼별 동작을 정의한다. silent는 Windows에서 구현했다.
- [ ] Windows toast XML과 고급 알림 콘텐츠의 지원을 결정한다.
- [ ] OS에 남은 알림 조회와 그룹, 전체 제거의 플랫폼별 지원을 결정한다. Windows 개별 ID/group 제거, 앱 전체 제거(`notification.clearAll`)와 남은 알림 조회(`notification.list`)는 구현했다. group 단위 제거는 남아 있다.
- [ ] 예약 알림과 pending 조회, 취소의 플랫폼별 지원을 제공한다.
- [ ] 첨부 파일과 클릭 액션 종류를 등록한다.
- [x] Windows 알림 설정 페이지로 이동하는 요청과 사용자에 의한 차단 상태를 제공한다.

`@bunaway/plugin-notification`은 현재 호스트 앱 ID로 WinRT `ToastNotifier.Setting`을
조회하며 `notification.getStatus`와 `notification.openSettings` 권한을 분리한다.
설정 열기는 `ms-settings:notifications` 요청 접수이며 동의나 설정 변경 완료를 뜻하지 않는다.
`show`와 `clear` 및 실행 중 callback 전달을 구현했다. shortcut/COM activator 등록과
종료 상태의 activation 전달은 아직 구현하지 않았다.
시작 메뉴 바로가기를 생성하지 않는 기존 설치 선택도 보존한다. 조회에는 설치 바로가기의
AppUserModelID 등록과 같은 process AppUserModelID가 필요하며 첫 알림 전에는 OS 알림 상태도
없을 수 있다. Windows가 상태를 찾지 못하면 `UNSUPPORTED`로 거부하며 조회는 알림을 보내거나
상태를 초기화하지 않는다. 기존 상태의 배포/개발 동일 ID 조회는 같은 OS 설정을 읽으며
`enabled`는 toast 표시나 activation 가능성을 보장하지 않는다. 네이티브 회귀는 격리된
프로세스의 임시 UUID 시작 메뉴 바로가기와 popup 억제/15초 만료 알림으로 실제 상태를 준비한
뒤 조회한다. 임시 알림은 성공과 실패 모두 history에서 제거하며 바로가기도 정리한다.
MSIX의 패키지 식별자 연동은 후속 범위다. 공개 계약과 네이티브 검증 범위는
[notification 문서](../plugins/notification/README.md)를 따른다.

## 11. 대화상자와 파일 선택

우선순위 P1. 소유자: 공식 dialog 플러그인. 출처: [E-dialog], [T-dialog].

- [x] 메시지, 확인, 오류와 사용자 버튼 대화상자를 제공한다.
- [x] 버튼 결과, 기본 버튼, cancel 버튼과 ESC 동작을 정의한다.
- [x] 상세 메시지와 checkbox 결과를 제공한다.
- [x] 파일 열기와 저장 대화상자를 제공한다.
- [x] 폴더 선택, 다중 파일과 폴더 선택을 제공한다.
- [x] 파일 형식 필터, 기본 경로와 파일 이름, 기본 확장자를 제공한다.
- [x] 숨긴 파일 표시와 저장 overwrite 확인 옵션을 제공한다. 새 폴더 생성은 OS 기본 UI를 유지하며 Windows에서 끄는 옵션은 지원하지 않는다.
- [x] 부모 창을 지정해 모달 대화상자를 연결한다.
- [x] 선택 취소, 호출 취소와 부모 창 종료의 결과를 정의한다.
- [x] 선택한 파일 접근 권한의 수명과 영속화 여부를 정의한다.
- [x] 결정 완료: 인증서 신뢰 확인 대화상자는 제공하지 않는다. Electron `showCertificateTrustDialog`는 인증서 검증 처리기의 인증서 객체가 입력인데 이 프로젝트에는 그 인증서 경로가 없고 Tauri에는 대응 기능이 없다. WebView 인증서 오류와 신뢰 판단은 16절 항목이 소유한다.
- [x] 결정 완료: 동기 대화상자는 제공하지 않는다. 모든 dialog 작업이 이미 Promise이고 대화상자 중에도 앱 백엔드가 계속 실행되므로 동기 변형을 두지 않는다. 작업 집합은 dialog 계약 테스트가 고정한다.

`@bunaway/plugin-dialog`의 구현과 계약, 큐 및 취소 의미는 [dialog 문서](../plugins/dialog/README.md)를 따른다.
경로 선택은 저장소 접근 권한을 추가하지 않는다. 실제 사용자 입력, 숨김 항목 표시와 overwrite UI, 다중 선택 UI,
실제 소유 창 파괴는 별도 검증이다. 메시지 대화상자(`dialog.showMessage`)의 실제 TaskDialog 입력도
별도 네이티브 검증이다.

## 12. 클립보드와 이미지 리소스

우선순위 P1. 소유자: clipboard 플러그인과 공통 이미지 리소스 API 후보.
출처: [E-clipboard], [E-image], [T-clipboard], [T-image].

- [x] 클립보드 텍스트 읽기, 쓰기와 지우기를 제공한다. `@bunaway/plugin-clipboard`의 작업별 권한, Unicode와 크기 제한, 빈 값, 점유와 취소, 소유권 정리를 정의했다. 2026-10-10 Windows x64의 공통 SDK와 실제 UI Worker 왕복, 별도 프로세스 점유와 취소를 검증했다([계약과 검증](../plugins/clipboard/README.md)).
- [x] Windows clipboard의 `readImage`와 `writeImage`로 bounded RGBA 이미지 읽기와 쓰기를 제공한다. 공통 이미지 리소스 API와 다른 앱의 붙여넣기 검증은 별도 작업이다.
- [x] Windows clipboard의 HTML fragment, ASCII RTF와 wide 파일 목록 읽기와 쓰기를 제공한다. 파일 목록은 저장소 접근 권한을 추가하지 않는다.
- [x] Windows clipboard의 bookmark(`application/x-bunaway-bookmark`) 형식 읽기와 쓰기를 제공한다. URL만 포함하며 title과 열기는 없다.
- [x] `getFormats`와 `hasFormat`으로 지원하는 다섯 MIME 형식의 가용성을 조회한다. 임의 Windows 등록 형식의 열거는 포함하지 않는다.
- [x] `readFormats`와 `writeFormats`로 한 번의 clipboard 열기 구간에서 여러 형식을 읽거나 교체한다. 준비 실패는 기존 내용을 보존하며 비우기 이후 부분 등록 실패는 되돌리지 않는다.
- [x] Windows clipboard의 사용자 정의 binary 형식(`application/x-bunaway-binary/...`) 읽기와 쓰기를 제공한다. 형식당 256 KiB, 어댑터 수명마다 서로 다른 이름 64개까지다.
- [x] Windows clipboard의 변경 이벤트(`clipboard.changed`)와 `waitForChange`를 제공한다. `AddClipboardFormatListener`와 `WM_CLIPBOARDUPDATE`로 감지하며 payload는 내용 없이 `sequence`와 `changedAt`만 담는다. 같은 sequence의 연속 갱신은 합치고 자기 쓰기도 알린다. macOS는 지원하지 않는다([계약](../plugins/clipboard/README.md)).
- [x] Windows `@bunaway/plugin-image`에서 PNG, JPEG와 BMP bytes, RGBA와 data URL로 앱 소유 이미지 리소스를 만든다.
- [ ] 파일 경로에서 이미지 리소스를 읽는 API와 저장소 접근 정책을 연결한다.
- [x] `image.getInfo`와 `image.getPixels`로 크기, 빈 이미지 여부와 RGBA 픽셀 데이터를 조회한다.
- [x] `image.exportBytes`와 `image.exportDataURL`로 PNG, JPEG, BMP와 data URL을 내보낸다. PNG는 alpha를 보존하고 JPEG와 BMP는 불투명 픽셀만 받는다.
- [x] `image.crop`과 `image.resize`로 소스와 분리된 새 이미지 리소스를 만든다. Windows resize는 nearest와 alpha를 고려한 linear filtering을 제공한다.
- [ ] 한 이미지 ID의 scale-factor별 representation 그룹과 선택 API를 제공한다.
- [x] `image.createFileTypeIcon`으로 확장자와 크기(16, 32, 48)만 받아 파일 형식 아이콘을 생성한다. `SHGFI_USEFILEATTRIBUTES`로 디스크에 접근하지 않으므로 저장소 권한이 필요 없고 실제 경로는 받지 않는다. macOS는 `UNSUPPORTED`이다.
- [ ] 실제 파일 기반 이미지 thumbnail을 생성한다. 파일 경로 접근 정책(저장소 scope와 권한)이 먼저 정해져야 한다.
- [x] 앱 소유 이미지 ID, `image.dispose`, 결과 전달 전 생성 취소와 앱 종료 정리를 제공한다. 작업별 권한과 64개, 8 MiB 상한을 적용한다.

2026-10-12 clipboard 확장은 `defineNativePlugin`과 Zod 계약, 작업별 권한, 입력과 출력 상한,
빌린 메모리의 복사와 해제, 다중 형식의 부분 실패 정리를 포함한다. 실제 Windows 회귀는
CI의 `mise run host:windows`에서 SDK와 UI Worker, Win32를 연결해 실행하도록 추가했다.
구현 표시와 검증 결과는 구분하며 정확한 head CI 결과를 확인한다. 다른 앱의 붙여넣기,
최소 OS와 하드웨어 검증, 공통 이미지 리소스의 생성, 변환과 명시적 해제는 완료하지 않았다.

## 13. 모니터, 테마, 접근성과 전원

우선순위 P1, 전원 고급 기능은 P2. 소유자: 창에 연결된 기능은 호스트, 독립 OS 기능은 플러그인 후보.
출처: [T-window], [E-screen], [E-theme], [E-system], [E-power], [E-power-blocker].

- [x] Windows에서 전체, 주, 대상 창의 현재 모니터를 조회한다.
- [x] Windows에서 물리 점과 사각형에 가장 가까운 모니터를 조회한다.
- [x] Windows에서 모니터 장치명과 이름, bounds, work area, DPI와 배율, 드라이버가 제공하는 rotation과 정수 refresh rate를 조회한다.
- [x] Windows에서 모니터 추가, 제거와 display metrics 변경 이벤트 및 versioned snapshot 복구를 제공한다.
- [x] Windows 커서의 물리 화면 좌표를 조회한다. 창 기준 physical/logical 변환은 기존 toLogical과 toPhysical을 사용한다.
- [ ] 모니터별 좌표 변환과 혼합 DPI의 전역 논리 좌표계 지원 범위를 결정한다.
- [x] system/light/dark 테마를 앱과 창에 지정하고 조회한다. 네이티브 프레임과 WebView 콘텐츠의 `prefers-color-scheme`에 앱 기본값과 창 override를 적용한다. 같은 WebView2 프로필의 창은 콘텐츠 값을 공유한다.
- [x] 테마, accent color와 시스템 색 변경을 알린다. appearance.changed는 고대비와 접근성 설정도 포함하며 동일 값은 생략한다.
- [x] Windows 고대비와 OS forced colors 플래그, 시스템 색을 조회한다.
- [x] inverted colors 상태를 조회한다.
  `invertedColors`는 Electron `nativeTheme.shouldUseInvertedColorScheme`에 맞춰 고대비가 켜져 있고 COLOR_WINDOW가 어두울 때 true이며, macOS는 `accessibilityDisplayShouldInvertColors`를 읽는다. Windows 색 필터는 공개 조회 API가 없어 반영하지 않는다.
- [x] Windows client-area animation 기준 reduced motion과 저장된 transparency 선호를 조회한다.
- [x] Windows SPI_GETSCREENREADER 설정 플래그를 조회한다. 실제 접근성 트리 활성 여부와는 구분한다.
- [x] 스크린 리더 설정 플래그와 UI Automation 클라이언트 활성 상태를 조회한다.
  `appearance.getAccessibilityState`는 신뢰된 백엔드 전용이며 `screenReaderEnabled`(SPI_GETSCREENREADER)와
  `assistiveTechnologyActive`(uiautomationcore.dll의 `UiaClientsAreListening`)를 반환한다. 후자는 Electron
  `app.accessibilitySupportEnabled`처럼 보조 기술 클라이언트가 접근성 트리를 구독 중인지를 나타내며 설정 플래그와 구분된다.
  uiautomationcore.dll은 첫 조회 때 로드하며 로드 실패 시 이 조회만 UNSUPPORTED이다.
- [ ] UI Automation 클라이언트 연결 변화 이벤트를 제공한다. 연결 변화에 대한 OS 알림이 없고 폴링은 비용이 커서
  보류했다. screenReaderEnabled 변화는 `appearance.changed`가 이미 알린다. 접근성 지원 강제 활성화는 아래 항목이 다룬다.
- [ ] 접근성 지원 활성화와 비활성화를 제어하고 지원 기능을 선택, 조회한다. [E-app-live]의
  `setAccessibilitySupportEnabled`, `getAccessibilitySupportFeatures`, `setAccessibilitySupportFeatures`를 참고한다.
  초기 상태, OS 자동 감지와 명시 설정의 관계, 호출 가능 시점, 빈 목록과 잘못된 기능명을 정의한다.
  대상 WebView에서 설정 후 조회와 실제 접근성 트리를 검증하고 렌더러별 미지원 기능을 명시한다.
- [ ] WebView 접근성 트리와 사용자 타이틀바의 키보드 탐색을 검증한다.
- [x] suspend, resume, 화면 잠금과 잠금 해제 이벤트를 제공한다. power.suspended, power.resumed, power.sessionLocked, power.sessionUnlocked는 빈 payload이며 잠금은 호출 프로세스 세션의 WTS 잠금이다. 권한은 power.statusChanged와 같다.
- [x] Windows AC와 배터리, 충전, 잔량, battery saver 및 수명 추정 상태를 조회한다.
- [x] AC와 배터리 상태 변경 이벤트를 제공한다. power.statusChanged는 전원 상태 변경 알림과 resume에서 재조회하며 동일 값은 생략한다.
- [x] Windows 호출 세션의 입력 idle 시간과 지정 기한의 active/idle 상태를 조회한다. 잠금 여부는 별도 작업이다.
- [x] Windows 시스템 idle 절전과 화면 꺼짐 방지 요청을 시작, 조회하고 해제한다. 사용자 절전과 OS 전원 정책은 우회하지 않는다.
- [x] blocker의 반복 요청을 독립 ID로 관리하고 앱 종료 시 native handle을 자동 정리한다.
- [x] CPU speed-limit, thermal-state와 종료 이벤트의 플랫폼별 지원을 정의한다. `power.getCpuSpeedLimit`은 CallNtPowerInformation(ProcessorInformation)의 프로세서별 MhzLimit/MaxMhz 중 최솟값(0–100 정수)을 반환하며, MaxMhz 0 항목은 건너뛰고 계산할 항목이 없으면 100이다. `speed-limit-change` 이벤트는 제공하지 않고, thermal-state는 macOS 전용 개념이라 Windows 미지원이다. 종료 계열은 기존 suspend, resume, 세션 잠금 이벤트가 범위다.

모니터 id는 현재 Windows 디스플레이 장치명이며 영구 하드웨어 식별자가 아니다.
조회와 변경 구독 API는 [창 API](./site/src/content/docs/reference/host/windows.mdx#모니터와-커서)를 따른다.
`windows.monitorsChanged`는 초기 replay 없이 id별 추가, 제거와 지표 변경 및 오류 복구를 알린다.
구독 뒤 `getMonitorSnapshot`으로 상태를 복구하고 sourceId와 revision으로 순서를 비교한다.
뷰의 이벤트 허용과 snapshot 조회 권한이 모두 필요하다. Windows 디스플레이와 설정 알림을
메시지 처리 뒤 합쳐 관찰하며 주기적으로 조회하지 않는다.
실제 HWND의 합성 알림과 제어한 조회 지표로 추가, 제거 및 오류 복구 계약을 검사한다.
실제 WebView2 회귀는 Core와 SDK 전달, 권한, 구독 해제, 탐색과 창 재생성을 검사한다.
이 합성 입력 검사는 물리 장치의 hotplug 검증을 대신하지 않는다.
실제 HWND와 WebView2 회귀를 CI에 추가했다. 실제 다중 물리 모니터의 연결과 제거,
혼합 DPI, 회전 및 사용자 커서 조작 검증은 별도로 남긴다.

`@bunaway/plugin-power`는 [power API](./site/src/content/docs/reference/plugins/power.mdx)를 따른다.
존재하지 않거나 알 수 없는 배터리 측정값은 null이다. PowerCreateRequest와
PowerSetRequest로 등록하며 display 요청에는 system 요청도 함께 등록한다.
최대 128개이며 등록 실패의 부분 정리와 종료 정리를 처리한다.
실제 Windows 네이티브 회귀를 CI에 추가했다. 물리 배터리 전환, idle 절전과 화면 timeout,
Modern Standby 및 사용자 절전 후 동작은 하드웨어 수동 검증으로 남긴다.

`@bunaway/plugin-appearance`의 getPreferences로 저장된 앱 및 시스템 테마 선호,
DWM accent와 시스템 색, 접근성 플래그를 조회한다. theme와 transparency의 누락 또는
알 수 없는 DWORD는 null이다. [appearance API](./site/src/content/docs/reference/plugins/appearance.mdx)를 따른다.
조회와 프레임 테마 지정, 변경 이벤트 및 실제 Windows 회귀를 추가했다. 접근성 지원 제어와
WebView 접근성 트리 및 실제 보조 기술 검증은 미완료다.
프레임은 앱 기본값과 창별 override를 구분한다. WebView 콘텐츠 테마는 공유 프로필의 색 선호와 창별 override 관계를 결정해야 한다.

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
- [x] 기존 허용 origin 안의 URL 로드, 일반 reload와 stop을 제공한다. `navigateWebView`, `reloadWebView`, `stopWebView`는 기존 세션 폐기와 origin 검사를 유지한다.
- [ ] 로컬 파일 로드와 cache를 무시한 reload를 제공한다.
- [x] `getWebViewState`로 현재 URL, title과 최상위 loading 상태를 조회한다.
- [x] `getWebViewState`의 `focused`로 WebView 포커스를, `isDestroyed`로 창과 같은 수명의 WebView destroyed 상태를 조회한다. 실제 포커스 전환은 CI Windows native integration에서 검증한다.
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
- [ ] zoom을 origin별로 공유할지 WebView별로 독립 관리할지 설정한다. 컨트롤러 `setZoomFactor`/`zoomFactor` 조회는 구현됐다.
- [ ] 브라우저 기본 대화상자, context menu와 zoom hotkey 설정을 제공한다.
- [ ] autofill, password autosave와 HTTP authentication의 명시적 설정을 제공한다.
- [ ] HTML 전체화면과 네이티브 창 전체화면의 연동 및 이벤트를 제공한다.

## 15. WebView 탐색, 편집, 스크립트와 입력

우선순위 P2. 소유자: 렌더러 API. 출처: [E-contents], [E-history], [E-frame], [E-frame-main], [T-webview-rust].

- [x] `goBack`, `goForward`와 `getWebViewState`로 기본 history 이동과 가능 여부 조회를 제공한다.
- [ ] history의 offset과 index 이동을 제공한다.
- [ ] 탐색 history의 조회, 삭제, 전체 초기화와 복원을 제공한다.
- [x] `setZoomFactor`와 `getWebViewState`로 controller zoom factor를 설정하고 실제 값을 조회한다.
- [ ] zoom level과 visual zoom 최소와 최대 한도를 설정하고 조회한다.
- [ ] 페이지 find, 결과 이벤트와 검색 종료를 제공한다.
- [ ] undo, redo, cut, copy, paste, plain-text paste와 select-all을 제공한다.
- [ ] selection 변경, 텍스트 삽입과 교체, scroll-to-top/bottom을 제공한다.
- [ ] 맞춤법 검사 활성화, 언어, dictionary와 사용자 단어를 관리한다.
- [ ] misspelling 조회, suggestion과 교체 API를 제공한다.
- [ ] 신뢰된 앱 백엔드의 JavaScript 실행과 결과 반환 계약을 제공한다. [#158](https://github.com/mathbook3948/bunaway/issues/158).
- [ ] 문서 초기화 script와 CSS 삽입, 제거를 제공한다. [#158](https://github.com/mathbook3948/bunaway/issues/158).
- [ ] isolated world와 preload의 사용 범위, frame별 적용과 자원 정리를 정의한다. [#158](https://github.com/mathbook3948/bunaway/issues/158).
- [ ] WebView에서 Node/Bun을 직접 사용하는 Electron nodeIntegration 옵션의 대체 또는 미지원 결정을 기록한다. [#158](https://github.com/mathbook3948/bunaway/issues/158).
- [ ] frame tree, frame URL과 origin 조회, frame별 작업의 지원 범위를 정의한다. [#158](https://github.com/mathbook3948/bunaway/issues/158).
- [ ] 키보드, 마우스와 wheel의 before-input 이벤트와 취소를 제공한다.
- [ ] 입력 이벤트 주입, cursor 변경과 IME composition의 지원을 결정한다.
- [ ] 파일 drop의 enter, over, leave와 drop 이벤트, 경로와 좌표를 제공한다.
- [ ] WebView의 File 객체와 OS 파일 경로를 안전하게 연결한다.
- [ ] 파일을 앱 밖으로 드래그하고 표시할 drag 이미지를 제공한다.
- [x] `setWebViewAudioMuted`로 음소거를 변경하고 `getWebViewAudioState`로 음소거와 문서의 audio 재생 상태를 조회한다. 두 상태는 독립이며 탐색은 음소거를 유지한다.
- [ ] audio muted와 재생 상태의 변경 이벤트를 제공한다. 실제 장치의 출력과 재생 중 음소거는 수동 검증이 필요하다.
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
  online 상태 조회 `network.isOnline`과 변경 이벤트 `network.onlineChanged`는 구현했다.
  Electron `net.isOnline()`에 대응해 루프백과 link-local이 아닌 주소를 가진 활성 인터페이스 유무만 보고 인터넷 도달은 판단하지 않는다.
  이벤트는 2초 주기 확인으로 Windows에서만 보낸다. host resolve `network.resolveHost`는 Electron `net.resolveHost()`에 대응해
  시스템 리졸버(getaddrinfo)로 구현했다. proxy resolve `network.resolveProxy`는 Electron `session.resolveProxy()`에 대응해
  WinHTTP로 사용자 인터넷 옵션(자동 감지, PAC, 수동 목록과 예외 목록)을 적용한 구조화 목록을 돌려준다. 쿼리 유형, cache와 secure DNS 옵션은 남았다.
- [ ] 오프라인, latency와 bandwidth emulation을 제공한다.
- [ ] preconnect, connection 정리와 network log를 제공한다.
- [ ] 사용자 정의 앱 protocol의 등록, 해제와 등록 상태 조회를 제공한다. [#158](https://github.com/mathbook3948/bunaway/issues/158).
- [ ] protocol 응답에 파일, bytes, text, HTTP와 stream을 사용한다. [#158](https://github.com/mathbook3948/bunaway/issues/158).
- [ ] protocol의 MIME, range, CORS, secure origin과 서비스 워커 지원을 정의한다. [#158](https://github.com/mathbook3948/bunaway/issues/158).
- [ ] protocol과 세션별 정책을 연결하고 origin 검사와 세션 폐기 계약을 유지한다. [#158](https://github.com/mathbook3948/bunaway/issues/158).
- [ ] 로컬 파일 경로를 WebView 표시용 URL로 변환하는 공개 기능을 제공한다. [#158](https://github.com/mathbook3948/bunaway/issues/158). [T-core-live]의
  `convertFileSrc`에 대응하며 URL 변환과 파일 접근 허용을 구분한다. 19절의 파일 접근 규칙과
  17절의 CSP에 연결하고, 허용한 이미지와 미디어 표시, Unicode와 예약 문자 인코딩을 검증한다.
  앱의 거부 경로, 경로 순회, 링크 우회와 접근 철회 후 호출을 차단하는지 테스트한다.
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

CSP와 자산 응답 보안은 [PRD](./PRD.md)의 5절 권한과 보안 모델에 있는 프로덕션 CSP와
명시적 개발 origin 요구를 구체화한다. 출처: [T-security-live], [T-csp-live], [T-headers-live].

- [ ] 권한 check와 request 훅, origin과 frame별 허용와 거부를 제공한다.
- [ ] 권한 결정의 영속화, 조회와 초기화를 제공한다.
- [ ] 프로덕션 CSP와 개발용 CSP(`devCSP`)의 설정, 기본값과 적용 대상을 정의한다. [#158](https://github.com/mathbook3948/bunaway/issues/158).
  nonce/hash 생성과 자산 연결, 허용 origin, 개발 HMR과 프로덕션 정책의 분리를 제공한다.
  정상 자산 로드, 허용하지 않은 inline script와 외부 origin 차단, 개발 정책의 배포 유출 방지를 검증한다.
- [ ] 자산과 사용자 정의 protocol 응답의 보안 헤더를 설정하고 CSP와의 적용 관계를 정의한다. [#158](https://github.com/mathbook3948/bunaway/issues/158).
  COOP, COEP, CORP와 `X-Content-Type-Options`의 기본값, 덮어쓰기 규칙과 WebView별 지원을 기록한다.
  실제 응답 헤더와 교차 origin 허용/차단을 개발 및 패키지 실행에서 검증하고 적용 불가 경로를 명시한다.
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

- [x] 신뢰된 backend의 항목별 WebView 다운로드 시작 승인과 거부를 제공한다. 기본 거부, origin 검사, 30초 승인 기한과 창 수명별 자원 정리를 유지한다.
- [ ] WebView 다운로드의 사용자 지정 저장 경로와 저장 대화상자를 제공한다. WebView2의 경로 기반 쓰기와 덮어쓰기 동작에 맞는 파일 접근 계약이 필요하다. 현재 승인은 브라우저의 기본 경로만 사용한다.
- [x] `getDownloads`로 URL, MIME, Content-Disposition, 파일명을 포함한 기본 저장 경로, total/received bytes, 상태와 interrupt reason을 조회한다.
- [ ] redirect chain과 frame별 initiator를 조회한다.
- [ ] 속도, 진행률과 완료와 실패 이벤트를 제공한다. 현재 진행 및 종료 상태는 snapshot 조회로 확인한다.
- [x] `pauseDownload`, `resumeDownload`, `cancelDownload`와 `getDownloads`로 pause, resume, cancel과 재개 가능 여부를 제공한다.
- [ ] 중단 다운로드의 metadata 저장과 재개를 제공한다.
- [ ] 파일 업로드와 다운로드에 progress, 취소, timeout을 제공한다.
- [x] 프린터 목록과 기본 프린터를 조회한다.
  [`os.listPrinters`와 `os.getDefaultPrinter`](./site/src/content/docs/reference/plugins/os.mdx)는
  이름과 기본 여부만 반환하며 독립 권한이다.
- [x] `showPrintUI`로 WebView2 browser 또는 system 인쇄 대화상자를 요청한다. 반환은 인쇄 완료가 아니며 사용자가 프린터와 제출을 선택한다.
- [ ] silent print와 프로그램에서 지정하는 프린터 및 인쇄 옵션을 제공한다.
- [ ] system 인쇄 대화상자의 실제 사용자 선택과 취소, 프린터의 실제 출력을 검증한다. CI의 browser UI 요청과 자원 정리는 물리 인쇄 검증이 아니다.
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

- [x] 앱이 지정한 절대 경로의 UTF-8 텍스트 읽기와 쓰기를 제공한다.
- [x] 파일을 여는 경계에서 잘못된 경로 형식을 거부한다. 링크는 따라가며 위치 제한은 앱 명령이 맡는다([ADR 0024](./decisions/0024-plugin-path-responsibility.md)).
- [x] Windows의 binary 읽기와 쓰기, UTF-8 텍스트와 바이트 append를 제공한다.
  canonical base64와 256 KiB 바이트 상한, 작업별 권한과 경로 형식 검사를 유지한다.
  `offset`과 `length`를 주면 그 범위만 읽는다(호출당 256 KiB). readText는 파일 512 KiB와 JSON 768 KiB를 넘으면 `INVALID_ARGUMENT`다.
  [바이너리 계약](./site/src/content/docs/reference/host/storage-bytes.mdx)을 따른다.
- [ ] open/read/write/seek/close 파일 핸들과 대용량 stream I/O를 제공한다.
- [x] 파일과 디렉터리 존재, stat과 metadata를 조회한다.
  `storage.exists`와 `storage.stat`은 앱이 지정한 절대 경로를 받는다.
  작업마다 독립적으로 허용하고 경로 형식을 검사한다. 링크는 따라간다. 없는 대상은 각각 `false`와 `null`이며,
  접근 거부는 없는 대상으로 숨기지 않는다. 종류, 파일 크기와 생성, 수정, 접근 시각을 제공한다.
  디렉터리 크기는 `null`이고 재귀 용량은 별도 작업이다.
  [exists 계약](./site/src/content/docs/reference/host/storage-exists.mdx)과
  [stat 계약](./site/src/content/docs/reference/host/storage-stat.mdx)을 따른다.
- [ ] 파일과 디렉터리의 OS 권한 및 ACL 조회 범위와 공개 계약을 정의한다.
- [x] Windows의 직접 자식 목록, 선택적인 상위 디렉터리 생성과 파일 및 빈 디렉터리 삭제를 제공한다.
  256개 상한의 목록과 삭제, 링크를 `link`로 표시하는 목록, 작업별 권한을
  [디렉터리 계약](./site/src/content/docs/reference/host/storage-directories.mdx)에 정의한다.
- [ ] 재귀 목록과 큰 목록 pagination을 제공한다.
- [x] 파일 또는 디렉터리 트리를 재귀 삭제한다.
  Windows의 `storage.removeRecursive({ path })`는 `storage.remove`와 별도 권한이며 `fs.promises.rm({ recursive: true })`로 지운다.
  트리 안의 symlink와 junction은 따라가지 않고 링크만 삭제하며, hardlink는 만난 이름만 삭제한다.
  하나의 호출이라 시작한 뒤에는 취소할 수 없고, 항목 수와 깊이 상한도 없다. 원자적이지 않아 실패 전에 삭제한 항목은 유지되며
  같은 호출을 반복하면 이어서 삭제한다. macOS에서도 같은 방식으로 지원한다.
  `windows-storage-remove-recursive.ts`가 CI windows-native에서 링크 비추적과 읽기 전용 항목 삭제를 확인한다.
  [디렉터리 계약](./site/src/content/docs/reference/host/storage-directories.mdx)을 따른다.
- [x] 파일 크기 조회와 별도로 디렉터리 재귀 용량을 바이트 단위로 계산한다.
  Windows의 `storage.directorySize({ path })`는 `{ bytes, files, directories }`를 반환한다.
  루트는 directories에 세지 않고, 크기는 일반 파일의 논리 크기 합이다. 하드링크는 이름마다 더한다.
  symlink와 junction은 목록 작업처럼 따라가지 않고 더하지 않는다. 링크 판정은 목록과 `lstat` 중 하나라도 링크이면 링크이다.
  일부 하위 항목의 접근 거부와 열기 실패는 과소 집계 대신 작업 전체를 실패시킨다.
  탐색 중 사라진 항목은 건너뛰고 스냅샷 일관성은 보장하지 않는다.
  방문 항목 100,000개와 깊이 64를 넘으면 `INVALID_ARGUMENT`이고,
  반복 방식으로 일정 단계마다 이벤트 루프에 양보해 시작 후에도 취소와 기한을 처리한다. macOS에서도 같으며 작업별 권한을 따로 허용한다.
  Tauri fs의 [`size`][T-fs-live]는 파일 metadata 크기 조회이며, 디렉터리 재귀 크기 계산에서
  링크 처리 계약은 이 구현이 정의한다.
  [디렉터리 계약](./site/src/content/docs/reference/host/storage-directories.mdx)을 따른다.
- [x] Windows의 일반 파일 복사(크기 상한 없음)와 같은 볼륨 안의 파일 및 디렉터리 이동을 제공한다.
  복사는 대상을 배타적으로 만들고 이동은 `MoveFileExW`를 덮어쓰기 없이 호출하므로 기존 destination을 대체하지 않는다.
  [전송 계약](./site/src/content/docs/reference/host/storage-transfers.mdx)을 따른다.
- [ ] 디렉터리 재귀 copy, 다른 볼륨의 move, 덮어쓰기 및 truncate를 제공한다.
- [ ] 파일 watch와 recursive watch, 이벤트 구독 해제를 제공한다.
- [ ] 원자적 저장, 충돌 처리와 대용량 stream I/O를 제공한다.
- [ ] 파일 대화상자로 획득한 범위의 일시 허용과 영속화를 제공한다.
- [x] Windows current-user Known Folder로 home, documents, downloads, desktop, pictures, music과 videos 경로를 조회한다.
  OS redirection을 따르며 폴더 생성과 파일 접근 권한을 부여하지 않는다.
  [경로 계약](./site/src/content/docs/reference/plugins/path.mdx)을 따른다.
- [x] appConfig, appData, appLocalData, cache, logs, temp와 resource 경로를 제공한다.
  `path.getAppDirectory`가 호스트의 앱 식별자 기준으로 앱 전용 디렉터리 여섯 가지를 조회하며 폴더 생성과 파일 접근 권한은 없다.
  로그와 local 디렉터리는 기존 dataRoot 구조에 맞추고 dataRoot 자체는 노출하지 않는다.
  resource 경로는 `ctx.app.paths.resources`가 제공한다. 남은 범위는 없고,
  Windows 외 플랫폼의 앱 디렉터리는 해당 플랫폼 플러그인 범위다.
  [경로 계약](./site/src/content/docs/reference/plugins/path.mdx)을 따른다.
- [x] Windows path join, resolve, normalize, basename, dirname, extname과 isAbsolute를 제공한다.
  resolve는 명시적인 fully qualified base를 요구하며 host cwd와 per-drive cwd를 사용하지 않는다.
- [x] 문자열 경로 helper의 Windows drive, UNC, extended-length와 Unicode 동작을 정의한다.
  파일 접근과 분리하며 storage의 extended-length 및 device 경로 거부는 유지한다.
- [x] key-value store의 load, get, set, delete, clear와 목록 조회를 제공한다.
  이름 붙인 JSON 저장소를 앱 데이터 디렉터리의 고정 위치에 두며 경로는 받지 않는다.
  [store 계약](./site/src/content/docs/reference/plugins/store.mdx)을 따른다.
- [ ] store 변경 이벤트, save, reload와 autosave를 제공한다.
  save, reload, autosave는 구현했다. 남은 범위는 화면으로 보내는 변경 이벤트이며,
  I/O Worker 어댑터에 이벤트 서비스를 제공하는 호스트 변경이 먼저 필요하다.
  지금은 변경 함수가 `changed`를 반환한다.
- [x] Store `defaults`와 저장된 값의 병합 우선순위, 중첩 객체 처리, 기본값 무시 옵션을 정의한다.
  [T-store-live]의 `overrideDefaults`와 reload의 `ignoreDefaults`를 참고하고, 파일 없음,
  누락 키, 충돌 키와 중첩 객체를 load/reload하여 결과와 저장 시점을 검증한다.
- [x] Store를 기본값으로 되돌리는 reset-to-defaults를 제공한다. 모든 값을 지우는 `clear`,
  디스크 값을 다시 읽는 `reload`와 구분한다. [T-store-live]의 `reset`을 참고한다.
  기본값이 있는 경우와 없는 경우, 명시적 save 후 재실행 결과를 검증한다.
  변경 이벤트는 위 이벤트 항목에서 다룬다.
- [ ] SQLite의 query, execute, transaction과 migration을 제공한다.
- [ ] Tauri SQL의 다른 backend와 원격 DB 지원 필요성을 결정한다.
- [x] Bun 파일, path와 SQLite API를 직접 사용하는 trusted backend 경로와 권한 중재 API를 구분해 문서화한다.
  [백엔드 Host API](./site/src/content/docs/reference/backend/host-api.mdx)를 따른다.

## 20. OS 정보, HTTP, WebSocket와 프로세스

우선순위 P2. 소유자: 선택 기능 플러그인, 기본 실행 능력은 번들 Bun.
출처: [T-os], [T-http], [T-websocket], [T-shell], [T-process], [T-cli], [T-localhost], [E-net], [E-utility].

Bun의 trusted backend는 이미 기본 fetch, WebSocket, 파일 I/O와 프로세스 API를 사용할 수 있다.
아래는 이를 없던 기능으로 다시 구현하는 작업이 아니라 정책을 적용한 공개 기능과 OS 연동의 작업이다.

- [x] OS 종류, 버전, architecture, hostname과 실행 환경 정보를 제공한다.
  선택 `os` 플러그인의 `info`는 실행 중 Bun의 architecture, 버전과 PID를 반환한다.
- [x] locale, country code, preferred languages와 OS 언어를 조회한다.
  `os.locale`은 Windows 사용자 locale과 지역 코드, 순서 있는 표시 언어와 시스템 UI 언어를 반환한다.
- [x] CPU, 메모리와 프로세스 사용량, PID와 translation 상태 조회를 제공한다.
  `os.usage`는 논리 CPU 개수, 현재 프로세스의 누적 CPU 시간, 메모리 bytes와
  `IsWow64Process2` 결과를 반환한다. CPU 백분율과 임의 PID의 조회는 포함하지 않는다.
- [x] 앱의 origin과 URL 접근 규칙을 적용한 HTTP 요청과 응답을 제공한다.
  뷰의 작업 권한과 앱 명령의 URL origin 검사를 구분한다. `network.request`는 임의 Origin
  header를 받지 않고 redirect를 반환하므로 새 대상은 앱이 다시 검사한다.
  [network 계약](./site/src/content/docs/reference/plugins/network.mdx)의 앱 명령 예제를 따른다.
- [x] HTTP header, body, redirect, proxy와 OS 인증의 지원 범위를 정의한다.
  선택 `network.request`는 제한된 header와 base64 body를 제공하고 redirect를 따라가지 않는다.
  proxy는 Bun의 신뢰된 실행 환경 설정만 사용하며 OS 인증과 WebView cookie 공유는 제공하지 않는다.
- [ ] HTTP stream, timeout, 취소와 progress를 제공한다. [#81](https://github.com/mathbook3948/bunaway/issues/81).
  `network.request`의 제한된 응답, timeout과 호출 취소는 구현했다. 공개 stream과 progress는 남아 있다.
- [ ] WebSocket 연결, 메시지, close, 상태와 backpressure를 공개 계약으로 제공한다. [#81](https://github.com/mathbook3948/bunaway/issues/81).
  `network.exchange`는 호출 하나에 종속된 제한된 text 송신과 text/binary 수신, close와 send buffer
  상한을 제공한다. 장기 연결 handle, 독립 send/receive와 상태 이벤트의 세션 소유권은 남아 있다.
- [x] 앱이 실행 파일과 인자를 검사하는 command 실행을 제공한다.
  선택 `process.run`의 실행 파일과 전체 argv는 앱 명령이 검사한다. 절대 local `.exe`
  경로만 실행하며 PATH, batch 파일과 호출자 env/cwd 설정을 받지 않는다.
- [x] shell 문자열 실행과 argv 실행을 구분한다.
  `process.run`은 Bun argv 실행만 제공하며 shell 문자열 API를 제공하지 않는다.
- [x] spawn, stdout/stderr, stdin, exit code와 signal을 제공한다.
  `process.run`의 제한된 binary stdin, stdout/stderr 캡처, PID와 완료 결과는 구현했다.
  장기 실행은 `process.spawn`이 핸들을 발급하고 `read`(출력과 종료 상태), `write`,
  `closeStdin`, `kill`로 다룬다. 출력은 이벤트가 아니라 `read`로 당겨 읽는다. Windows 호스트에는
  플러그인이 쓸 수 있는 일반 이벤트 서비스가 없고 이벤트는 구독한 모든 뷰에 전달되기 때문이다.
  Windows 종료 상태에 signal은 없어 `signal`은 `null`이다.
- [x] process kill, timeout과 앱 종료 시 process tree 정리를 연결한다.
  호출 취소, timeout, 출력 초과와 어댑터 폐기는 호출별 Job Object로 자손까지 종료하고
  pipe를 닫는다. 직접 자식이 정상 종료해도 남은 자손을 정리한다. 앱 종료의 descendant
  정리는 기존 host Job Object를 따른다. 장기 spawn handle은 핸들별 Job Object를 가지며
  `kill`, 루트 종료, 어댑터 폐기가 자손까지 종료한다.
- [ ] 번들 sidecar의 플랫폼 선택, 실행 경로, 라이선스와 패키징을 제공한다.
- [ ] 앱 restart와 exit를 desktop 수명주기에 연결한다.
- [x] CLI argument와 subcommand schema, help, 오류와 match 결과를 제공한다.
  `@bunaway/backend/cli`의 `defineCLI`는 기존 `onOpen` argv를 명시적으로 받아 Bun
  `parseArgs`와 앱의 Zod schema로 검사한다. help와 오류는 결과이며 실행과 종료를 제어하지 않는다.
- [ ] utility process의 독립 실행과 양방향 메시지, 종료와 오류 이벤트를 제공한다.
- [ ] localhost 자산 서버는 선택 기능으로 지원 여부를 결정한다. 기본 통신 경로는 기존 로컬 자산과 브리지다.
- [x] HTTP client-request와 incoming-message의 stream 기능을 Bun 대체 API에 매핑한다.
  신뢰된 backend는 `fetch`, `RequestInit.body`, `Response`와 `Response.body`를 사용한다.
  [network 계약](./site/src/content/docs/reference/plugins/network.mdx)의 대응 표와 stream 예제를 따른다.
  정책 중재 stream은 위의 stream/progress 작업에 남겨 둔다.

## 21. 암호화 저장과 시스템 인증

우선순위 P2. 소유자: 공식 보안 기능 플러그인 후보. 출처: [E-safe], [T-stronghold], [T-biometric].

- [x] Windows DPAPI의 현재 사용 가능 여부를 암복호화 probe로 조회한다. 다른 플랫폼은 미지원이다.
- [x] Windows DPAPI의 current-user 범위에서 문자열과 bytes 암호화, 복호화를 제공한다.
  작업별 권한과 크기 제한, prompt 금지와 평문 fallback 금지는
  [암호화 저장 계약](./site/src/content/docs/reference/plugins/safe-storage.mdx)을 따른다.
- [x] Windows의 비동기 사용 가능 여부 조회와 암복호화를 I/O Worker에서 제공한다. [E-safe-live]의
  `isAsyncEncryptionAvailable`, `encryptStringAsync`, `decryptStringAsync`를 참고한다.
  최초 작업에서 DLL을 초기화하고 동시 요청을 I/O 큐에서 처리한다. 처리 전 취소와 종료,
  시작한 Windows API의 중단 불가, 오류와 원본 보존을 정의한다.
  실제 Win32 및 WebView2 회귀를 CI에 포함하며 다른 사용자와 머신, roaming profile 및
  Windows 키 복구는 별도 실행 검증으로 남긴다.
- [x] 결정 완료: 복호화 결과에 재암호화 필요 여부(`shouldReEncrypt`)를 제공하지 않는다. [E-safe-live]의 Windows
  `safeStorage`는 DPAPI provider 하나만 등록해 값이 항상 `false`이고 동기 `decryptString`에는 신호가 없다.
  키가 바뀐 값은 신호 없이 영구 복호화 실패(`INTERNAL`)이며 `CRYPTPROTECT_VERIFY_PROTECTION` 확장은 쓰지 않는다.
  `tests/api/safe-storage.test.ts`가 복호화 출력이 평문 값 그대로임을 고정한다.
- [x] 키 저장소가 잠기거나 일시적으로 이용 불가할 때 영구 복호화 실패와 구분하고 재시도 계약을 제공한다.
  DPAPI 호출이 서비스 불가 계열 Win32 오류(`ERROR_BUSY`, `ERROR_SERVICE_NOT_ACTIVE`,
  `RPC_S_SERVER_UNAVAILABLE`, `RPC_S_SERVER_TOO_BUSY`)로 실패하면 `BUSY`, 그 밖의 실패는 `INTERNAL`이다.
  재시도 계약은 같은 입력으로 다시 호출하는 것뿐이며 자동 재시도, 대기 한도 옵션과 평문 fallback은 없다.
  `tests/api/safe-storage.test.ts`가 분류를, `tests/lifecycle/windows-safe-storage.test.ts`가 Bun FFI에서
  `GetLastError`를 읽을 수 있음을 Windows CI에서 확인한다. 실제 키 서비스 중단은 재현하지 않는다.
- [ ] OS credential store에 secret을 저장, 조회하고 삭제하는 기능의 지원을 결정한다.
- [ ] Stronghold 방식의 vault, client, key와 record 관리 기능을 제공한다.
- [ ] vault unlock, lock, save와 암호 변경을 제공한다.
- [ ] 키 생성과 cryptographic operation을 secret 노출 없이 실행한다.
- [ ] vault 암호 파생 함수와 salt의 설정, 생성과 보관 방법을 제공한다.
- [x] 복호화 불가를 평문으로 숨기지 않고 `INTERNAL`로 전달한다. 손상과 다른 사용자, 머신,
  재설치 및 키 일시 문제를 이 코드만으로 구분하지 않는다.
- [ ] 다른 사용자와 머신, 재설치, roaming profile 및 키 복구 시나리오를 실제로 검증한다.
- [x] 일반 평문 store와 암호화 변환을 구분하고 이 플러그인의 묵시적 평문 fallback을 금지한다.
  평문을 저장하려면 앱이 별도 파일 또는 store API를 명시적으로 선택한다.
- [ ] Windows Hello를 통한 사용자 확인은 추가 기능으로 지원 여부를 결정한다. Tauri 공식 biometric의 모바일 지원과 구분한다.

## 22. 자동 업데이트와 앱 배포 기능

우선순위 P2, 첫 공개 릴리스 준비는 P1. 소유자: updater 플러그인, 패키저와 호스트.
출처: [T-updater], [E-updater], [T-config], [E-app].

설치 파일 생성과 출시 검증은 구분한다. 플랫폼별 형식, 코드 서명, 공증과 스토어 배포의
완료 조건은 28절에서 [PRD](./PRD.md)의 9절과 [플랫폼 지원 표](./platform-support/README.md)에 연결한다.

자동 업데이트 구현은 배포 책임자의 신뢰 및 릴리스 정책 결정 전까지 보류한다.
신뢰할 서명 키와 루트, 키 교체와 폐기, 메타데이터 서명 및 endpoint 허용 목록,
버전 선택과 downgrade, 부분 실패와 rollback 규칙, Store 업데이트와 자체 updater의
채널 구분, 설치와 종료 승인 및 relaunch 계약을 먼저 정해야 한다.
PRD의 첫 릴리스에는 자동 업데이트 서비스가 포함되지 않는다. 아래 관련 항목은 미완료이며
프로덕션 키나 외부 업데이트 호스팅을 구성하지 않는다.

- [x] 고정 Bun으로 앱 코드와 웹 자산, 설정과 정책을 compiled EXE에 포함한 Windows 앱 패키지를 만든다.
- [x] Inno Setup 기반 direct와 Store unpackaged 채널의 설치 파일 생성 경로가 있다.
- [x] 앱 이름과 ICO 아이콘을 가진 GUI EXE로 실행하고 시작 실패 대화상자와 로그를 제공한다.
- [x] 설치 옵션에 파일 연결과 URL scheme 처리 후보 등록의 opt-in을 연결한다.
- [x] 설치 옵션에 autostart의 opt-in을 연결한다. 08절의 설치와 런타임 연결과 같다.
- [x] 업데이트에서 기존 설치 폴더, 앱 데이터와 설정된 경로의 바로가기를 유지한다.
  Inno 설치는 기존 설치 폴더와 앱 데이터를 유지하고,
  설정된 경로의 앱 바로가기가 같은 설치의 이전 EXE를 가리킬 때 대상과 기본 아이콘을 갱신한다.
  사용자 인자, 작업 디렉터리와 사용자 지정 아이콘을 보존한다. 이동하거나 이름을 바꾼 링크는
  탐색하지 않는다. [설치 채널 계약](../packages/packaging/README.md)을 따른다.
- [ ] 설치 위치 변경에 따른 이전 설치 정리와 바로가기 갱신, 파일 연결과 URL scheme 유지를 제공한다.
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
- [x] `client.once`와 직접 `once`로 첫 유효 이벤트를 한 번만 전달하고 자동 해제한다. 권한, 취소와 오류 계약은 기존 구독을 따른다.
- [ ] 대상 창, WebView, backend 이벤트 전달의 공개 계약을 제공한다. [#81](https://github.com/mathbook3948/bunaway/issues/81).
- [x] Windows의 `windows.changed` native 이벤트를 동일한 typed 구독 API로 전달한다.
- [ ] binary payload와 JSON 외 데이터의 전송 계약을 추가한다. [#81](https://github.com/mathbook3948/bunaway/issues/81).
- [ ] 연속 결과와 대용량 데이터의 channel 또는 stream 전송을 제공한다. [#81](https://github.com/mathbook3948/bunaway/issues/81).
- [ ] MessagePort와 transferable resource에 해당하는 기능을 제공한다.
- [ ] 백엔드에서 UI로 요청하고 결과를 받는 기능의 필요성을 결정한다.
- [ ] native resource handle의 생성, 참조와 해제 계약을 제공한다.
- [x] UI에 노출할 명령과 이벤트의 타입, 계약과 정책 목록을 생성하는 도구를 제공한다(`bunaway contract`).
- [x] 브라우저 테스트용 transport를 제공한다(`createMockTransport`).
- [ ] 앱 정의에서 mock 핸들러를 생성하는 mock API를 제공한다.
- [ ] context bridge와 preload의 역할을 기존 SDK와 정책으로 대체하는 범위를 정한다.
- [ ] 동기 IPC와 프런트엔드의 임의 Node/Bun 접근은 PRD와 충돌하므로 도입 여부를 별도 ADR에서 결정한다.

## 24. 개발 도구, 진단과 성능 API

우선순위 P2, 실험 API는 P3. 소유자: CLI와 호스트, 앱 로그는 공식 기능 플러그인.
출처: [E-debugger], [E-tracing], [E-crash], [E-net-log], [E-process], [T-log], [T-mocks].

- [x] 외부 개발 서버의 UI HMR과 앱 계약, 정책, 플러그인 및 실행 설정 변경의 전체 재시작을 제공한다.
- [x] 호환되는 Windows 개발 앱의 명령 구현만 교체하고 창, 문서, StateStore, 세션과 구독을 유지한다.
- [x] 앱 코드 빌드 오류 동안 기존 구현을 유지하고 진행 중 요청은 이전 구현으로 완료한다.
- [x] 웹 build.command와 앱 빌드를 통합하고 프로세스 종료를 관리한다.
- [x] Windows 개발 모드 DevTools와 `dev --inspect`를 제공한다.
- [x] UI와 백엔드 소스맵과 원본 명령 오류 스택을 제공한다.
- [x] 앱 로그와 플러그인 없이 남기는 프레임워크 진단을 구분한다.
- [x] `openDevTools`로 개발 모드에서 DevTools를 연다. 작업 권한으로 프로덕션 설정을 우회할 수 없다.
- [ ] DevTools 닫기, 상태 조회와 이벤트 API를 제공한다.
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
- [x] 로그 level(`minimumLevel`), target(`appData`만), rotation(`maxFileBytes`), retention(`maxArchives`)과 flush를 `log.configure`/`log.flush`로 제공한다.
- [ ] 시작 시간, 유휴 메모리, 패키지 크기와 명령 지연의 기준 측정을 기록한다.
- [ ] 각 UI 템플릿의 실제 Windows dev, HMR, build와 package 실행을 검증한다.
- [ ] 고급 process crash, hang, heap snapshot과 JavaScript stack 수집의 지원 범위를 결정한다.

명령 교체는 Windows 개발 모드에만 적용한다. 모듈 변수는 새로 초기화되며 플러그인
setup 교체와 임의 자원 이전, 상태 마이그레이션은 제공하지 않는다. 공통 계약이나
설정이 바뀌면 전체 재시작한다. [개발 가이드](./site/src/content/docs/guides/development.mdx)와
[실제 앱 코드 교체 기록](./architecture/windows-bun-results.md#2026-10-09-앱-코드-교체)을 따른다.

## 25. 선택 렌더러와 고급 데스크톱 기능

우선순위 P3. 소유자: 선택 렌더러와 기능 패키지. 출처: [E-view], [E-contents], [E-extensions], [E-texture], [E-ai].

- [ ] CEF 등 선택 Chromium 렌더러를 동일한 SDK와 정책 계약에 연결한다. Tauri가 WebView 계층을 별도 크레이트(wry)로 분리한 것처럼 `packages/` 아래 별도 패키지로 새로 만든다.
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

- [x] macOS를 같은 Bun 앱 정의로 실행하고 직접 FFI와 같은 프로세스의 백엔드 Worker에 연결한다.
- [x] macOS의 사전 선언 다중 창과 기본 창 수명주기를 공통 네이티브 플러그인 계약에 연결한다.
- [ ] macOS의 desktop, 나머지 창 API와 선택 네이티브 플러그인 계약을 맞춘다. [macOS TODO](./TODO-macos.md)를 따른다. [#78](https://github.com/mathbook3948/bunaway/issues/78).
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
- [ ] macOS 메뉴 `header`, `palette`, `badge`와 사용자 지정 `userAccelerator` 조회를 제공한다.
  [E-menu-item-live] 기준 header/palette/badge는 macOS 14 이상이며 badge는 Dock 메뉴에 표시되지 않는다.
  지원 OS의 표시와 선택 동작, badge 변경과 제거, 메뉴 삽입 전후 사용자 단축키 조회와 미지정 값을 검증한다.
  이전 OS와 다른 플랫폼의 미지원 결과를 기록하고 07절의 메뉴 계약과 연결한다.
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
- [ ] Wayland의 전역 단축키, 화면 캡처, 포커스와 위치 제어를 기능별로 구분해 지원 범위를 결정한다.
  GlobalShortcuts와 ScreenCast 등 필요한 portal의 존재, backend와 compositor 지원, 사용자 동의를 확인한다.
  포커스 활성화의 compositor 제약과 전역 창 좌표 조회/이동의 미지원 범위를 기록한다.
  [E-window-live]가 명시한 전역 좌표 제한을 portal 연결만으로 해결된 것으로 취급하지 않는다.
  compositor별 portal 없음, 권한 거부, 취소, 정상 동작과 위치 제어 미지원 결과를 검증한다.
- [ ] 플랫폼별 window gesture, cursor auto-hide와 first-mouse 동작을 제공한다.
- [ ] Intel, ARM64와 translation 환경의 runtime pin, 실행과 배포를 검증한다.

## 27. 모바일 전용 공식 기능

우선순위 P3. Windows 완성 후 플랫폼 실행 모델을 검증한다.
출처: [T-biometric], [T-geolocation], [T-barcode], [T-haptics], [T-nfc], [T-notification], [T-app], [T-config].

- [x] Android의 Java Activity, 단일 WebView와 APK에 번들한 Bun 자식 프로세스를 공통 앱 정의, Core와 SDK에 연결한다.
- [x] Android의 `sync`, `build`, `run`으로 사용자 네이티브 프로젝트를 유지하고 debug APK를 빌드, 설치 및 실행한다.
- [x] Android 화면 회전에서 Bun과 Core를 유지하고 홈 이동과 복귀, 뒤로가기 종료를 구분한다.
- [ ] Android의 저메모리와 백그라운드 종료 이후 상태 복원, WebView 장애 복구와 네이티브 플러그인 어댑터를 구현한다.
- [ ] Android release APK/AAB와 서명, 스토어 배포 경로를 구현한다.
- [ ] iOS의 호스트, Bun 실행, 중단과 복귀, 배포 경로를 구현한다.
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

Android의 실제 실행 기록은 API 36 x86_64 에뮬레이터와 debug APK 범위다.
ARM64는 런타임 해시와 APK 포함만 확인했으며 실기기 실행과 최소 API 29는 미검증이다.
후속 파일 import와 프로세스 그룹 정리의 계약 검사도 기존 에뮬레이터 실행 결과와 구분한다.
[Android 실행 기록](./architecture/android-host-results.md)과
[호스트 수명주기 ADR](./decisions/0015-android-bundled-process-host.md)을 따른다.

## 28. 플랫폼 지원과 완료 검증

우선순위 P1. 소유자: 각 기능의 구현 담당자와 배포 도구.

완료 표시는 각 항목과 연결한 실행 기록의 환경 및 범위를 뜻한다. 새 실행 결과와 이전 실행
결과는 날짜, 기준 revision과 검증 방식으로 구분한다.

- [ ] Windows 10/11의 지원 최소 버전과 실제 검증 환경을 확정한다.
- [ ] WebView2 최소 버전과 Evergreen, Fixed Version 배포 지원을 확정한다.
- [ ] Windows ARM64 지원과 x64 emulation 범위를 확정한다.
- [ ] 최소와 최대 크기, DPI와 다중 모니터 회귀를 실제 사용자 조작으로 검증한다.
  최소/최대 크기의 물리 경계 조작과 서로 다른 DPI의 물리 모니터 이동은 미검증이다.
- [x] 로컬 Windows x64의 실제 두 창에서 focus/blur 왕복과 물리 드래그 중 move/resize 전달을 검증한다.
  2026-10-10 main `6f2363c`, Windows 11 Pro 25H2 x64, 빌드 26200.9457,
  Bun 1.4.2와 WebView2 Evergreen 154.0.4258.62에서 순차 실행했다.
  단일 1920×1080, 100%(96 DPI) 모니터에서 클릭 왕복과 제목 표시줄 및 테두리 드래그를 수행했다.
  물리 조작 구간의 move 424개와 resize 228개를 수신했고 normal/outer bounds가 일치했다.
  버튼을 누른 채 5초 멈췄으며 놓기 전 전달은 조작자의 관찰로 확인했다.
- [ ] 물리 모니터 분리와 재연결 시 normal bounds 및 전체화면 복원을 검증한다.
  DLL 대체 회귀는 통과했지만 물리 연결 변경은 수행하지 않았다. 다른 모니터로의 fallback도 미검증이다.
- [x] 로컬 Windows x64에서 실제 Win32와 WebView2로 상태 제어와 조회, 권한 거부와 전체화면 중 변경 거부를 검증한다.
  2026-10-10의 [창 상태 검증 기록](./architecture/windows-bun-results.md#2026-10-10-창-상태-제어와-조회)을 따른다.
  실제 다른 DPI의 물리 모니터 이동과 초기 maximized/fullscreen 옵션, 창 이벤트는 이 결과에 포함하지 않는다.
- [x] 로컬 Windows x64의 실제 Win32와 WebView2에서 창 이벤트, snapshot 복구와 구독 수명을 검증한다.
  [창 이벤트 검증 기록](./architecture/windows-bun-results.md#2026-10-10-창-이벤트와-구독-수명)과
  [네이티브 모달 이벤트 전송 기록](./architecture/windows-bun-results.md#2026-10-10-네이티브-모달-이벤트-전송-보완)을 따른다.
  후속 물리 조작 검증에서 focus/blur와 물리 드래그를 확인했다. 다중 물리 모니터 이동은 미검증이다.
- [ ] IME, keyboard layout, 고대비와 스크린 리더 회귀를 검증한다.
- [ ] tray, autostart, file association과 toast를 깨끗한 Windows 설치에서 검증한다.
- [ ] autostart를 등록한 뒤 실제 로그아웃과 로그인에서 앱 실행 및 인자 전달을 검증한다.
  Run 값 등록과 저장 명령줄의 CreateProcessW 실행 검사는 실제 로그인 실행을 검증한 결과가 아니다.
  [autostart 검증 범위](../plugins/autostart/README.md#검증)를 따른다.
- [ ] I/O Worker로 이관한 opener의 파일 열기와 Explorer 선택을 실제 Windows 및 compiled EXE에서 재검증한다.
  [초기 UI Worker 실행 기록](./architecture/windows-bun-results.md#2026-10-10-opener-파일-작업)과 구분한다.
- [ ] suspend/resume, 잠금과 Explorer 재시작 후 자원과 구독을 검증한다.
- [x] 로컬 Windows x64에서 WebView 장애 복구와 앱 강제 종료 후 Job의 자손 회수를 검증한다.
- [ ] 최신 Windows 전체 호스트 회귀를 통과하고 WebView 종료와 자식 프로세스 정리를 재검증한다. [#94](https://github.com/mathbook3948/bunaway/issues/94).
  [geometry 설정 검증 기록](./architecture/windows-bun-results.md#2026-10-10-창-geometry-설정-api)의
  개별 Win32와 WebView2 검사는 통과했지만 전체 호스트 회귀와 단독 재실행에서
  `WebView cleanup timed out` 및 브라우저 자식 프로세스 잔류가 기록됐다.
- [ ] 최소 지원 OS, CPU와 다른 Job 정책의 환경에서 장애 및 강제 종료 뒤 자원 정리를 검증한다.
- [ ] 각 플랫폼의 supported/experimental/unsupported와 OS permission 값을 실제 구현에 맞춘다.
- [ ] 지원 목록, CLI 진단, 문서와 배포 산출물을 같은 릴리스로 갱신한다.
- [ ] 플랫폼별 설치 패키지 형식과 배포 채널을 확정하고 [PRD](./PRD.md)의 9절 출시 기준 및
  [플랫폼 지원 표](./platform-support/README.md)의 패키지와 출시 검증에 증거를 연결한다. [T-distribute-live]를 참고한다.
  Windows EXE/MSI/MSIX, macOS app/DMG/PKG, Linux deb/rpm/AppImage 등의 채택 또는 제외를 기록하고,
  채택한 형식마다 깨끗한 대상 OS에서 설치, 최초 실행, 업데이트와 제거를 검증한다. 22절의 기존 작업과 함께 완료를 판정한다.
- [ ] 배포할 Windows 앱과 설치 파일의 프로덕션 코드 서명, 타임스탬프와 변조 거부를 검증한다.
  현재 Bun FFI 산출물로 검사하고, 서명 후 해시와 번들 런타임 검증을 유지한다.
  자체 서명 인증서나 PE-overlay 테스트를 프로덕션 서명 검증으로 대체하지 않는다.
- [ ] macOS 배포 채널에 맞는 코드 서명, entitlements와 hardened runtime을 확정한다.
  직접 배포의 Developer ID 서명, 공증과 stapling, 깨끗한 Mac의 Gatekeeper 및 설치 실행을 검증한다.
  ad-hoc CI 성공과 구분하여 산출물, 인증서 유형, OS/CPU와 검증 결과를 지원 표에 기록한다.
- [ ] Android와 iOS의 패키지, 서명과 스토어 배포 조건을 27절의 실행 모델 검증과 연결한다.
  Android APK/AAB와 업로드/앱 서명 키, iOS 배포 인증서와 provisioning, entitlements를 정의하고
  서명된 앱을 실기기에서 설치, 실행, 업데이트한다. Bun 실행과 코드 실행 정책의 제약도 기록한다.
- [x] Android API 36 x86_64 에뮬레이터에서 debug APK 설치와 공통 SDK/Core, 화면 회전 및 종료를 검증한 결과를 기록한다.
  [Android 실행 기록](./architecture/android-host-results.md)의 검증 시점과 범위를 따른다.
  ARM64 실기기, 최소 API 29, 후속 프로세스 그룹 변경의 기기 재검증과 release 배포는 포함하지 않는다.
- [ ] Microsoft Store, Mac App Store, Google Play와 App Store의 채널별 제출 및 배포 완료 조건을 정의한다.
  대상 채널의 정책 검토, 제출 검증, 심사와 실제 설치 결과를 구분해 기록하고 지원 표에 반영한다.
  미제출, 미승인과 제외 채널을 명시하며 패키지 생성만으로 스토어 배포를 완료 처리하지 않는다.

## 다음 작업 묶음

1. 초기 위치와 중앙 배치, 초기 창 상태 옵션, 생성과 준비 등 남은 창 이벤트: 02, 03, 04.
2. 트레이 개별 아이콘과 메뉴, 전역 단축키, autostart 숨김 시작과 설치 및 제거 연동: 06, 07, 08.
3. 지정 앱 opener와 휴지통, 파일 대화상자, 클립보드 이미지와 다중 형식, 알림: 09, 10, 11, 12.
4. 모니터와 DPI, 테마, 창 상태 저장과 OS 연결: 04, 09, 13.
5. WebView와 세션 확장, 전송과 데이터 기능: 14–21, 23.
6. 업데이트, 선택 렌더러와 다른 플랫폼: 22, 25–27. PRD의 출시 범위와 별도로 우선순위를 결정한다.
7. Windows 전체 호스트 회귀, opener I/O 이관 후 실행, 실제 로그인과 다중 물리 모니터 검증: 28.

## 공식 API 대조 범위

기존 출처 [T-window]부터 [E-push]까지는 아래 스냅샷으로 고정했다. main/dev에는 실험 기능과 다음 버전의
기능이 포함될 수 있다. 실제 구현을 시작할 때 대상 안정 버전의 지원 플랫폼과
deprecated/experimental 상태를 확인하고 해당 체크 항목에 기록한다.
같은 기능의 setter, getter, 초기 설정과 이벤트는 본문의 기능 항목에 함께 연결한다.
구형 API, 엔진 내부 API와 플랫폼 전용 API도 삭제하지 않고 대체와 지원 결정 대상으로 남긴다.

- Tauri API와 Rust/config: `a916205db2c21a2475502452efa9b70132ae52f3`.
- Tauri 공식 기능 문서: `712e12a755d349303f7bcf96edd4165d0e1480db`.
- Electron API 문서: `054d1a159f4dcf775bceefb038134366578980db`.

보완 항목의 `-live` 출처는 2026-10-08 확인한 최신 공식 문서이며 위 SHA를 대체하지 않는다.
Electron의 단축키 중지, macOS 메뉴, 접근성 제어와 비동기 보안 저장 API는 고정 SHA에도
있지만 기존 TODO에서 빠졌거나 불명확했다. 최신 문서의 Electron 42.0.0 이상 조건과
macOS 버전 조건은 비교 대상의 조건이며 bunaway 지원 선언이 아니다.
Tauri Store와 fs의 JavaScript 상세 참조, 보안 및 배포 가이드는 기존 플러그인 소개와
config 소스의 보완 근거다. 고정 스냅샷 이후에 추가된 기능이라고 일괄 분류하지 않는다.
Bun 런타임으로 대체하는 기능과 의도적으로 제외한 기능의 기존 범위는 유지한다.

### Tauri 기본 API와 공식 기능

| API 또는 공식 기능 | 본문 절 |
| --- | --- |
| app | 05, 13, 26, 27 |
| core, event, mocks | 05, 16, 23, 24 |
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
| dialog, Menu, MenuItem, Tray, globalShortcut | 06, 07, 11, 26 |
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

[T-store-live]: https://v2.tauri.app/reference/javascript/store/
[T-fs-live]: https://v2.tauri.app/reference/javascript/fs/#size
[T-core-live]: https://v2.tauri.app/reference/javascript/api/namespacecore/
[T-security-live]: https://v2.tauri.app/reference/config/#securityconfig
[T-csp-live]: https://v2.tauri.app/security/csp/
[T-headers-live]: https://v2.tauri.app/security/http-headers/
[T-distribute-live]: https://v2.tauri.app/distribute/
[E-shortcut-live]: https://www.electronjs.org/docs/latest/api/global-shortcut
[E-menu-item-live]: https://www.electronjs.org/docs/latest/api/menu-item
[E-app-live]: https://www.electronjs.org/docs/latest/api/app
[E-safe-live]: https://www.electronjs.org/docs/latest/api/safe-storage
[E-window-live]: https://www.electronjs.org/docs/latest/api/base-window

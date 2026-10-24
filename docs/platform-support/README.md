# 플랫폼 지원과 검증 범위

앱은 선언한 창 하나를 사용하며 창 생성은 그 선언을 따른다. [ADR 0016](../decisions/0016-window-creation-contract.md)은
Windows의 호출별 표시 옵션 범위를 정의한다. create와 recreate는 `{ options? }`를 받는다.
제목, 부분 크기와 제약, 표시와 준비 후 표시를 생성마다 병합하고 검증한다. macOS는 title, 크기와 제약, contentProtection, visible, showWhenReady만 받고
배치, titlebar, alwaysOnTop, skipTaskbar, backgroundColor, focusable, maximized, fullscreen은 기존 창을 닫기 전에 `UNSUPPORTED`로 거부한다.
macOS는 `contentProtection`을 `NSWindow.sharingType`으로 지원하지만 macOS 15 이상의 ScreenCaptureKit 기반 캡처는 이를 무시할 수 있다.
새 옵션의 실제 Windows 검증은 CI의 windows-native 작업에서 수행한다.
[ADR 0026](../decisions/0026-single-webview-single-window.md)에 따라 앱은 창 하나와 WebView 하나를 가진다.
창 작업은 대상 인자를 받지 않고 `create`, `recreate`, `close`, `destroy`, `isOpen`이 그 창의 수명을 다룬다.
Windows와 macOS의 계약은 같으며, 새 옵션의 실제 WebView2 실행은 CI에서 검증한다.

Windows 창 준비와 숨김 생성은 [창 API](../site/src/content/docs/reference/host/windows.mdx)를 따른다.
Windows 11 Pro x64 `10.0.26200`, Bun 1.4.2와 실제 WebView2에서 단계별 준비, 탐색과 재생성,
실패와 취소, SDK 기한 초과 및 전환 중 앱 유지를 확인했다.
Win32 메시지와 WinEvent로 숨김 생성 중 순간 표시, 활성화와 포커스가 없고 입력 포커스가 유지되는 것도 확인했다.
이 두 검증과 계약 검사 결과는 [Windows 실행 기록](../architecture/windows-bun-results.md)에 구분한다.
macOS는 `getReadiness`, `windows.readiness`와 `visible: false`, `showWhenReady` 숨김 생성을 같은 의미로 제공한다.
문서 완료는 WKWebView 메인 프레임의 탐색 완료이며 숨김 생성은 앞으로 가져오기, key window 전환과 앱 활성화를 하지 않는다.

macOS의 single 뷰는 `getWebViewState`, `navigateWebView`, `reloadWebView`,
`stopWebView`, `goBack`, `goForward`, `setZoomFactor`를 구현한다.
`reloadWebView({ ignoreCache: true })`는 `reloadFromOrigin`으로 수행하며 요청 헤더는 macOS에서 검증하지 않는다.
개별 작업 권한은 공통 창 계약을 따르며 탐색은 기존 origin을 확장하지 않는다.
실제 compiled WKWebView 검사는 `tests/lifecycle/macos-webview-controls.ts`이며
기존 macOS native CI에서 실행한다. `build/macos-webview-controls-results.json`과
실패 시 진단 로그를 함께 수집한다. DevTools와 다운로드는 이 macOS 구현 범위에 없다.

Windows의 창 없는 시작은 `app.startup: false`로 설정하며
트레이 또는 `desktop.closeBehavior: "keep-alive"`를 요구한다.
Windows x64 `10.0.26200.0`, Bun 1.4.2에서 실제 트레이와 WebView2의 지연 생성,
마지막 창 닫기 뒤 백엔드 유지, 새 세션, 종료 취소, CLI 중단과 Job 강제 종료를 확인했다.
트레이 입력은 실제 HWND의 콜백 메시지로 검사했으며 물리 마우스 클릭은 포함하지 않는다.
macOS 창 없는 시작은 `UNSUPPORTED`이며 [Windows 실행 기록](../architecture/windows-bun-results.md)의 범위를 따른다.

백엔드의 `ctx.app`은 [ADR 0022](../decisions/0022-app-info-context.md)을 따른다. `runtime.webview`는 Windows에서 설치된 WebView2 런타임 버전,
macOS에서 시스템 WebKit 버전이며 Android와 iOS는 `null`이다. Windows는 `tests/lifecycle/windows-webview-version.test.ts`와 `mise run host:windows`의 호스트 fixture가, macOS는 `mise run host:macos`의 호스트 fixture(비어 있지 않은 문자열인지 확인)가 이 조회를 실제로 실행해 검증한다.

저장 플러그인은 Windows와 macOS I/O 어댑터를 제공한다. 두 플랫폼의 열여덟 작업은 텍스트와 바이트 읽기 및 쓰기, append, exists/stat, copyFile, copyDirectory, move, readDirectory, readDirectoryPage, readDirectoryRecursive, createDirectory, remove, removeRecursive와 directorySize다. 실제 WKWebView와 compiled 호스트의 저장 검증 fixture를 native CI에 포함하며 [저장 어댑터 기록](../architecture/macos-storage-adapter.md)에서 검증 범위와 의존성을 구분한다. 로그와 기능 조회의 macOS 어댑터는 I/O Worker에 연결했으며 창 플러그인의 기본 제어도 macOS에서 제공한다. clipboard는 Windows와 macOS를 지원하며 opener는 이 문서 기준 Windows만 지원한다. 아래 macOS 파일 저장과 네이티브 API 검증 기록은 이관 전 구현의 기록이다. Bun FFI 제품 경로의 명령, 이벤트와 정책, 복구, 종료 검증은 [새 기록](../architecture/macos-bun-results.md)에 둔다.

로그와 기능 조회는 격리 어댑터 검사와 실제 compiled WKWebView 앱 호출 검사를
구분한다. `macos-log-capabilities.ts`는 기존 entitlement로 ad-hoc 서명한 `.app`에서
출처와 권한, 쓰기 실패 후 복구, 회전, 최소 level 변경과 flush 호출 성공, 등록한 작업의 지원 목록과 정상 종료를 검사한다.
이 통합 head의 실제 native CI 결과는 확인 전까지 성공으로 기록하지 않는다.

Windows의 선택 [notification 플러그인](../../plugins/notification/README.md)은 unpackaged
앱 ID의 WinRT 알림 설정 조회와 Windows 알림 설정 열기 요청을 제공한다.
알림 표시와 toast activation은 아직 제공하지 않으며 기존 설치 바로가기 선택은 유지한다.
설정 페이지 실제 표시와 사용자 차단 상태 변경은 기본 CI 검증 범위에 포함하지 않는다.

기준일: 2026-10-10. “구현”은 출시 지원 보장이 아니다. 실제 OS, CPU와 테스트 범위를
기록하며, 공통 TypeScript 검사의 성공을 네이티브 호스트 성공으로 확대하지 않는다.

| 플랫폼 | 네이티브 구현 | 검증 환경, 범위 | 미검증, 제약 |
| --- | --- | --- | --- |
| Windows x64 | Bun 진입점, 직접 FFI UI Worker, WebView2, 번들 Bun x64 baseline | 로컬 FFI/모달/Host API/복구/종료/독립 CLI 검증([기록](../architecture/windows-bun-results.md)); PR18의 번들 런처 검증은 아래 기록과 분리 | 최소 Windows, CPU, WebView2 설치 경로, 배포, 스토어 적합성 |
| macOS arm64 | Bun 진입점, 직접 FFI AppKit/WKWebView, 백엔드 Worker, 창 하나 | 로컬 26.7.1 arm64: 실제 WKWebView 회귀와 compiled 창 API 검사. [Bun FFI 기록](../architecture/macos-bun-results.md)과 [이전 기록](../architecture/macos-native-results.md)을 구분 | Intel, 영속 프로필, 최소 OS, Developer ID, 공증, 설치 |
| macOS Intel | 고정 Bun 배포물, 해시 없음 | 없음. arm64 빌드 스크립트가 명시적으로 거부 | 별도 pin, 빌드, 실제 실행 검증 필요 |
| Linux | GTK, WebKitGTK 후보, 호스트 미구현 | Ubuntu 공통 검사, 생성 스키마 검사만 있음 | 네이티브 실행, UI, 프로세스 정리, 패키징 |
| Android | Java Activity, WebView, 번들 Bun과 공통 Core/SDK, Java 프로젝트 sync와 debug APK | API 36 x86_64 에뮬레이터. 명령, 이벤트, 취소, 자산과 프레임 경계, 화면 회전, 종료 | ARM64 실기기, API 29, 네이티브 플러그인, 외부 개발 서버, 백그라운드 복원, release/AAB/Store |
| iOS arm64 | Swift UIKit, WKWebView와 내장 Bun, 백엔드 Worker | 단일 뷰 Xcode 동기화와 Simulator debug 앱 | 기기 실행, 배포 서명, 스토어 제출, 네이티브 플러그인 |

## macOS CI와 CPU

GitHub 공식 [runner 표](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)와
[macOS 15 arm64 이미지](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md)를
기준으로 native job에 `macos-15`를 선택했다. 실제 `uname -m=arm64`, `RUNNER_ARCH=ARM64`,
OS와 CPU 정보를 job에서 검사/기록한다. Bun FFI 회귀는 C 컴파일 없이
`darwin-aarch64.json`의 Bun 실행 파일 해시와 실제 버전을 확인해 앱을 빌드한다.
runner 라벨이 바뀌거나 CPU가 맞지 않으면 실패하며 Rosetta나 skip-success로 대체하지 않는다.

기존 로컬 26.5.2 arm64 성공만으로 macOS 15의 GUI/WKWebView 성공을 주장하지 않는다.
네이티브 driver가 실제 페이지 보고서, 리소스 수신/차단, 렌더러 종료 후 재생성과
Bun 종료를 요구한다. GUI가 없거나 WebKit이 시작하지 못하면 테스트 실패다.
그런 runner에서는 GUI 세션을 갖춘 self-hosted Apple Silicon runner에서 **같은 suite**를
실행하는 것이 대안이며, 현재 CI를 성공 처리하거나 그 검사를 대신하지 않는다.

## 패키지와 출시 검증

macOS WKWebView는 현재 비영속 `WKWebsiteDataStore`를 사용한다. Windows의
브라우저 프로필 영속성과 동일한 지원이 아니다. 현재 macOS 회귀 fixture는
메모 상태를 Bun 메모리에 두며 네이티브 저장 플러그인을 검증하지 않는다. 이전 메모
fixture가 범위 제한 Host API 파일에서 복원한 결과는 선택 플러그인 이관 전 기록이다.

- Windows 독립 앱 패키지와 macOS 번들 Bun 패키지는 사용자 전역 Bun 없이 실행한다.
- macOS native CI는 `mise run host:macos -- --app`으로 `.app`을 만들고 **ad-hoc** 서명한 번들을 실행한다.
  서명 유지와 DMG 생성, PKG 조립도 검사한다. 이 검사의 코드 커밋 `fae4b80` 실행은
  [2026-10-07 CI](https://github.com/mathbook3948/bunaway/actions/runs/37554130779/job/112576288095)에서 통과했다.
- `LSMinimumSystemVersion=14.0`은 생성 plist의 값일 뿐 macOS 14 전체 지원 검증이 아니다.
- 프로덕션 Developer ID 서명, 실제 공증과 Gatekeeper, 설치 및 App Sandbox의 안정성은 별도 검증이 필요하다.
- CLI와 vanilla, Vite, React, Vue, Svelte 템플릿, 저장/로그/기능 조회 선택 플러그인 패키지,
  Windows 네이티브 어댑터는 구현했다. macOS 저장 어댑터와 공유 I/O dispatch도 구현했다.
  move와 remove는 미지원이며 실제 저장 호출의 검증 범위는 저장 어댑터 기록을 따른다.
  릴리스 자동화와 PRD 전체 출시 기준은 미충족이다.

## 패키징(공통 계약)

`packages/packaging`의 채널 중립 계약(`bunaway.json` v1의 `bundle`, 어댑터 입출력,
`PKG_*` 진단, 서명 후 `packagedSha256` 규칙)과 `bunaway package <channel>` 진입점이 있다.
Windows `win-direct`와 `win-store-unpackaged`는 일반 Inno 설치 파일 경로를 제공한다.
macOS 서명과 배포 구현은 `packages/packaging/src/channels/macos/`에 있다.
Bun 진입점은 `packages/packaging/scripts/macos.ts`이며 native CI에서 검사한다.
CLI의 `mac-direct`, `mac-store` 채널 어댑터 연결은 아직 구현하지 않았다.

Windows 배포 근거와 한계:
- PR16의 자체 서명 테스트 인증서, 기존 설치 테스트는 당시 C++ 호스트 산출물을 대상으로
  했다. 해당 결과는 삭제된 C++ 호스트를 싣지 않는 PR18 Bun FFI 설치 파일의 서명/설치
  검증으로 간주하지 않는다.
- Windows 배포본은 Bun과 웹 자산을 내장한 앱 EXE, WebView2Loader.dll, 라이선스와 manifest다.
  앱 시작 시 전체 해시 검사는 하지 않는다. 실행에는 WebView2 Evergreen이 필요하다.
- 앱 EXE 서명 뒤에는 `manifest.host.packagedSha256`에 배포 바이트의 해시를 기록한다.
  Bun 원본 해시와 소스 revision은 출처 기록으로 보존한다.
  실제 인증서 서명과 설치 결과는 로컬 컴파일 및 단위 테스트 결과와 구분한다.
- `win-store-unpackaged`는 Store 제출용 일반 EXE/MSI 경로다. Partner Center 제출과
  프로덕션 인증서는 검증 범위가 아니다.
- `win-store-msix` 채널 이름은 설정, 진단을 위해 등록돼 있지만 Bun FFI 패키지 생성은
  명시적으로 차단한다. 컴파일된 앱의 MSIX 활성화와 앱 데이터 동작은 아직 검증하지 않았다.

## 공개 창 API

Windows CLI는 `app.view`, `app.home`, `app.window` 설정과 백엔드 `windows` API를 제공한다. 생성과 재생성,
show/hide/focus, 크기와 위치, 전체화면, 닫기 확인을 정식 지원하며 기능 조회에서
`supported`로 보고한다. 로컬 Windows x64, Bun 1.4.2에서 전체화면의 표시 상태와 좌표 복원,
닫기 확인, 브라우저 장애, 반복 생성과 자기 창 재생성, 세션 종료에 따른 생성 취소를 통과했다.
CI 실행 [37574470840](https://github.com/mathbook3948/bunaway/actions/runs/37574470840)에서
새 창 API의 실제 GUI 회귀는 통과했다. 같은 실행의 전체 네이티브 작업은 공용 기능 목록 테스트에서 실패했다.
Windows는 `showInactive`와 `activate`도 제공한다. 앱 창과 입력 필드를 가진 보조 Win32 창에서
비활성 표시의 활성 창과 키보드 포커스 보존을 확인한다. 전경 전환은 OS가 거부할 수 있어
실제 전경 활성화 성공은 실행 환경에 따라 검증하지 못할 수 있다.
macOS는 `showInactive`를 `orderFront:`로 제공하며 key window 전환과 앱 활성화를 하지 않는다. macOS의 `activate`는 `UNSUPPORTED`다.
Linux에서는 계약, 정책, 재생성 수명 조정과 CLI 번들을 검증한다.
Windows의 `setContentPosition`, `setOuterSize`, `setContentBounds`, `setOuterBounds`는
물리 또는 논리 픽셀을 받으며 숨김 상태를 유지하고 최소화 및 최대화 중에는 일반
복원 영역을 변경한다. 전체화면은 거부한다. 2026-10-10 로컬 Win32와 WebView2에서
설정 후 조회 및 `windows.changed` 일치를 확인했다. 합성 DPI 메시지와 실제 물리
모니터 이동의 검증 범위는 [실행 기록](../architecture/windows-bun-results.md)에 구분했다.
macOS는 창 생성과 재생성, `isOpen`, show/hide/focus/close,
표시와 포커스 조회, `setContentProtection`, `isContentProtected`를 제공한다.
창 ID는 네이티브 수명마다 새로 발급한다. 임시 WebKit 프로필은 실행 중 재생성에서 유지한다.
`getSnapshot`, `windows.changed`, 크기, 위치, 전체화면, 닫기 확인 등 다른 공개 창 작업도 `UNSUPPORTED`다.

Windows의 앱 정의 `desktop`에 인자, 딥링크, 파일 열기와 종료 취소, 트레이 숨김을
구현했다. 초기 계약, 번들, 타입 검사는 Linux에서 수행했고 후속 Windows x64, Bun 1.4.2에서
실제 WebView2의 hide, veto, dev-veto, dev-hide, dev-pending 시나리오와 PowerShell 5.1 인자 전달을 통과했다.
Windows 실행기는 같은 시나리오를 실행한다. URL scheme과 파일 연결의 OS 등록은 미구현이다.
macOS Bun FFI 런타임은 `desktop`의 종료 취소, 수명주기 훅, 세션 종료, Dock 재활성화(`onReopen`)와 OS 파일, URL 열기(`onOpenUrls`)를 지원하고
`windows.lifecycle`, `windows.closeRequested`, `windows.respondClose`도 제공한다
([ADR 0021](../decisions/0021-macos-desktop-lifecycle.md)). `desktop.tray`와 `closeBehavior: "hide"`는
`UNSUPPORTED`이며 앱 번들의 `CFBundleURLTypes`와 `CFBundleDocumentTypes` 생성은 미구현이다. 단일 인스턴스 전달은
LaunchServices가 대신하므로 필요 없다. 실제 AppKit 시나리오는
macos-native CI에서 실행하지만 실제 로그아웃과 사용자의 Dock 클릭은 CI에서 확인하지 못한다.


## Windows 모니터 조회

Windows 창 플러그인은 모니터 열거, 주 모니터와 대상 창의 모니터,
물리 점과 rectangle의 가장 가까운 모니터 및 커서 화면 좌표를 조회한다.
현재 장치명 id, 물리 bounds와 workArea, DPI와 배율 및 선택적 드라이버 rotation과
정수 refresh rate를 반환한다. macOS에서는 새 조회 작업이 `UNSUPPORTED`다.
[창 API](../site/src/content/docs/reference/host/windows.mdx#모니터와-커서)를 따르며
실제 HWND와 WebView2 회귀는 Windows native CI에 포함한다.
물리 다중 모니터의 hotplug, 혼합 DPI와 회전은 수동 검증으로 남긴다.

Windows의 선택 power 플러그인은 AC와 배터리 상태, 호출 세션의 입력 idle 및
앱 수명의 system/display power request를 제공하고 AC와 배터리 상태 변경을 이벤트로 알린다.
macOS는 같은 플러그인으로 전원 상태(`getStatus`), 입력 idle(`getIdleTime`, `getIdleState`)과
앱 수명의 system/display power request(IOPMAssertion)를 제공하며
이벤트와 CPU 속도 제한은 `UNSUPPORTED`다. 다른 플랫폼은 모두 `UNSUPPORTED`다.
[power 계약](../site/src/content/docs/reference/plugins/power.mdx)을 따르며
실제 상태 query, 상태 변경 이벤트 경로와 request handle 정리는 Windows native CI에 포함한다.
macOS의 상태와 idle 조회는 `Check (macos-14)`의 전체 테스트에서 새 프로세스로 실행해 계약과 GC 압박 속 반복 조회의 유효한 결과를 확인하며
배터리가 없는 러너에서는 내장 배터리가 없는 응답만 검증한다.
물리 배터리 전환, 화면 timeout, idle 절전과 Modern Standby 검증은 수동 작업이다.

Windows의 선택 appearance 플러그인은 저장된 테마와 transparency 선호, DWM accent,
시스템 색과 고대비, reduced motion 및 screen reader 설정 플래그를 조회한다.
고대비이고 창 색이 어두우면 invertedColors가 true이며, 화면 색 필터는 반영하지 않는다.
macOS arm64는 AppKit UI 어댑터로 유효 앱 테마, accent와 sRGB 색,
NSWorkspace의 Increase Contrast, Invert Colors(`accessibilityDisplayShouldInvertColors`),
Reduce Motion, Reduce Transparency와 VoiceOver 플래그를 조회한다.
별도 systemTheme은 null이며 forcedColors는 false다. Increase Contrast를 강제 색이나
Accessibility 신뢰 권한을 보조 기술 사용으로 해석하지 않는다. 나머지 플랫폼은
`UNSUPPORTED`이며 [appearance 계약](../site/src/content/docs/reference/plugins/appearance.mdx)을 따른다.
실제 Win32 query 회귀는 Windows native CI에 포함한다. macOS native CI는 직접 AppKit
비교와 ad-hoc 서명한 compiled 앱에서 backend와 뷰 권한, 반복 조회와 종료를 검사한다.
테마 지정과 변경 이벤트,
실제 보조 기술 및 WebView 접근성 트리 검증은 후속 작업이다.

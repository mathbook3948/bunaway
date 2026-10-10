# 플랫폼 지원과 검증 범위

Windows 창 준비, 숨김 생성과 splashscreen 전환은 [창 API](../site/src/content/docs/reference/host/windows.mdx)를 따른다.
Windows 11 Pro x64 `10.0.26200`, Bun 1.4.2와 실제 WebView2에서 단계별 준비, 탐색과 재생성,
실패와 취소, SDK 기한 초과 및 전환 중 앱 유지를 확인했다.
Win32 메시지와 WinEvent로 숨김 생성 중 순간 표시, 활성화와 포커스가 없고 입력 포커스가 유지되는 것도 확인했다.
이 두 검증과 계약 검사 결과는 [Windows 실행 기록](../architecture/windows-bun-results.md)에 구분한다.
macOS 준비 API와 숨김 생성 옵션은 아직 지원하지 않는다.

현재 저장, 로그, 기능 조회, opener와 clipboard 플러그인은 Windows만 지원한다. 창 플러그인의 기본 제어는 macOS에서도 지원한다. 아래 macOS 파일 저장과 네이티브 API 검증 기록은 이관 전 구현의 기록이다. Bun FFI 제품 경로의 명령, 이벤트와 정책, 복구, 종료 검증은 [새 기록](../architecture/macos-bun-results.md)에 둔다.

기준일: 2026-10-10. “구현”은 출시 지원 보장이 아니다. 실제 OS, CPU와 테스트 범위를
기록하며, 공통 TypeScript 검사의 성공을 네이티브 호스트 성공으로 확대하지 않는다.

| 플랫폼 | 네이티브 구현 | 검증 환경, 범위 | 미검증, 제약 |
| --- | --- | --- | --- |
| Windows x64 | Bun 진입점, 직접 FFI UI Worker, WebView2, 번들 Bun x64 baseline | 로컬 FFI/모달/Host API/다중 창/복구/종료/독립 CLI 검증([기록](../architecture/windows-bun-results.md)); PR18의 번들 런처 검증은 아래 기록과 분리 | 최소 Windows, CPU, WebView2 설치 경로, 배포, 스토어 적합성 |
| macOS arm64 | Bun 진입점, 직접 FFI AppKit/WKWebView, 백엔드 Worker, 다중 창/뷰 | 로컬 26.7.1 arm64: 실제 WKWebView 회귀와 compiled 다중 창 API 검사. [Bun FFI 기록](../architecture/macos-bun-results.md)과 [이전 기록](../architecture/macos-native-results.md)을 구분 | Intel, 영속 프로필, 최소 OS, 현재 Windows 다중 창 메모 샘플, Developer ID, 공증, 설치 |
| macOS Intel | 고정 Bun 배포물, 해시 없음 | 없음. arm64 빌드 스크립트가 명시적으로 거부 | 별도 pin, 빌드, 실제 실행 검증 필요 |
| Linux | GTK, WebKitGTK 후보, 호스트 미구현 | Ubuntu 공통 검사, 생성 스키마 검사만 있음 | 네이티브 실행, UI, 프로세스 정리, 패키징 |
| Android | Java Activity, WebView, 번들 Bun과 공통 Core/SDK, Java 프로젝트 sync와 debug APK | API 36 x86_64 에뮬레이터. 명령, 이벤트, 취소, 자산과 프레임 경계, 화면 회전, 종료 | ARM64 실기기, API 29, 네이티브 플러그인, 외부 개발 서버, 백그라운드 복원, release/AAB/Store |
| iOS | Swift, WKWebView 후보, 호스트 미구현 | 없음 | Bun 실행/JIT, 수명주기, 서명, 스토어 정책 |

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
브라우저 프로필 영속성/뷰 분리와 동일한 지원이 아니다. 현재 macOS 회귀 fixture는
메모 상태를 Bun 메모리에 두며 네이티브 저장 플러그인을 검증하지 않는다. 이전 메모
fixture가 범위 제한 Host API 파일에서 복원한 결과는 선택 플러그인 이관 전 기록이다.

- Windows 독립 앱 패키지와 macOS 번들 Bun 패키지는 사용자 전역 Bun 없이 실행한다.
- macOS native CI는 `mise run host:macos -- --app`으로 `.app`을 만들고 **ad-hoc** 서명한 번들을 실행한다.
  서명 유지와 DMG 생성, PKG 조립도 검사한다. 이 검사의 코드 커밋 `fae4b80` 실행은
  [2026-10-07 CI](https://github.com/mathbook3948/bunaway/actions/runs/37554130779/job/112576288095)에서 통과했다.
- `LSMinimumSystemVersion=14.0`은 생성 plist의 값일 뿐 macOS 14 전체 지원 검증이 아니다.
- 프로덕션 Developer ID 서명, 실제 공증과 Gatekeeper, 설치 및 App Sandbox의 안정성은 별도 검증이 필요하다.
- CLI와 vanilla, Vite, React, Vue, Svelte 템플릿, 저장/로그/기능 조회 선택 플러그인 패키지,
  Windows 네이티브 어댑터는 구현했다. macOS 네이티브 플러그인 어댑터는 미구현이다.
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

Windows CLI는 `app.windows` 설정과 백엔드 `windows` API를 제공한다. 생성과 재생성,
show/hide/focus, 크기와 위치, 전체화면, 닫기 확인을 정식 지원하며 기능 조회에서
`supported`로 보고한다. 로컬 Windows x64, Bun 1.4.2에서 전체화면의 표시 상태와 좌표 복원,
닫기 확인, 브라우저 장애, 반복 생성과 자기 창 재생성, 세션 종료에 따른 생성 취소를 통과했다.
CI 실행 [37574470840](https://github.com/mathbook3948/bunaway/actions/runs/37574470840)에서
새 창 API의 실제 GUI 회귀는 통과했다. 같은 실행의 전체 네이티브 작업은 공용 기능 목록 테스트에서 실패했다.
Windows는 `showInactive`, `blur`, `activate`도 제공한다. 실제 두 Win32 창과 입력 필드에서
비활성 표시의 활성 창과 키보드 포커스 보존을 확인했다. 이번 실행 세션은 전경 전환을
거부했으므로 실제 전경 blur와 focus 성공은 미검증이다. 후보 권한과 거부 시 결과,
상태와 이벤트의 일치는 계약 및 DLL 대체 검사로 구분한다.
macOS의 세 API는 `UNSUPPORTED`다.
Linux에서는 계약, 정책, 재생성 수명 조정과 CLI 번들을 검증한다.
Windows의 `setContentPosition`, `setOuterSize`, `setContentBounds`, `setOuterBounds`는
물리 또는 논리 픽셀을 받으며 숨김 상태를 유지하고 최소화 및 최대화 중에는 일반
복원 영역을 변경한다. 전체화면은 거부한다. 2026-10-10 로컬 Win32와 WebView2에서
설정 후 조회 및 `windows.changed` 일치를 확인했다. 합성 DPI 메시지와 실제 물리
모니터 이동의 검증 범위는 [실행 기록](../architecture/windows-bun-results.md)에 구분했다.
macOS는 `app.windows`, 지연 생성과 재생성, 목록 및 열림 여부, show/hide/focus/close,
표시와 포커스 조회를 제공한다. 뷰마다 임시 WebKit 프로필을 분리하고 실행 중 재생성에서
유지한다. 크기, 위치, 전체화면, 닫기 확인 등 다른 공개 창 작업은 `UNSUPPORTED`다.

Windows의 앱 정의 `desktop`에 인자, 딥링크, 파일 열기와 종료 취소, 트레이 숨김을
구현했다. 초기 계약, 번들, 타입 검사는 Linux에서 수행했고 후속 Windows x64, Bun 1.4.2에서
실제 WebView2의 hide, veto, dev-veto, dev-hide, dev-pending 시나리오와 PowerShell 5.1 인자 전달을 통과했다.
Windows 실행기는 같은 시나리오를 실행한다. URL scheme과 파일 연결의 OS 등록은 미구현이다.
macOS Bun FFI 런타임은 `desktop`을 `UNSUPPORTED`로 거부한다.

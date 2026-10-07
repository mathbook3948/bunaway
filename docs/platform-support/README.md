# 플랫폼 지원과 검증 범위

현재 선택 네이티브 플러그인은 Windows만 지원한다. 아래 macOS 파일 저장과 네이티브 API 검증 기록은 이관 전 구현의 기록이다. 새 패키지와 permissions 정책으로 실행한 macOS 검증은 하지 않았다.

기준일: 2026-10-07. “구현”은 출시 지원 보장이 아니다. 실제 OS, CPU와 테스트 범위를
기록하며, 공통 TypeScript 검사의 성공을 네이티브 호스트 성공으로 확대하지 않는다.

| 플랫폼 | 네이티브 구현 | 검증 환경, 범위 | 미검증, 제약 |
| --- | --- | --- | --- |
| Windows x64 | Bun 진입점, 직접 FFI UI Worker, WebView2, 번들 Bun x64 baseline | 로컬 FFI/모달/Host API/다중 창/복구/종료/독립 CLI 검증([기록](../architecture/windows-bun-results.md)); PR18의 번들 런처 검증은 아래 기록과 분리 | 최소 Windows, CPU, WebView2 설치 경로, 배포, 스토어 적합성 |
| macOS arm64 | AppKit, WKWebView, 번들 Bun darwin-aarch64, 단일 창/뷰 | 이번 로컬 26.5.2, Actions 15.7.9: probe 50/50, 실제 WKWebView 8/8. 기존/새 실행은 [별도 기록](../architecture/macos-native-results.md) | Intel, 다중 창/뷰, 최소 OS, 현재 Windows 다중 창 메모 샘플, Developer ID, 공증, 설치 |
| macOS Intel | 고정 Bun 배포물, 해시 없음 | 없음. arm64 빌드 스크립트가 명시적으로 거부 | 별도 pin, 빌드, 실제 실행 검증 필요 |
| Linux | GTK, WebKitGTK 후보, 호스트 미구현 | Ubuntu 공통 검사, 생성 스키마 검사만 있음 | 네이티브 실행, UI, 프로세스 정리, 패키징 |
| Android | Kotlin, WebView 후보, 호스트 미구현 | 없음 | Bun 실행 경로, 수명주기, 배포 제약 |
| iOS | Swift, WKWebView 후보, 호스트 미구현 | 없음 | Bun 실행/JIT, 수명주기, 서명, 스토어 정책 |

## macOS CI와 CPU

GitHub 공식 [runner 표](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)와
[macOS 15 arm64 이미지](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md)를
기준으로 native job에 `macos-15`를 선택했다. 실제 `uname -m=arm64`, `RUNNER_ARCH=ARM64`,
OS, Xcode, 이미지 정보를 job에서 검사/기록한다. `darwin-aarch64.json`의 Bun 1.4.2
아카이브, 실행 파일, 라이선스 해시, Mach-O 아키텍처와 실제 버전도 빌드 중 확인한다.
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
- macOS native CI는 `run.sh --app`으로 `.app`을 만들고 **ad-hoc** 서명한 번들을 실행한다.
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
macOS 서명과 배포 스크립트는 `native/macos/distribute/`에 있으며 native CI에서 검사한다.
CLI의 `mac-direct`, `mac-store` 채널 어댑터 연결은 아직 구현하지 않았다.

Windows 배포 근거와 한계:
- PR16의 자체 서명 테스트 인증서, 기존 설치 테스트는 당시 C++ 호스트 산출물을 대상으로
  했다. 해당 결과는 삭제된 C++ 호스트를 싣지 않는 PR18 Bun FFI 설치 파일의 서명/설치
  검증으로 간주하지 않는다.
- PR18 Windows 레이아웃은 `runtime/bun.exe`, FFI 자산, `launch.ps1`을 요구한다. 일반
  설치 파일의 앱 바로가기는 Windows PowerShell을 통해 런처를 실행하며, 런처는 Bun이
  시작되기 전에 허용된 환경변수만 전달하고 실행 파일, 자산 해시를 확인한다.
- 런타임 서명 뒤에는 `manifest.bun.packagedSha256`과 런처 해시 핀을 실제 배포 바이트에
  맞춘다. `executableSha256`와 소스 revision은 upstream provenance로 보존한다. PR18의
  PE-overlay 테스트는 Authenticode 서명이 아니라 서명으로 바뀐 실행 파일 바이트를
  대체한다. 실제 Windows CI/설치 결과만 해당 경로의 통합 검증 근거다.
- `win-store-unpackaged`는 Store 제출용 일반 EXE/MSI 경로다. Partner Center 제출과
  프로덕션 인증서는 검증 범위가 아니다.
- `win-store-msix` 채널 이름은 설정, 진단을 위해 등록돼 있지만 Bun FFI 패키지 생성은
  명시적으로 차단한다. MSIX 앱 활성화에서 Bun을 시작하면서 런처와 동일한 제한된 초기
  환경을 보장하는 경로가 아직 검증되지 않았다. MSIX 패키징, 스토어 제출 지원을 주장하지
  않는다.

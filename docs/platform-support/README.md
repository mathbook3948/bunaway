# 플랫폼 지원과 검증 범위

기준일: 2026-10-05. “구현”은 출시 지원 보장이 아니다. 실제 OS·CPU와 테스트 범위를
기록하며, 공통 TypeScript 검사의 성공을 네이티브 호스트 성공으로 확대하지 않는다.

| 플랫폼 | 네이티브 구현 | 검증 환경·범위 | 미검증·제약 |
| --- | --- | --- | --- |
| Windows x64 | Win32·WebView2, 번들 Bun x64 baseline | 기존 Server 2022 기록·native CI, B probe·C 다중 창/뷰 정책/복구/종료 | 최소 Windows·CPU, WebView2 설치 경로, 설치 프로그램·서명·배포 |
| macOS arm64 | AppKit·WKWebView, 번들 Bun darwin-aarch64, 단일 창/뷰 | 이번 로컬 26.5.2·Actions 15.7.9: probe 50/50·실제 WKWebView 8/8. 기존/새 실행은 [별도 기록](../architecture/macos-native-results.md) | Intel·다중 창/뷰·최소 OS, 현재 Windows 다중 창 메모 샘플, Developer ID·공증·설치 |
| macOS Intel | 고정 Bun 배포물·해시 없음 | 없음. arm64 빌드 스크립트가 명시적으로 거부 | 별도 pin·빌드·실제 실행 검증 필요 |
| Linux | GTK·WebKitGTK 후보, 호스트 미구현 | Ubuntu 공통 검사·생성 스키마 검사만 있음 | 네이티브 실행·UI·프로세스 정리·패키징 |
| Android | Kotlin·WebView 후보, 호스트 미구현 | 없음 | Bun 실행 경로·수명주기·배포 제약 |
| iOS | Swift·WKWebView 후보, 호스트 미구현 | 없음 | Bun 실행/JIT·수명주기·서명·스토어 정책 |

## macOS CI와 CPU

GitHub 공식 [runner 표](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)와
[macOS 15 arm64 이미지](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md)를
기준으로 native job에 `macos-15`를 선택했다. 실제 `uname -m=arm64`, `RUNNER_ARCH=ARM64`,
OS·Xcode·이미지 정보를 job에서 검사/기록한다. `darwin-aarch64.json`의 Bun 1.4.2
아카이브·실행 파일·라이선스 해시, Mach-O 아키텍처와 실제 버전도 빌드 중 확인한다.
runner 라벨이 바뀌거나 CPU가 맞지 않으면 실패하며 Rosetta나 skip-success로 대체하지 않는다.

기존 로컬 26.5.2 arm64 성공만으로 macOS 15의 GUI/WKWebView 성공을 주장하지 않는다.
네이티브 driver가 실제 페이지 보고서, 리소스 수신/차단, 렌더러 종료 후 재생성과
Bun 종료를 요구한다. GUI가 없거나 WebKit이 시작하지 못하면 테스트 실패다.
그런 runner에서는 GUI 세션을 갖춘 self-hosted Apple Silicon runner에서 **같은 suite**를
실행하는 것이 대안이며, 현재 CI를 성공 처리하거나 그 검사를 대신하지 않는다.

## 패키지와 출시 검증

macOS WKWebView는 현재 비영속 `WKWebsiteDataStore`를 사용한다. Windows의
브라우저 프로필 영속성/뷰 분리와 동일한 지원이 아니다. macOS 재시작 시 브라우저
저장소는 초기화되며, 메모는 별도 범위 제한 Host API 파일에서 복원한다.

- Windows 독립 앱 패키지와 macOS 번들 Bun 패키지는 사용자 전역 Bun 없이 실행한다.
- macOS `run.sh --app`은 `.app` 레이아웃과 **ad-hoc** 서명을 만든다. 기존 로컬
  코드 서명 확인·실행 기록은 있으며, 이번 native CI는 `.app` 생성/실행을 검사하지 않는다.
- `LSMinimumSystemVersion=14.0`은 생성 plist의 값일 뿐 macOS 14 전체 지원 검증이 아니다.
- **Developer ID 서명·hardened runtime/entitlements·공증·stapling·Gatekeeper·설치**와
  App Sandbox·배포 채널 결정은 별도 작업이다. ad-hoc 서명 성공은 이를 보장하지 않는다.
- CLI·템플릿·기본 플러그인·릴리스 자동화는 미구현이며 PRD 출시 기준은 미충족이다.

## 패키징(공통 계약)

`packages/packaging`의 채널 중립 계약(`packaging.json` v1, 어댑터 입출력,
`PKG_*` 진단, 서명 후 `packagedSha256` 규칙)과 `bunaway package <channel>` 진입점,
Windows 어댑터 3개(`win-direct` Inno 인스톨러·`win-store-msix`·
`win-store-unpackaged` + 제출 체크리스트)가 구현됐다. macOS `mac-direct`·
`mac-store` 어댑터는 별도 작업이다.

Windows 검증 결과(Windows Server 2022, 자체 서명 테스트 인증서):
- `win-direct`: 패키지 생성 → `/VERYSILENT` 설치 → 호스트 실행 →
  데이터 디렉터리 생성 → `/VERYSILENT` 제거 → `%LOCALAPPDATA%\bunaway\<appId>`
  보존까지 검증됐다.
- `win-store-unpackaged`: 서명 인스톨러 생성·`signtool verify`·사일런트
  설치/제거 검증. Partner Center 제출·프로덕션 CA는 미검증.
- `win-store-msix`: `makeappx` 패킹·서명·`Add-AppxPackage` 설치·등록까지
  검증됐다. **패키지 안에서의 실행(앱 활성화)은 이 테스트 환경에서 확인되지
  않았다** — 활성화 시도가 이벤트 로그에는 성공으로 기록되지만 프로세스가
  생성되지 않는다(같은 페이로드는 압축 해제 상태로 정상 실행되며, UWP
  시스템 앱은 활성화된다). 환경 한계로 판단하며, 실제 배포/스토어 검증과
  데이터 보존은 미검증으로 남겨둔다.

# bunaway

웹 UI와 TypeScript 백엔드, 앱 패키지에 번들된 Bun 런타임을 결합하는 크로스플랫폼
앱 프레임워크다. 제품 요구사항은 [PRD](./docs/PRD.md)에 정리되어 있다.

[문서 안내](./docs/README.md)에서 공통 용어, 설계 결정과 구현 계약을 찾을 수 있다.

`protocol`의 메시지·정책 스키마, JSON 검증·직렬화와 버전 협상이 동작한다.
`createClient`·`createCore`·`runBunApp`, Windows Win32·WebView2와 macOS AppKit·WKWebView
호스트를 구현했다. Windows는 다중 창·뷰별 정책 분리, macOS는 단일 창/뷰의
메모 저장→완료 이벤트→화면 갱신, 재실행 후 복원과 렌더러 복구를 검증한다.
이 앱 패키지의 실행은 사용자 Bun 설치·PATH에 의존하지 않는다.
[Windows Bun FFI 실행 결과](./docs/architecture/windows-bun-results.md),
[기존 Windows C 실행 결과](./docs/architecture/windows-host-results.md),
[이전 B 실험 결과](./docs/architecture/windows-probe-results.md)와
[macOS 검증 기록](./docs/architecture/macos-native-results.md),
[진행 상태](./docs/architecture/progress.md)를 참고한다.
[공통 API](./docs/architecture/common-api.md)는 SDK·코어·Host API가 따르는 계약이다.
CLI의 create/validate/doctor/dev/build와 vanilla 템플릿은 구현했다.
[프레임워크 artifact 설치·업그레이드](./docs/framework-distribution.md)는 저장소 체크아웃
없는 개발 흐름과 정확한 버전의 CLI·SDK 패키지 설치을 제공한다. 공개 registry publish는 하지
않았으며 프레임워크 라이선스 결정은 미해결이다. 기본 로그/저장 플러그인은 미구현이다.
macOS Intel·다중 창/뷰,
Linux·모바일 네이티브 호스트와 설치·배포 검증은 포함하지 않는다.
macOS `.app` 생성·ad-hoc 서명은 Developer ID 서명·공증·설치 검증과 다르다.
[플랫폼 지원 범위](./docs/platform-support/README.md)에서 환경과 제한을 확인한다.
이전 런타임 C ABI는 동일 프로세스 설계의 기록으로 보존한다.

## 시작하기

자기 앱을 만드는 개발자는 [로컬 tarball 설치 안내](./docs/framework-distribution.md)를
따른다. 아래 mise 절차는 bunaway 프레임워크 자체를 개발하는 저장소 기여자용이다.

[mise](https://mise.jdx.dev/getting-started)를 설치한 뒤 저장소 루트에서 실행한다.

```sh
mise trust
mise install
mise run install
mise run check
```

Bun은 `mise.toml`과 `package.json`에 **1.4.2**로 고정되어 있다.
전역 Bun 대신 `mise run` 또는 `mise exec -- bun ...`을 사용한다.
새 환경은 `bun.lock`을 사용하는 frozen install로 의존성을 재현한다.

## 명령

| 명령 | 동작 |
| --- | --- |
| `mise run install` | lockfile을 변경하지 않고 의존성 설치 |
| `mise run check` | 포맷·린트·TypeScript·계약 테스트 검사 |
| `mise run test` | 프로토콜·SDK·코어·Host API 계약과 Bun 프로세스 IPC 테스트 |
| `mise run protocol:generate` | 네이티브용 JSON Schema 생성 |
| `mise run host:windows` | Windows WebView2 앱 패키지 빌드와 SDK·코어·메모·경계·종료 통합 검증 |
| `mise run probe:macos` | macOS arm64 번들 Bun 패키지 빌드와 프로세스 IPC·종료 통합 검증 |
| `mise run host:macos` | macOS arm64 실제 WKWebView·SDK·코어·메모·경계·종료 회귀 검증 |
| `mise run typecheck` | 각 workspace 타입 검사 |
| `mise run format` | 코드와 JSON 포맷 적용 |
| `mise run format:check` | 포맷 검사 |
| `mise run lint` | 코드 린트 |

저장소 검사 명령은 mise에서 관리한다. 루트의 `bun run framework:pack`과
`bun run framework:check <추출한 package 경로>`는 개발자 설치 artifact를 검증한다.
생성 앱의 `bun run dev`·`bun run build`는 기존 SDK/네이티브 빌드를 재사용한다.
선택적 `dev.command`·`dev.url`로 [외부 Vite·Next.js UI 개발 서버](./docs/development-server.md)를
연결하면 UI 갱신은 해당 서버에 맡기고 CLI는 서버 수명주기와 백엔드 재시작을 관리한다.
`bunaway create <directory> --template vite`는 Vite 개발 서버와 생산 빌드를 연결한
vanilla TypeScript 앱을 생성한다. 기본 템플릿은 기존 `vanilla`다.
Windows 호스트의 빌드·패키징은
`native/windows/bun/run.ps1`이 담당한다. Bun이 앱 진입점이고 UI Worker가
Win32·WebView2 COM을 직접 소유한다. 생성 앱은 `windowsApp`에 AppDefinition 모듈을 지정한다.
Windows 빌드는 PowerShell 7과 고정 Bun만 필요하며 C++ 컴파일은 하지 않는다.
WebView 앱 실행에는 WebView2 Evergreen 런타임이 필요하다.
생성된 `build/windows-probe-package/`는 Bun 개발 도구 없이 실행되는 독립 실험 패키지다.

macOS는 Apple Silicon, Xcode Command Line Tools와 GUI 세션이 필요하다.
`probe:macos` 다음 `host:macos`를 **직렬 실행**한다. 두 빌드가 공유 Bun 캐시를
초기 다운로드·추출하므로 병렬 cold-cache 실행은 안전하지 않다.
`native/macos/host/run.sh --app`은 회귀 앱의 `.app` 생성과 ad-hoc 서명을 추가한다.
[메모 예제](examples/memo/README.md)는 CLI 생성 앱과 같은 구조이며 예제 폴더에서 `bun run dev`로 실행한다.

## CI

[GitHub Actions CI](https://github.com/mathbook3948/bunaway/actions/workflows/ci.yml)는
모든 PR과 `main` push에서 실행하며 Actions 화면에서 수동 실행도 가능하다.

- Ubuntu 24.04·macOS 14·Windows Server 2022에서 `mise run install`과
  `mise run check`로 frozen install·포맷·린트·타입·계약 테스트를 검사한다.
- Ubuntu에서 `mise run protocol:generate` 후 diff를 검사해 커밋된 네이티브
  스키마가 현재 TypeScript 정의와 일치하는지 확인한다.
- 별도 Windows 작업에서 `mise run host:windows`로 Bun FFI·WebView2·모달 비동기 진행·
  경계/파일/다중 창/정리와 이동한 독립 CLI 프로젝트를 검증한다. 기존 Windows C++ 호스트·probe는 삭제했다.
  결과 JSON과 호스트 로그는 성공·실패 시 모두 `windows-native-diagnostics`
  artifact로 7일간 보관한다. 생성 전 실패한 경우에는 파일이 없을 수 있다.
- 별도 `macos-15` ARM64 작업에서 runner CPU와 `darwin-aarch64` pin을 확인하고
  `mise run probe:macos`→`mise run host:macos`를 직렬 실행한다. 다운로드·실행 파일
  해시·아키텍처·버전을 확인하고, 실제 AppKit/WKWebView 페이지 결과·리소스 요청·
  렌더러 재생성·Bun 종료를 검사한다. GUI가 실행되지 않으면 timeout/오류로 실패한다.
  결과 JSON, 빌드·드라이버 로그, 호스트 stderr와 테스트별 호스트/페이지 로그는
  성공·실패 모두 `macos-native-diagnostics` artifact로 7일간 보관한다.
  `bash -e -o pipefail`로 `tee`가 테스트 실패를 숨기지 않게 한다. 빌드/초기 설정 실패나
  강제 취소 전에는 JSON이 없을 수 있으며, 그 경우 생성된 로그를 확인한다.

CI도 `mise.toml`의 Bun 버전을 사용한다. 같은 PR·브랜치의 새 실행은 이전 실행을
취소한다. `.app`·서명·공증·설치·배포·릴리스와 Linux/모바일 네이티브 호스트는 검사하지 않는다.
기존 로컬 결과를 다른 OS/CPU의 CI 성공으로 간주하지 않는다. 실제 실행 환경과 결과는
[macOS 기록](./docs/architecture/macos-native-results.md)에 분리해서 남긴다.

## 디렉터리

```text
packages/   protocol/  client-sdk/  backend-sdk/  core/  runtime-bun/  cli/
native/     host-api/  windows/  macos/  linux/  android/  ios/
runtime/    bun-bundle/  patches/  build-manifests/
renderers/  system-webview/  chromium/
plugins/    log/  storage/
templates/  vanilla/  react/  vue/  svelte/
examples/   memo/  commands/  lifecycle/  permissions/
tests/      protocol/  core/  conformance/  security/  lifecycle/
docs/       architecture/  api/  platform-support/  decisions/  agents/
```

[모듈 의존성과 타입 환경](./docs/architecture/workspace.md)을 참고한다.
폴더만 준비한 영역은 각 영역의 README에 구현 상태를 기록했다.

## 버전 변경

Bun 변경 시 `mise.toml`의 `tools.bun`과 `package.json`의
`packageManager`·`engines.bun`을 함께 수정한다.
`mise install` 후 `mise exec -- bun install`로 필요한 lockfile 변경을 만들고
`mise run check`를 확인한다.
`bun upgrade`로 mise가 관리하는 실행 파일을 직접 바꾸지 않는다.

외부 개발 의존성도 정확한 버전으로 고정하고 `bun.lock`을 관리한다.
앱 패키지에 포함하는 Windows/macOS Bun 실행 파일의 버전·소스 revision·해시는
[runtime](./runtime/README.md)의 manifest로 별도 고정한다.

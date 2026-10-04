# bunaway

웹 UI와 TypeScript 백엔드, 앱 패키지에 번들된 Bun 런타임을 결합하는 크로스플랫폼
앱 프레임워크다. 제품 요구사항은 [PRD](./docs/PRD.md)에 정리되어 있다.

[문서 안내](./docs/README.md)에서 공통 용어, 설계 결정과 구현 계약을 찾을 수 있다.

`protocol`의 메시지·정책 스키마, JSON 검증·직렬화와 버전 협상이 동작한다.
Windows B 단계는 WebView 없는 C++ 호스트와 번들 Bun 1.4.2로 실행·IPC·종료를
검증했다. 사용자 기기에 Bun 설치를 요구하지 않는다.
[실행 결과](./docs/architecture/windows-probe-results.md)와
[진행 상태](./docs/architecture/progress.md)를 참고한다.
SDK·코어·호스트를 병렬 구현할 [공통 API](./docs/architecture/common-api.md)를 준비했다.
SDK·코어 실행, CLI와 실제 WebView 앱은 아직 구현하지 않았고 모바일 실행도 검증하지 않았다.
이전 런타임 C ABI는 동일 프로세스 설계의 기록으로 보존한다.

## 시작하기

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
| `mise run test` | 프로토콜·정책 계약 테스트 |
| `mise run protocol:generate` | 네이티브용 JSON Schema 생성 |
| `mise run probe:windows` | C++ 호스트·Bun 패키지 빌드와 프로세스 IPC·종료 통합 검증 |
| `mise run typecheck` | 각 workspace 타입 검사 |
| `mise run format` | 코드와 JSON 포맷 적용 |
| `mise run format:check` | 포맷 검사 |
| `mise run lint` | 코드 린트 |

루트 명령은 mise에서 관리하고, 패키지에는 `typecheck`만 둔다.
실행 가능한 앱이 없으므로 `dev`·`build` 명령은 앱 구현과 함께 추가한다.
Windows 실험은 PowerShell 7, MSVC C++ Build Tools와 CMake/Ninja가 필요하다.
생성된 `build/windows-probe-package/`는 Bun 개발 도구 없이 실행되는 독립 실험 패키지다.

## 디렉터리

```text
packages/   protocol/  client-sdk/  backend-sdk/  core/  runtime-bun/  cli/
native/     host-api/  windows/  macos/  linux/  android/  ios/
runtime/    bun-bundle/  patches/  build-manifests/
renderers/  system-webview/  chromium/
plugins/    log/  storage/
templates/  vanilla/  react/  vue/  svelte/
examples/   commands/  lifecycle/  permissions/
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
배포할 Bun 실행 파일의 버전·소스 revision·해시 고정은
[runtime](./runtime/README.md)의 별도 작업이다.

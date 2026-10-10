# bunaway

웹 UI와 TypeScript 백엔드로 앱을 만드는 크로스플랫폼 프레임워크다.
앱 패키지에 Bun 런타임을 함께 넣어 실행한다. 제품 요구사항은 [PRD](./docs/PRD.md)에 정리되어 있다.

[개발 가이드 사이트](./docs/site/README.md)에서 전체 구조와 첫 앱 실행을 익힌 뒤 뷰별 정책과 명령, 이벤트를 살펴본다. 로컬에서 `bun run docs:dev`로 열 수 있다.
[문서 안내](./docs/README.md)에서 공통 용어, 설계 결정과 구현 계약을 찾을 수 있다.

현재 개별 네이티브 플러그인은 Windows x64에서 지원한다. macOS arm64의 기존 검증 기록은 아래 지원 문서에서 현재 구현과 구분한다.
CLI는 vanilla, Vite, React, Vue, Svelte 템플릿으로 단일 창 앱을 생성한다.
앱 실행에는 패키지에 포함된 Bun을 사용하므로 최종 사용자가 Bun을 설치할 필요는 없다.
Windows 앱 실행에는 WebView2 런타임이 필요하다.

공개 registry에는 아직 배포하지 않았다. 첫 앱은 [로컬 패키지 설치 안내](./docs/framework-distribution.md)를 따른다.
프레임워크 라이선스는 아직 결정되지 않았다.
플랫폼별 지원 상태와 배포 검증 범위는 [플랫폼 지원 범위](./docs/platform-support/README.md)에서 확인한다.

앱 백엔드의 명령과 서비스에서는 `@bunaway/plugin-storage`, `@bunaway/plugin-log`,
`@bunaway/plugin-capabilities`, `@bunaway/plugin-windows`를 개별 설치하고 등록한 뒤 함수를 호출한다. 호출한 명령의 권한과 취소 신호는 자동으로 연결한다.
예를 들어 명령이 호출한 서비스 함수에서 다음처럼 파일을 저장한다.

```ts
import { storage } from "@bunaway/plugin-storage";

export async function save(text: string) {
  return storage.writeText({ scope: "appData", path: "notes/memo.txt", text });
}
```

뷰의 정책에 `appData/notes` 쓰기 권한이 필요하다. 명령 밖이나 완료한 명령의 작업에서는 호출을 거부한다.
실행 범위와 로그, 기능 조회 사용법은 [백엔드 Host API](./docs/site/src/content/docs/reference/backend/host-api.mdx)를 따른다.

저장, 앱 로그, 기능 지원 조회를 개별 플러그인으로 설치하는 구조는
[ADR 0013](./docs/decisions/0013-optional-native-plugins.md)에서 확정했다.
[공개 계약](./docs/architecture/plugins.md)에 따라 Windows 실행과 개별 패키지 배포를 구현했다.
기본 템플릿은 저장 플러그인만 설치하고 등록한다.
플러그인은 화면과 백엔드에서 `@bunaway/plugin-storage`처럼 같은 경로로 import한다.
플러그인 `setup`의 이벤트 발행은 앱 백엔드의 수명을 따른다. 종료 신호가 취소되면 `events.emit`은 `CANCELLED`로 실패한다. [이벤트 수명 안내](./docs/site/src/content/docs/reference/backend/events.mdx)를 참고한다.
새 플러그인은 `plugin.json`, `src/index.ts`, `src/windows.ts`로 시작한다. 필요하면 제작자가 파일을 추가한다.
생성 앱의 타입 검사와 빌드는 실행 환경에 맞는 구현을 선택한다.

## 프레임워크 개발 환경

자기 앱을 만드는 개발자는 [로컬 tarball 설치 안내](./docs/framework-distribution.md)를
따른다. 아래 mise 절차는 bunaway 프레임워크 자체를 개발하는 저장소 기여자용이다.

[mise](https://mise.jdx.dev/getting-started)를 설치한 뒤 저장소 루트에서 실행한다.

```sh
mise trust
mise install
mise run install
mise run hooks:install
mise run check
```

Bun은 `mise.toml`과 `package.json`에 **1.4.2**로 고정되어 있다.
전역 Bun 대신 `mise run` 또는 `mise exec -- bun ...`을 사용한다.
새 환경은 `bun.lock`을 사용하는 frozen install로 의존성을 재현한다.

Lefthook은 `mise.toml`에 **2.2.1**로 고정되어 있다. 새 clone에서는
`mise run hooks:install`로 Git 훅을 설치한다. 커밋 전에 stage한 파일의
Biome 포맷과 린트, Java 포맷, `git diff --cached --check`의 공백 오류와 충돌 마커를 검사한다.
부분적으로 stage한 파일은 stage하지 않은 변경을 잠시 숨겨 커밋할 내용만 검사하고,
검사가 끝나면 복원한다. 훅은 파일을 자동 수정하거나 다시 stage하지 않는다.
검사 실패 시 포맷은 `mise run format`으로 수정하고 린트, 공백 오류와 충돌 마커는
직접 해결한 뒤 수정한 파일을 다시 stage하고 커밋한다.
Java는 Biome이 지원하지 않으므로 `mise.toml`에 **1.36.1**로 고정한 google-java-format의
AOSP 스타일로 포맷한다. mise가 OS별 실행 파일을 설치하므로 JDK가 없어도 된다.
pre-push 훅은 사용하지 않는다. 전체 타입 검사, 테스트와 플랫폼 검증은 CI에서 수행한다.

## 화면에서 앱 기능 사용하기

앱 정의에서 추론한 타입을 클라이언트에 지정하면 명령 이름과 입력, 결과, 이벤트 데이터의 타입을 검사할 수 있다.
`client.invoke`는 백엔드 명령을 실행하고 결과를 받는다. `client.listen`은 백엔드 이벤트를 구독한다.

```ts
import { createClient } from "@bunaway/client";
import type { CommandsOf, EventsOf } from "@bunaway/backend";
import type { app } from "../src-bunaway/app.ts";

async function start(): Promise<void> {
  const client = createClient<CommandsOf<typeof app>, EventsOf<typeof app>>();
  const text = await client.invoke("message.read", null);
  await client.invoke("message.save", text);
}

void start().catch(console.error);
```

위 예제는 UI 초기화 함수에서 클라이언트를 만들고 생성 오류와 호출 실패를 처리한다.
컴포넌트와 이벤트 핸들러에서 같은 클라이언트를 사용한다.
UI 컴포넌트가 사라지면 `client.listen`이 반환한 `unlisten`으로 해당 구독을 해제한다.
공유 클라이언트는 컴포넌트마다 닫지 않으며 페이지 종료 때 자동으로 정리된다.
구독 성공 응답이 잘못되면 `INTERNAL` 오류로 연결을 닫고 진행 중 요청과 활성 구독을 정리한다.
호출은 `bunaway dev`로 연 창이나 배포 앱의 WebView에서 동작한다. 일반 브라우저에는
브리지가 없어 `UNSUPPORTED`로 실패한다. 기존 `createClient({ transport, hello })`는
사용자 정의 연결, 테스트에 사용할 수 있다. 직접 import하는 함수 API도 계속 지원한다.
타입 추론과 취소, 오류, 수명 규칙은 [클라이언트 API](./docs/architecture/common-api.md#클라이언트와-transport)에 있다.

## 명령

| 명령 | 동작 |
| --- | --- |
| `mise run install` | lockfile을 변경하지 않고 의존성 설치 |
| `mise run hooks:install` | Lefthook pre-commit 훅 설치 |
| `mise run check:staged` | stage한 파일의 포맷과 린트 검사 |
| `mise run check` | 포맷, 린트, TypeScript, 계약 테스트 검사 |
| `mise run test` | 프로토콜, SDK, 코어, Host API 계약과 Bun 프로세스 IPC 테스트 |
| `mise run protocol:generate` | 네이티브용 JSON Schema 생성 |
| `mise run host:windows` | Windows WebView2 앱 패키지 빌드와 SDK, 코어, 메모, 경계, 종료 통합 검증 |
| `mise run host:macos` | macOS arm64 실제 WKWebView, SDK, 코어, 메모, 경계, 종료 회귀 검증 |
| `mise run typecheck` | 각 workspace 타입 검사 |
| `mise run format` | 코드, JSON과 Java 포맷 적용 |
| `mise run format:check` | Biome 포맷 검사 |
| `mise run format:java` | Java 포맷 적용 |
| `mise run format:java:check` | Java 포맷 검사 |
| `mise run lint` | 코드 린트 |

저장소 검사 명령은 mise에서 관리한다. 루트의 `bun run framework:pack`과
`bun run framework:check <추출한 package 경로>`는 개발자 설치 artifact를 검증한다.

코드 포맷은 루트 `biome.json`을 따른다. 들여쓰기는 공백 2칸, 줄 너비는 80이며
JS/TS 객체와 배열은 여러 줄로 펼친다. JSX 속성도 여러 줄로 배치한다.
조건문과 반복문에는 본문이 한 문장이어도 중괄호를 쓴다.
초기화, 검증, 실행, 정리처럼 역할이 바뀌는 지점에는 빈 줄을 한 줄 둔다.
Biome은 이 빈 줄을 자동으로 추가하지 않으므로 작성과 리뷰 때 구분한다.
수정한 코드는 `mise run format`을 실행한 뒤 `mise run check`로 검증한다.

생성 앱의 `bun run dev`, `bun run build`는 기존 SDK/네이티브 빌드를 재사용한다.
선택적 `dev.command`, `dev.url`로 [외부 Vite, Next.js UI 개발 서버](./docs/development-server.md)를
연결하면 UI 갱신은 해당 서버에 맡기고 CLI는 서버 수명주기와 백엔드 변경을 관리한다.
Windows의 호환되는 명령 구현 변경은 코어, 상태, 세션과 창을 유지하며 앱 코드만 교체한다.
계약과 플러그인, 상태 초기값 또는 실행 설정이 바뀌면 전체 재시작한다.
`bunaway create <directory> --template vite`는 공식 create-vite의 기본 로고, 카운터 화면에
Vite 개발 서버와 프로덕션 빌드를 연결한
vanilla TypeScript 앱을 생성한다. `--template react`, `vue`, `svelte`로 각 UI 프레임워크의
TypeScript + Vite 앱을 생성할 수 있다. 기본 템플릿은 기존 `vanilla`다.
Windows 빌드 의존성은 CLI의 `native-build.ts`가 준비한다.
`tests/lifecycle/run-native.ts`는 회귀 테스트용 호스트 패키지를 만들고 검증한다. Bun이 앱 진입점이고 UI Worker가
Win32, WebView2 COM을 직접 소유한다. 생성 앱은 `build.app`에 AppDefinition 모듈을 지정한다.
Windows 빌드는 Windows 기본 제공 tar와 고정 Bun만 필요하며 C++ 컴파일은 하지 않는다.
WebView 앱 실행에는 WebView2 Evergreen 런타임이 필요하다.
생성된 `build/windows-bun-package/`는 별도의 Bun 설치 없이 실행할 수 있는 회귀 테스트 패키지다.

macOS는 Bun 직접 FFI를 사용한다. Apple Silicon과 GUI 세션, codesign이 필요하며 C 컴파일러는 필요하지 않다.
`mise run host:macos`로 제품 호스트를 빌드하고 실제 WKWebView 회귀를 실행한다.
`mise run host:macos -- --app`은 회귀 앱의 `.app` 생성과 ad-hoc 서명을 추가한다.
[메모 예제](examples/memo/README.md)는 CLI 생성 앱과 같은 구조이며 예제 폴더에서 `bun run dev`로 실행한다. `bun run build`는 웹 UI와 앱을 함께 빌드한다.

## CI

[GitHub Actions CI](https://github.com/mathbook3948/bunaway/actions/workflows/ci.yml)는
모든 PR과 `main` push에서 실행하며 Actions 화면에서 수동 실행도 가능하다.

- Ubuntu 24.04, macOS 14, Windows Server 2022에서 `mise run install`과
  `mise run check`로 frozen install, 포맷, 린트, 타입, 계약 테스트를 검사한다.
- Ubuntu에서 `mise run protocol:generate` 후 diff를 검사해 커밋된 네이티브
  스키마가 현재 TypeScript 정의와 일치하는지 확인한다.
- 별도 Windows 작업에서 `mise run host:windows`로 Bun FFI, WebView2, 모달 비동기 진행,
  경계/파일/다중 창/정리와 이동한 독립 CLI 프로젝트를 검증한다. 기존 Windows C++ 호스트, probe는 삭제했다.
  결과 JSON과 호스트 로그는 성공, 실패 시 모두 `windows-native-diagnostics`
  artifact로 7일간 보관한다. 생성 전 실패한 경우에는 파일이 없을 수 있다.
- 별도 `macos-15` ARM64 작업에서 runner CPU와 `darwin-aarch64` pin을 확인하고
  `mise run host:macos -- --app`을 실행한다. 다운로드, 실행 파일
  해시, 아키텍처, 버전을 확인하고, 실제 AppKit/WKWebView 페이지 결과, 리소스 요청,
  렌더러 재생성, Bun 종료를 검사한다. GUI가 실행되지 않으면 timeout/오류로 실패한다.
  ad-hoc 서명한 `.app`의 실행과 서명 유지, 배포 스크립트의 DMG 생성과 PKG 조립도 검사한다.
  결과 JSON, 빌드, 드라이버 로그, 호스트 stderr와 테스트별 호스트/페이지 로그는
  성공, 실패 모두 `macos-native-diagnostics` artifact로 7일간 보관한다.
  `bash -e -o pipefail`로 `tee`가 테스트 실패를 숨기지 않게 한다. 빌드/초기 설정 실패나
  강제 취소 전에는 JSON이 없을 수 있으며, 그 경우 생성된 로그를 확인한다.

CI도 `mise.toml`의 Bun 버전을 사용한다. 같은 PR, 브랜치의 새 실행은 이전 실행을
취소한다. Windows 설치 검사는 Inno Setup이 있을 때 실행하고, 없으면 건너뛴 사실을 로그에 남긴다.
프로덕션 인증서 서명, 실제 공증, Store 제출, 공개 릴리스와 Linux/모바일 네이티브 실행은 검사하지 않는다.
실제 실행 환경과 결과는 [macOS 기록](./docs/architecture/macos-native-results.md)에 남긴다.
로컬 검증 결과와 각 OS 및 CPU의 CI 결과를 따로 기록한다.

## 디렉터리

```text
packages/   protocol/  client-sdk/  backend-sdk/  plugin-sdk/  core/  runtime-bun/  cli/
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
`packageManager`, `engines.bun`을 함께 수정한다.
`mise install` 후 `mise exec -- bun install`로 필요한 lockfile 변경을 만들고
`mise run check`를 확인한다.
`bun upgrade`로 mise가 관리하는 실행 파일을 직접 바꾸지 않는다.

외부 개발 의존성도 정확한 버전으로 고정하고 `bun.lock`을 관리한다.
앱 패키지에 포함하는 Windows/macOS Bun 실행 파일의 버전, 소스 revision, 해시는
[runtime](./runtime/README.md)의 manifest로 별도 고정한다.

선택 플러그인은 Core와 Backend SDK를 의존하지 않는다. 공통 타입과 실행 컨텍스트는 `@bunaway/plugin-api`에 두며 창 제어도 `windowsPlugin`을 명시적으로 등록한다. [분리 결정](docs/decisions/0014-optional-plugin-packages.md)을 참고한다.

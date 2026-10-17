# Workspace structure

Bun workspaces에는 `docs/site`, `packages/*`, `plugins/*`와
`tests/fixtures/desktop/host`가 포함된다.
네이티브 코드, 번들된 Bun 배포물, 템플릿과 예제는 독립 영역이다.

WebView 연결은 Windows WebView2가 `native/windows/bun/webview.ts`, macOS WKWebView가
`native/macos/bun/webview.ts`, SDK 전송 어댑터가 `packages/client-sdk/src/webview.ts`에 있다.
기본 연결의 브리지 선택과 Transport 초기화는 `packages/client-sdk/src/default-client.ts`가 맡는다.
렌더러는 앱 명령의 의미를 알지 못하고 호스트의 렌더러 계약만 따른다.

선택 네이티브 기능은 [ADR 0013](../decisions/0013-optional-native-plugins.md)에 따라
개별 플러그인 패키지로 제공한다. 패키지 진입점, 소유권과 CLI 연결은
[플러그인 구조 계약](./plugins.md)에 정리했다.

| 경로 | 패키지 | TypeScript 환경 | 직접 workspace 의존성 |
| --- | --- | --- | --- |
| `packages/protocol` | `@bunaway/protocol` | portable | 없음 |
| `packages/client-sdk` | `@bunaway/client` | browser | `@bunaway/protocol` |
| `packages/backend-sdk` | `@bunaway/backend` | bun | `@bunaway/core`, `@bunaway/plugin-api`, `@bunaway/protocol` |
| `packages/plugin-sdk` | `@bunaway/plugin` | browser, bun | `@bunaway/plugin-api`, `@bunaway/client`, `@bunaway/protocol` |
| `packages/plugin-api` | `@bunaway/plugin-api` | portable, bun 하위 경로 | `@bunaway/protocol` |
| `packages/core` | `@bunaway/core` | portable | `@bunaway/plugin-api`, `@bunaway/protocol` |
| `packages/runtime-bun` | `@bunaway/runtime-bun` | bun | `@bunaway/core`, `@bunaway/protocol` |
| `packages/packaging` | `@bunaway/packaging` | bun | `@bunaway/protocol` |
| `packages/cli` | `@bunaway/cli` | bun | `@bunaway/packaging`, `@bunaway/protocol`, `@bunaway/runtime-bun` |
| `plugins/log` | `@bunaway/plugin-log` | browser, bun | `@bunaway/plugin` |
| `plugins/storage` | `@bunaway/plugin-storage` | browser, bun | `@bunaway/plugin` |
| `plugins/capabilities` | `@bunaway/plugin-capabilities` | browser, bun | `@bunaway/plugin` |
| `plugins/windows` | `@bunaway/plugin-windows` | browser, bun | `@bunaway/plugin`, `@bunaway/plugin-api`, `@bunaway/protocol` |

`portable` 설정은 ES2022 표준 라이브러리만 허용한다.
`browser`는 DOM을 추가하고 `bun`만 Bun, Node 타입을 사용한다.
공통 베이스에 Bun, Node, DOM 타입을 전역으로 넣지 않는다.
패키지의 의존성은 `workspace:*`로 선언하며 경로 별칭으로 우회하지 않는다.

테스트와 네이티브 코드도 공개 API는 `@bunaway/...`의 선언된 export로 가져온다.
테스트와 저장소 빌드 도구가 내부 구현을 직접 검사하거나 재사용할 때는 루트
`package.json`의 비공개 `imports`를 사용한다. 예를 들어 `#cli/windows-compile`은
CLI의 실행 파일 컴파일 구현을, `#native/windows/bun/channel`은 Windows 채널 구현을
가리킨다. 이 경로는 저장소 도구용이며 생성 앱의 의존성이나 패키지 export를 대체하지 않는다.

공식 플러그인 내부에서는 각 패키지의 비공개 imports를 사용한다. 예를 들어
`#storage/contract`와 `#storage/platforms/windows`는 storage 패키지의 소스를 가리킨다.
이는 저장소 루트의 `#plugins/*`와 별개이며 플러그인을 따로 설치해도 자체 manifest로 해석한다.
공개 타입은 같은 별칭의 types 조건으로 dist/types를 읽는다. 원본 구현을 직접 검사하는
저장소 테스트만 bunaway-source 조건으로 src를 선택한다.

모든 패키지는 비공개다. `protocol`은 스키마, 검증, 직렬화, 버전 협상을 구현했고
`client-sdk`는 화면용 `invoke`, `listen`와 인자 없는 `createClient()`를
제공하며 문서별 WebView 연결, hello, 준비 대기, 페이지 종료 시 정리를 내부에서 처리한다.
명시적 `createClient({ transport, hello })`와 WebView Transport도 제공한다.
`core`는 `createCore`로 명령, 상태, 이벤트, 세션, 플러그인 수명을 구현한다.
backend-sdk는 명령 입력과 출력 검증, 공통 Host API와 비동기 호출 범위 연결을 제공한다.
plugin-sdk는 기능 선언에서 공개 호출 함수를 만들고 화면과 백엔드의 호출을 선택한다.
backend-sdk의 `node:async_hooks`는 Bun이 제공하며
core와 protocol은 portable 환경을 유지한다.
`runtime-bun`은 UTF-8 NDJSON 수신기, Host API 바인딩과 `runBunApp`으로 코어를
프로세스 IPC에 연결한다. CLI는 선언된 `@bunaway/runtime-bun/development`와
`@bunaway/runtime-bun/window-config` 경로로 개발 및 창 설정 helper를 사용한다. CLI는
create/validate/doctor/dev/build와 vanilla, Vite, React, Vue, Svelte 템플릿을
구현했다. 저장, 로그와 기능 조회 플러그인은 plugins/의 개별 패키지다. 각 패키지는
index.ts에 기능을 선언하고 contract.ts에 공통 계약, platforms에 실제 플랫폼 구현을 둔다.
편의 호출은 calls.ts나 logger.ts처럼 역할에 맞는 파일에 둔다.
추가 처리 없는 기능에는 내부 처리 파일을 요구하지 않는다.
다른 내부 파일과 폴더는 제작자가 선택한다.

Core 내부의 `app-registry.ts`는 앱과 플러그인의 등록 검증 및 조회 맵 준비를 맡고,
`create-core.ts`는 준비된 등록과 세션, 호출, 이벤트, 종료 상태를 소유한다.
CLI의 `windows-compile.ts`는 실행 파일 컴파일을, `windows-dev-launch.ts`는 개발 호스트의
실행 검증, 환경과 종료 요청을 담당한다. 파일 경로, JSON과 해시는 `files.ts`,
자식 명령 및 worker 실행은 `processes.ts`가 맡는다.
개발 명령의 `dev.ts`는 프로젝트 검증, 빌드와 종료 순서를 연결한다.
`dev-frontend.ts`는 개발 서버의 준비와 교체, `dev-app.ts`는 앱 프로세스와 코드 교체 채널,
`dev-watcher.ts`는 파일 감시와 미반영 경로를 소유한다. `restart-controller.ts`는 변경 revision과
저장 대기를 관리해 오래된 결과를 시작하지 않으며 종료 때 진행 중인 작업을 기다린다.
서버 시작 중 취소는 즉시 전달한다. 준비된 서버는 앱의 네이티브 정리가 끝난 뒤 정리한다.
CLI와 Windows 호스트는 `@bunaway/runtime-bun/windows-control`의 종료 메시지와 창 클래스
접두어를 공유한다. 이 계약을 가져올 때 네이티브 자원을 초기화하지 않는다.

[공통 API](./common-api.md)를 따른다. 테스트, 스키마 생성 스크립트, 데스크톱 회귀용 앱 정의는 별도
`tests/tsconfig.json`에서 Bun 타입을 사용한다. portable 패키지에는 전파하지 않는다.
SDK, 코어 실행은 공통 Factory 타입을 구현한다.
CLI의 `native-build.ts`는 플랫폼별 빌드 의존성을 준비한다.
`tests/lifecycle/run-native.ts`는 실제 호스트 회귀용 fixture를 만들고 검증한다. CLI는 macOS arm64 native build도
재사용하며, bin/API 번들과 SDK/native 소스를 [로컬 artifact](../framework-distribution.md)로
설치할 수 있다. 공개 publish, 프레임워크 라이선스, 프로덕션 서명과 Linux 및 모바일 빌드는 후속 작업이다.
플랫폼별 실제 실행 결과는 [Windows 기록](./windows-bun-results.md)과 [macOS 기록](./macos-native-results.md)에서 확인한다.

# Workspace structure

Bun workspaces는 `docs/site`, `packages/*`와 `plugins/*`에 적용한다.
네이티브 코드, 번들된 Bun 배포물, 렌더러, 템플릿과 예제는 독립 영역이다.

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
| `packages/cli` | `@bunaway/cli` | bun | `@bunaway/protocol` |
| `plugins/log` | `@bunaway/plugin-log` | browser, bun | `@bunaway/plugin` |
| `plugins/storage` | `@bunaway/plugin-storage` | browser, bun | `@bunaway/plugin` |
| `plugins/capabilities` | `@bunaway/plugin-capabilities` | browser, bun | `@bunaway/plugin` |
| `plugins/windows` | `@bunaway/plugin-windows` | browser, bun | `@bunaway/plugin` |

`portable` 설정은 ES2022 표준 라이브러리만 허용한다.
`browser`는 DOM을 추가하고 `bun`만 Bun, Node 타입을 사용한다.
공통 베이스에 Bun, Node, DOM 타입을 전역으로 넣지 않는다.
패키지의 의존성은 `workspace:*`로 선언하며 경로 별칭으로 우회하지 않는다.

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
프로세스 IPC에 연결한다. CLI는 create/validate/doctor/dev/build와 vanilla, Vite, React, Vue, Svelte 템플릿을
구현했다. 저장, 로그와 기능 조회 플러그인은 plugins/의 개별 패키지다. 각 패키지는
index.ts에 기능을 선언하고 windows.ts에 플랫폼 구현을 둔다. 비교와 편의 호출의 처리
로직은 역할에 따라 logger.ts, scope.ts와 query.ts로 분리한다.
추가 처리 없는 기능에는 내부 처리 파일을 요구하지 않는다.
다른 내부 파일과 폴더는 제작자가 선택한다.
[공통 API](./common-api.md)를 따른다. 테스트, 스키마 생성 스크립트, 데스크톱 회귀용 앱 정의는 별도
`tests/tsconfig.json`에서 Bun 타입을 사용한다. portable 패키지에는 전파하지 않는다.
SDK, 코어 실행은 공통 Factory 타입을 구현한다. Windows WebView2 호스트와 메모 샘플의
빌드, 패키징은 `native/windows/bun/run.ps1`에 있다. CLI는 macOS arm64 native build도
재사용하며, bin/API 번들과 SDK/native 소스를 [로컬 artifact](../framework-distribution.md)로
설치할 수 있다. 공개 publish, 프레임워크 라이선스, 프로덕션 서명과 Linux 및 모바일 빌드는 후속 작업이다.
플랫폼별 실제 실행 결과는 [Windows 기록](./windows-bun-results.md)과 [macOS 기록](./macos-native-results.md)에서 확인한다.

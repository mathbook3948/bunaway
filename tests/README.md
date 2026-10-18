# Tests

계약 테스트와 실제 네이티브 검증의 위치, 실행 방법과 변경 종류별로 돌릴 검사를 정리한다.
개별 fixture가 검사하는 세부 동작의 기록은 [NOTES.md](./NOTES.md)에 있다.

## 실행

| 명령 | 범위 |
| --- | --- |
| `bun test ./tests` | 모든 계약 테스트. `mise run test`와 같고 플랫폼이 다른 테스트는 skip된다 |
| `bun test tests/api` 또는 `bun test storage-bytes` | 경로나 파일명 필터. `bunfig.toml`의 `[test] root`가 `tests`이므로 build 디렉터리의 복사본은 수집하지 않는다 |
| `mise run check` | lint, 포맷, Java 포맷, 모든 workspace 타입 검사와 계약 테스트 |
| `mise run host:windows`, `host:macos`, `host:android`, `host:ios` | 실제 네이티브 호스트 빌드와 실행. 해당 OS에서만 동작한다 |
| `bun run docs:check`, `bun run docs:build` | 문서 레퍼런스 커버리지, 타입, 렌더링과 내부 링크 |

Linux에서는 Windows와 macOS 전용 테스트가 skip되므로 네이티브 변경은 해당 OS 또는 CI의
`windows-native`, `macos-native` 잡에서 확인한다. 계약 테스트가 통과했다는 보고와 실제 네이티브
실행 결과는 항상 구분해서 적는다.

## 디렉터리

| 디렉터리 | 내용 |
| --- | --- |
| `protocol/`, `core/` | 프로토콜 검증과 스키마 생성, Core 명령과 상태, 세션 수명주기 |
| `api/` | 플러그인과 창 API의 계약: 입력 검증, 결과 타입, 권한, 오류 코드. OS에 의존하지 않는다 |
| `cli/` | CLI 빌드, 플러그인 빌드와 import 해석, 템플릿, 개발 서버, 배포 패키지 설치 검사 |
| `packaging/` | 패키징 계약, 디렉터리 소유권과 잠금, Windows 설치기와 macOS 배포물 |
| `lifecycle/` | Worker 채널, 창과 데스크톱 수명주기, 플러그인 실행 경계와 실제 네이티브 fixture. `windows-*`와 `macos-*` 파일 중 실제 네이티브 자원을 쓰는 테스트는 `skipIf`로 해당 OS에 한정되고, fake를 쓰는 테스트는 Linux에서도 실행된다 |
| `conformance/` | 저장소 구조 규칙: WebView 번들이 Buffer, Bun, process 없이 로드되는지, `framework.json`과 루트 `package.json`이 workspace 디렉터리와 일치하는지, `biome.json`의 복잡도 예외와 workspace tsconfig가 drift하지 않는지, 같은 FFI 심볼이 저장소 안에서 한 시그니처만 갖는지, 테스트의 리터럴 기한과 자체 폴러가 늘지 않는지, 플러그인의 중립 모듈이 플랫폼 타입을 import하지 않는지 |
| `docs/` | 문서 링크와 레퍼런스 검사기, 텍스트 스타일 검사 |
| `fixtures/` | 여러 테스트가 공유하는 앱 정의, 네이티브 플랫폼 factory, 자식 프로세스 진단 |

## 변경 종류별 검사

| 변경 | 먼저 돌릴 검사 | 실제 네이티브 확인 |
| --- | --- | --- |
| 프로토콜, 스키마 (`packages/protocol`) | `bun test tests/protocol tests/core`, `mise run protocol:generate` 뒤 `native/host-api/generated` diff 없음 | 없음 |
| Core, 런타임 채널 (`packages/core`, `packages/runtime-bun`) | `bun test tests/core tests/lifecycle/runtime tests/lifecycle/worker tests/lifecycle/loopback` | `host:windows`, `host:macos` |
| 플러그인 계약 (`plugins/*/src/contract.ts`, `operations.ts`) | `bun test tests/api/<plugin>` 와 `tests/cli/plugins.test.ts`, `bun run plugins:build`, `bun test tests/conformance/browser-boundary tests/conformance/plugin-structure` | 없음 |
| Windows 플러그인 구현 (`plugins/*/src/platforms/windows*.ts`) | `bun test tests/api/<plugin>`, `bun test tests/conformance/ffi-signatures`, Windows에서 `bun test tests/lifecycle/windows-<plugin>` | `mise run host:windows` |
| macOS 플러그인 구현 (`plugins/*/src/platforms/macos*.ts`) | `bun test tests/api/<plugin>`, `bun test tests/conformance/ffi-signatures`, macOS에서 `bun test tests/lifecycle/macos-<plugin>` | `mise run host:macos` |
| Windows 호스트 (`native/windows/bun`) | `bun test tests/lifecycle/windows-ui-phase tests/lifecycle/windows-ui-lifecycle tests/cli/framework-paths`(Linux), Windows에서 `bun test tests/lifecycle/windows-bun tests/lifecycle/windows-window tests/lifecycle/windows-ui` | `mise run host:windows`, CI의 geometry 3회 반복 실행 |
| macOS 호스트 (`native/macos/bun`) | macOS에서 `bun test tests/lifecycle/macos-bun tests/lifecycle/macos-window tests/lifecycle/macos-desktop` | `mise run host:macos` |
| 플러그인 SDK, 플러그인 빌드 (`packages/plugin-sdk`, `packages/cli/src/plugin-*`) | `bun test tests/api/native tests/api/plugin tests/cli/plugin-build.test.ts tests/cli/distribution.test.ts`, `bun run plugins:build` | 없음 |
| CLI 빌드와 개발 서버 (`packages/cli`) | `bun test tests/cli` | 해당 OS에서 `bunaway dev`, `bunaway build` |
| 패키징 (`packages/packaging`) | `bun test tests/packaging` | Windows 설치기는 CI `Check (windows-2022)`, DMG는 `macos-native` |
| Android, iOS (`native/android`, `native/ios`) | `bun test tests/lifecycle/android tests/lifecycle/ios tests/cli/android.test.ts tests/cli/ios.test.ts` | `mise run host:android`, `mise run host:ios -- <Simulator UUID>` |
| 문서 (`docs/site`, 공개 API 추가) | `bun run docs:check`, `bun run docs:build`, `docs/site/src/reference-map.json` 갱신 | 없음 |
| 새 플러그인 workspace | `bunaway plugin new <name>`으로 생성, `bun test tests/conformance tests/cli/plugin-new`, `bun run docs:check` | 없음 |
| `framework.json`, 루트 `package.json`, `biome.json`, workspace tsconfig | `bun test tests/conformance` | 없음 |
| 테스트 추가, 기한 변경 | `bun test tests/conformance/test-deadlines`, 바뀐 테스트 파일 | 해당 OS의 fixture는 그 OS에서 |
| 모든 변경 | `bun test tests/docs` (텍스트 스타일), `mise run check` | 해당 없음 |

표의 `<plugin>`은 플러그인 이름이다. 예를 들어 storage 변경은 `bun test tests/api/storage`로
시작한다. 테스트 파일 이름은 영역과 플랫폼을 접두사로 쓴다: `windows-storage-metadata.ts`,
`macos-storage.test.ts`, `storage-bytes.test.ts`.

## 작성 규칙

- 네이티브 자원을 쓰는 테스트는 `test.skipIf(process.platform !== "win32")`처럼 플랫폼을
  명시하고, 실제 호스트를 실행하는 fixture는 `lifecycle/run-native.ts`가 소유한다.
- 자식 프로세스는 `fixtures/native-child-diagnostics.ts`로 실행해 stdout, stderr, 종료 코드와
  경과 시간을 보관한다. 기한을 넘긴 자식은 종료 코드가 0이어도 실패다.
- 네이티브 fixture는 `build/<platform>-*-results.json` 보고서를 쓰고, 보고서가 없거나 검사가
  실패하면 보관한 출력과 호스트 로그를 CI 로그에 출력한다. 로그 위치는 `.github/workflows/ci.yml`의
  artifact 목록을 따른다.
- 순서나 시간에 의존하는 단정은 피한다. 이벤트는 수신 집합으로 비교한다. 아무것도 검증하지
  않는 테스트는 추가하지 않는다.
- 기한은 숫자 대신 `fixtures/deadlines.ts`의 이름으로 적는다. 테스트 타임아웃은 파일 맨 위에서
  `setDefaultTimeout(deadline("build"))`로 한 번 정하고 `test()`의 세 번째 인자는 쓰지 않는다
  (Biome가 숫자가 아닌 세 번째 인자를 만나면 테스트 본문 전체를 다시 들여쓴다). 자식 프로세스의
  kill 타이머는 `killAfter(child, "childStep")`, 폴링은 `waitFor(probe, { deadline, what })`다.
  느린 러너는 `BUNAWAY_TEST_TIME_SCALE=2`처럼 배율 하나로 대응하고 개별 파일의 숫자를 올리지
  않는다. `conformance/test-deadlines.test.ts`가 파일별 리터럴 기한과 자체 `waitFor` 정의의 수를
  기준값 이하로 묶으므로 새 리터럴은 실패하고, 옮긴 뒤에는 기준값을 내린다.
- 플러그인 정의와 네이티브 factory는 `fixtures/native-platform.ts`처럼 실제 구현을 재사용한다.
  dispatch나 검증을 테스트용으로 다시 구현하지 않는다.
- 파괴적이거나 사용자 환경을 바꾸는 검사(Recent Items 삭제, 레지스트리 autostart 등)는
  `GITHUB_ACTIONS` 같은 CI 조건으로 한정한다.
- `native/windows/bun`, `native/macos/bun`, `native/host-api/bun`, `native/ios`에 파일을 추가하면
  `packages/cli/src/distribution.ts`의 `frameworkPaths`에도 적는다. `cli/framework-paths.test.ts`가
  하위 디렉터리까지 대조해 빠진 파일과 사라진 항목을 거부하므로 설치한 프레임워크의 앱 빌드가
  깨지기 전에 드러난다.
- 플러그인의 `src/*.ts`와 `@bunaway/protocol`, `@bunaway/plugin-api`, `@bunaway/client`,
  `@bunaway/plugin`의 중립 모듈은 WebView 번들에 들어가므로 `Buffer`, `Bun`, `process`와 `node:`
  모듈을 쓰지 않는다. `biome.json`의 override가 거부하고 `conformance/browser-boundary.test.ts`가
  번들을 그 전역 없이 로드한다. 번들 테스트는 모듈 평가와 ICO 파서 호출만 검사하므로 함수 안의
  전역 사용은 lint에 맡긴다. Bun 전용 구현은 `src/platforms/`에 둔다.
- 변경이 검증한 범위만 문서에 적는다. 특정 fixture가 무엇을 어디까지 검사하는지의 기록은
  [NOTES.md](./NOTES.md)의 해당 절에 덧붙인다.

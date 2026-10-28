---
status: accepted
---

# 공개 배포 대상은 framework.json의 모든 패키지이고, 버전은 하나로 맞추며, tarball 검사를 먼저 둔다

결정일: 2026-10-28. 검토 기준: main `37221b99`.

## 배경

[TODO-windows.md](../TODO-windows.md)의 "framework와 공식 기능 패키지의 공개 배포, 라이선스와 릴리스 자동화" 중
첫 단계로 무엇을 공개하고 버전을 어떻게 맞출지, 올리기 전에 무엇을 검사할지 정한다. 지금 모든 `packages/*`는
`"private": true`이고 라이선스는 `UNLICENSED`(`packages/packaging`은 필드 없음)이다. `plugins/*`는 `private`와
`license` 필드가 없고, 워크플로는 `ci.yml`만 있다.
레지스트리에 올리는 작업, 토큰, 계정, 라이선스 값 교체, 릴리스 워크플로는 이 결정의 범위가 아니다.

현재 배포 경로는 이미 있다. `framework:pack`(`packages/cli/scripts/pack.ts`)은 `framework.json`의 패키지 9개와
플러그인 24개를 tarball로 만든다. CLI를 뺀 SDK 패키지와 플러그인은 소스 매니페스트에서 `scripts`, `devDependencies`를 지우고
`dependencies`, `peerDependencies`의 `@bunaway/*` 범위를 정확한 릴리스 버전으로 바꾸며, `files`를 `src`(플러그인은 `dist`
포함)와 라이선스, 서드파티 고지 파일로 덮어쓴다. CLI의 `package.json`은 `pack.ts`가 새로 쓰며 `files` 목록도 다르다
(`packages`, `native`, `docs` 등). 소스의 `package.json`에 적은 `files`는 pack 결과에 쓰이지 않는다.

## 결정

### 공개 대상

`framework.json`의 `packages`와 `plugins` 33개를 모두 공개 대상으로 한다. 공개하지 않는 것은 저장소 루트 `bunaway`,
`docs/site`, `tests/fixtures/desktop/host`뿐이다. `packages/packaging`도 포함한다. CLI의 매니페스트가 나머지 SDK 패키지 8개를
정확한 버전의 의존성으로 선언하므로, 하나라도 빠지면 CLI 설치가 실패한다. 플러그인은 CLI의 의존성이 아니라 앱이 선택해 설치한다. packaging을 CLI에 합치는 것은 [ADR
0008](./0008-installed-framework-packages.md)의 설치 모델을 바꾸는 일이라 하지 않는다.

패키지는 직접 설치 여부로 나눈다. 이 구분은 공개 여부가 아니라 안내 대상이다.

- 앱이 직접 설치한다: `@bunaway/cli`, `@bunaway/backend`, `@bunaway/client`, `@bunaway/runtime-bun`(설치본 검사
  `assertRequiredDependencies`가 요구하는 네 개), `@bunaway/plugin`, 앱이 쓰는 `@bunaway/plugin-*`.
- 다른 패키지의 의존성으로만 내려받는다: `@bunaway/core`, `@bunaway/protocol`, `@bunaway/plugin-api`,
  `@bunaway/packaging`.

ADR 0008 본문은 "CLI와 여섯 SDK"라고 적었으나 지금 SDK 패키지는 여덟 개다. 목록의 기준은 이 문서와 `framework.json`이다.

### 버전

워크플로 전체가 `framework.json`의 `version` 하나를 쓴다. `release()`와 `assertMatchingRelease`는 설치된
패키지가 릴리스와 같은 정확한 버전이어야 통과시키고, `assertDeclaredDependencies`는 앱이 선언한 범위를 그 릴리스와 맞춘다.
플러그인마다 버전을 따로 올리는 모델은 이 설치본 검사 계약을 바꾸는 일이다. 그
모델은 하지 않고, 필요해지면 별도 결정으로 다룬다.

패키지 간 `workspace:*` 의존성은 `bun pm pack`이 바꿔 주기를 기대하지 않는다. `pack.ts`가 정확한 버전으로 쓴 결과를 계약으로
삼고, 검사가 `workspace:`, `file:`, `link:` 범위가 남지 않았는지 확인한다. 로컬 묶음(`--local`)은 `file:` 범위를 쓰므로 공개
검사의 대상이 아니다.

### package.json 변경 없음

이 결정은 공개 필드(`files`, `publishConfig`, `private`, `license`)를 바꾸지 않는다. `files`는 pack이 덮어쓰고,
`publishConfig`는 조직 이름과 레지스트리에 따라 달라지므로 아래의 소유자 결정 항목이다. 검사가 찾은 선언 누락만
고쳤다: 플러그인 16개가 `@bunaway/plugin-api`를 소스나 선언 파일에서 가져오면서 의존성으로 선언하지 않았고(`plugin-log`는
`@bunaway/protocol`도), 각 `package.json`과 `bun.lock`에 `workspace:*` 의존성을 더했다. 모두 타입 참조이거나 번들에서
외부로 두는 패키지라 런타임 번들은 바뀌지 않는다. 원인은 `defineNativePlugin`의 반환 타입이 빌드된 선언 파일에
`@bunaway/plugin-api`의 타입으로 풀려 적히는 것이어서, 새 플러그인이 같은 누락을 반복하지 않도록 `bunaway plugin new`
스캐폴드의 `dependencies`에도 `@bunaway/plugin-api`를 더했다.

### 공개 전 tarball 검사

`mise run release:check`(`scripts/check-release-packages.ts`)는 `packFramework`로 임시 디렉터리에 tarball을 만들고(이때 `pack.ts`가 플러그인을 빌드하므로 저장소의 `plugins/*/dist`는 다시 쓰인다), 각
tarball을 `tar`로 임시 디렉터리에 풀어 파일 목록과 `package.json`을 읽고 검사한다. 네트워크와 로그인은 쓰지 않고, 임시 디렉터리는 항상 지운다.
`bun pm pack --dry-run`은 JSON 출력이 없고 소스 폴더를 그대로 묶어 pack 결과와 다르므로 쓰지 않는다.

검사 항목은 다음과 같다.

- 패키지 이름이 `framework.json`에 있고 버전이 릴리스 버전과 같다.
- `scripts`, `devDependencies`가 없고, `@bunaway/*` 의존성은 릴리스에 있는 이름이며 정확한 릴리스 버전이다.
- `workspace:`, `file:`, `link:` 범위가 남아 있지 않다.
- `exports`, `imports`, `types`, `main`, `bin`, `bunaway.plugin`이 가리키는 파일이 tarball에 있고, 패턴 대상은 맞는 파일이 하나 이상 있다.
- 시험 파일, `.env*`, `.npmrc`, 키 파일이 들어 있지 않고, 라이선스 파일이 있다.
- 포함된 `src/`와 `dist/`의 bare import(`import type`, `import { type A }`, `export type`, 선언 파일의 `import("x")` 타입
  참조 포함, 주석과 문자열 안의 예시는 제외)가 `package.json`에 선언된 의존성이거나 패키지
  자신, Node 내장 모듈이다(Bun이 내장으로 나열하지만 Node에서는 npm 패키지인 `ws`, `undici`는 선언해야 한다).
- `./native/*` 같은 패턴 `exports`는 Windows 어댑터(`*`를 `windows`로 바꾼 파일, 예: `dist/native/windows.js`)로 풀려야
  한다. Windows가 기본 플랫폼이라 이 파일은 반드시 있어야 한다. CLI는 플러그인이 선언한 모든 플랫폼의 어댑터를 해석하지만 선언은 매니페스트에 없어, 다른 플랫폼 파일의 존재는 검사하지 않고 빌드가 막는다고 가정한다. 네이티브 어댑터가 없는
  `@bunaway/plugin-window-state`만 목록으로 제외한다(플러그인 스캐폴드가 모든 플러그인에 같은 패턴을 쓰기 때문). 제외되는
  것은 이 어댑터 패턴뿐이고 다른 대상은 계속 검사한다.
- 의존성 범위 값은 문자열이어야 하고, tarball 안의 이름은 요청한 패키지 이름과 같다.
- CLI tarball은 코드가 `packages/` 아래에 있어 bare import 검사에서 제외된다. 나머지 항목은 CLI에도 적용된다. CLI 매니페스트가 선언하지 않는 `zod` 같은 패키지를 선언 파일이 참조하는지는 이 검사로 확인하지 못한다.

`private: true`, 라이선스 `UNLICENSED` 또는 부재, `publishConfig` 부재는 실패가 아니라 "소유자 결정 대기"로 출력한다.
`private` 필드가 없는 플러그인은 "그대로 게시 가능"으로 출력한다. 이 값들이 바뀌어도 검사는 통과를 유지한다.

검사는 전체 패키지를 만들어 오래 걸리므로 `mise run check`에 넣지 않는다. 검사 로직의 순수 함수는 `tests/conformance/release-packages.test.ts`가
만든 입력으로 시험하고, 이 시험은 CI의 Linux, macOS, Windows에서 돈다. tarball은 상대 경로 이름으로 풀어 Windows 드라이브 문자가 GNU tar에서
원격 호스트로 해석되지 않게 한다.

## 소유자 결정 대기 항목

아래 값은 공개 후 되돌리기 어렵거나 외부 계정에 묶여 있어 이 결정에서 정하지 않는다. 게시를 막는 값은 `private: true` 하나인데(CLI tarball의 `private: true`는 `pack.ts`가 직접 써 넣으므로 `private`을
바꿀 때는 `pack.ts`의 CLI 매니페스트도 함께 고친다), 이
값은 `packages/*` 9개에만 있고 `plugins/*` 24개에는 없다. 플러그인은 토큰이 있으면 지금도 그대로 게시되므로, 릴리스 워크플로는
게시할 패키지를 이름 목록으로 명시해야 한다.

| 항목 | 현재 값 | 바꿀 때 함께 고칠 곳 |
| --- | --- | --- |
| 라이선스 | `UNLICENSED`, `FRAMEWORK-LICENSE.txt`는 미정 안내 | 라이선스 파일, 각 패키지 `license`, `pack.ts`가 쓰는 CLI 매니페스트의 `license` |
| npm 조직 `@bunaway` 확보 | 미확인 | 이름이 바뀌면 이 결정의 대부분과 `framework.json`, `packageNames`를 다시 연다 |
| 첫 공개 버전, 시점, dist-tag, `publishConfig.access` | 0.0.0, 없음 | `framework.json`의 `version`, 각 `package.json`의 `publishConfig` |
| 릴리스 워크플로와 토큰 | 없음 | `.github/workflows`, 저장소 비밀값 |

## 알려진 제한과 후속 과제

- SDK 패키지 8개의 `exports`는 `./src/*.ts`를 직접 가리키고, 플러그인은 `dist/`의 빌드 결과를 가리킨다. 소스를 그대로 쓰는 쪽은
  Bun 소비가 [ADR 0008](./0008-installed-framework-packages.md)의 모델이며, Node 등 다른 런타임에서의 소비는 지원하지 않는다.
- 공개 패키지는 저장소의 zod 수정본을 포함하지 않는다. 수정본은 CLI 안의 vendor 복사본에만 들어가고, SDK 패키지는 레지스트리의
  zod를 해석한다. 현재 동작을 기록할 뿐 이 결정에서 바꾸지 않는다.
- import 검사는 파서가 아니라 렉서(`scripts/strip-non-code.ts`)다. 정규식 리터럴과 나눗셈의 구분은 앞선 토큰에 의존하는
  휴리스틱이라 `if (ok) /re/`, `i++ / 2` 같은 드문 구문에서 틀릴 수 있고, JSX와 백틱 specifier(``import(`x`)``)는 다루지
  않는다. 검사가 읽는 출하 소스 698개 파일(SDK 패키지의 `src/`와 플러그인의 `src/`, `dist/`)은 AST 기준과 import 집합이 일치하며, 새 구문이 필요해지면 렉서 대신 AST 기반 검사로
  옮긴다.
- 이 검사는 `mise run check`에 속하지 않으므로 CI가 실제 tarball을 매번 검사하지는 않는다. 릴리스 자동화를 만들 때 워크플로의
  publish 이전 단계로 연결한다.
- 공개 전 설치 검증(깨끗한 환경에서 레지스트리의 패키지만으로 앱 생성과 빌드)은 레지스트리 게시가 선행되어야 하므로 릴리스 자동화
  단계의 일이다.

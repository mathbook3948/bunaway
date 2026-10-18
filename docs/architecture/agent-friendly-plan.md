# 에이전트가 올바르게 일하는 코드베이스 계획

이 문서는 에이전트가 반복하는 실수를 코드 구조, 정적 분석, 글, 사람 리뷰의 순서로 어디까지
올려 막았고 무엇이 남았는지를 적는다. 숫자는 모두 2026-10-18의 `main`(2bebf8c)과 PR #247
브랜치에서 직접 세거나 실행한 값이다. 원칙은 하나다: 에이전트는 보이는 코드를 베끼고 가장
짧은 길을 가므로, 지름길이 곧 올바른 길이어야 한다.

## 1. 근거 데이터

### 리뷰가 반복해서 잡은 것

리뷰 피드백은 GitHub 리뷰 스레드에 없다(0건). `(review N)` 커밋 메시지 25개와 PR #236의
fix/test 커밋 130개 분류가 기록이다.

| 주제 | `(review N)` 커밋 25개 중 | #236 분류 130개 중 |
| --- | --- | --- |
| 자원 해제와 정리 순서 | 9 | 28 |
| 입력 상한과 검증 | 8 | 41 (상한 23, 검증 18) |
| 테스트 견고성(기한, 순서, 범위) | 8 | 67 |
| 검증 범위를 넘는 문서 서술 | 4 | 14 |
| 독립 이벤트 사이의 순서 약속 | 3 | 포함 |

PR당 리뷰 라운드는 최대 6회(opener), 5회(windows aspect ratio)였다.

### 구조가 아니라 기억에 의존하던 것

- 같은 blob diff의 커밋 3개(a39c467, bbdb219, 78b4ac1)가 병렬 브랜치 3개에서 각각
  `tests/cli/distribution.test.ts`의 타임아웃을 30000에서 120000으로 올렸다. 테스트 기한
  리터럴은 약 97곳, 16가지 값이고 `child.kill()` 타이머 37곳 중 34곳이 리터럴이다.
- `frameworkPaths` 누락 수정 2건(fc193bf, 4da0c96)은 모두 대조 테스트가 생기기 전이었다.
- `packages/plugin-api/src/native-ico.ts`의 `Buffer`가 WebView 번들에서 터졌고(6cdd031) 수정은
  주석 한 줄이었다. 원인은 WebView에 들어가는 모듈이 `types: ["bun"]`으로 타입 검사되고
  브라우저 번들 테스트가 Bun 프로세스 안에서 실행된 것이다.
- FFI 심볼 테이블 83개, 심볼 273개, 선언 308개 중 같은 심볼이 두 번 이상 선언된 것이 28개,
  시그니처가 서로 다른 것이 12개다(`CreateWindowExW`는 host가 `u64`, clipboard 플러그인이
  `ptr`; `OpenClipboard`는 `u64 -> i32`와 `ptr -> bool`). `objc_msgSend`는 가변 인자라
  제외했다.
- 복잡도 예외 목록 65개 중 1개(`windows-icon-data.ts`)는 이미 규칙을 통과하고 있었다.
- `storage`의 `readText`, `readBytes`, `writeText`, `appendText`, `writeBytes`, `appendBytes`가
  Windows와 macOS 구현에 같은 코드로 있고, 4 MiB 상한이 두 이름으로 두 번 선언돼 있다.
  disposed 가드는 SDK 래퍼 외에 3곳에 더 있다.
- `native/windows/bun/ui.ts`(2230줄)는 모듈 수준 boolean 플래그 10개로 수명주기를 표현하고,
  `win32.ts`(3033줄)는 메서드 111개짜리 클래스 하나다.

## 2. 이미 올린 것 (PR #236, #247)

| 실수 클래스 | 올린 단계 | 무엇이 실패하는가 |
| --- | --- | --- |
| 스타일 규칙 4개 | lint | Biome, 경고도 실패 |
| 처리하지 않은 Promise, 조건식의 Promise | lint | `noFloatingPromises`, `noMisusedPromises` |
| WebView 모듈의 `Buffer`, `Bun`, `process`, `node:` | lint + 테스트 | `biome.json` override, `browser-boundary.test.ts`(전역을 `undefined`로 치환해 로드, ICO 파서 호출) |
| 복잡도 예외 목록의 drift | 테스트 | 길이 상한 64, 파일 존재, 여전히 위반 |
| tsconfig strict 약화 | 테스트 | base 상속, strict 재선언 금지, client는 브라우저 타입만 |
| workspace 목록 불일치 | 테스트 | `framework.json`, 루트 `devDependencies` 대조 |
| FFI 시그니처 불일치 | 테스트(ratchet) | 새 충돌은 실패, 기존 12개는 줄어들기만 |
| 배포 목록 누락 | 테스트 | `git ls-files` 기준 대조, `native/ios` 포함, 사라진 항목 거부 |
| 플랫폼마다 복제된 storage 인코딩 facade, 상한 2중 선언, disposed 가드 3중 | 구조 + 테스트(ratchet) | `StorageFiles` 베이스 클래스가 facade 6개, 4 MiB 상한, 가드를 한 번 소유하고 플랫폼은 `readFile`, `writeFile`, `release`만 구현. operations는 `StorageInstance` 인터페이스로 타입. `plugin-structure.test.ts`가 중립 모듈의 플랫폼 타입 import(10파일)를 기준값 이하로 묶는다 |
| FFI 심볼을 플러그인마다 다른 핸들과 BOOL 규칙으로 재선언 | 구조 + 테스트(ratchet) | clipboard, 창, 전역 메모리, 이벤트 함수는 `@bunaway/plugin/win32`의 `USER32`, `KERNEL32`에, 로더와 Objective-C 런타임은 새 `@bunaway/plugin/darwin`의 `LIBSYSTEM`, `OBJC_RUNTIME`에 한 번 선언하고 호스트와 플러그인 9개 파일이 `pick`으로 가져온다. `Hwnd`, `Handle` 브랜드 타입을 생성 지점에 적용. `KNOWN_CONFLICTS`는 12개에서 0개로 줄었고 새 충돌은 즉시 실패 |
| 플러그인을 복사해 만들다 `framework.json`, 루트 `package.json`, reference-map 중 하나를 빠뜨림 | 구조 + 테스트 | `bunaway plugin new <name>`(`createNativePlugin`)이 workspace 파일 8개와 문서 페이지를 만들고 매니페스트 3개에 등록한다. 생성물은 Biome 포맷, 타입 검사, 플러그인 빌드, `tests/conformance`, 문서 레퍼런스 검사를 그대로 통과한다. `tests/cli/plugin-new.test.ts`가 임시 저장소에서 생성, 빌드, 등록과 이름 거부를 확인한다 |
| UI 스레드 수명주기 플래그 5개(`startRequested`, `startupNavigationStarted`, `quitPending`, `shutdownCommitted`, `stopping`)를 따로 세워 두고 조합을 머리로 추적 | 구조 + 테스트 | `ui-phase.ts`의 `UiPhase` 유니온(`live`, `committed`, `stopping`과 시작 진행도) 값 하나와 전이 함수 `advance`가 모든 변경을 소유하고 `ui.ts`는 술어로만 읽는다. `windows-ui-phase.test.ts`가 15개 phase x 6개 이벤트 전이표 전체를 집합으로 단정하고, 기존 lifecycle 시나리오 31개는 동작이 같음을 확인한다. `Windows` 클래스의 작업 표시줄 설정과 오버레이 HICON 소유는 `window-taskbar.ts`의 `WindowTaskbar`로 옮겼다 |
| 테스트 기한 리터럴의 복제와 반복 수정 | 구조 + 테스트(ratchet) | `tests/fixtures/deadlines.ts`가 기한 7개를 소유하고 `BUNAWAY_TEST_TIME_SCALE`로 배율 적용. 테스트 타임아웃은 파일당 `setDefaultTimeout(deadline(...))` 하나. `test-deadlines.test.ts`가 파일별 리터럴 기한(213곳 127파일에서 114곳 83파일로)과 자체 폴러(29개에서 26개로)를 기준값 이하로 묶는다 |
| Linux에서 앱 동작 증명 불가 | 검증 스킬 | `verify-bunaway`: 패킹한 CLI로 프로젝트 생성, 프로세스 프로토콜로 백엔드 구동, SDK 채널로 명령과 이벤트, 증거 기록 |

각 검사는 실제 과거 실수나 임시로 넣은 실수에서 실패하는 것을 확인했다. 경계 테스트는
수정 전 ICO 모듈에서, ratchet은 이미 통과하던 예외 파일에서, FFI 검사는 `GetLastError`의
반환형을 바꾼 임시 편집에서, 기한 ratchet은 테스트에 더한 `setTimeout(..., 30000)` 한 줄과
실제보다 큰 기준값에서 실패했다.

남은 리터럴 114곳은 Windows와 macOS 전용 fixture, 자식 프로세스에 문자열로 넘기는 코드, API에
입력으로 주는 기한이다. 각 OS에서 실행해 볼 수 있을 때 옮기고 기준값을 내린다. `test()`의 세
번째 인자에 `deadline()`을 넣는 형태는 Biome가 본문 전체를 다시 들여써서 쓰지 않고, 파일마다
`setDefaultTimeout` 하나로 대신한다.

## 3. 남은 계획

순서는 레버리지와 위험의 비율이다. 각 항목은 그 자체로 PR 하나이며, 먼저 검사를 넣고
그 검사가 현재 코드에서 실패하는 것을 보인 뒤 코드를 옮긴다.

### 3.1 테스트 기한과 폴링을 한 모듈로 (M): 2절로 옮김

Linux에서 실행되는 테스트는 옮겼다. 남은 것은 OS 전용 fixture이며 그 OS에서 실행해 확인하며
옮긴다. 자체 `waitFor` 정의 26개 중 `failed()`와 다른 간격이 필요한 것은 공유 `waitFor`의
옵션으로 표현된다.

### 3.2 플랫폼 구현의 공유 인터페이스 (M, 플러그인별): storage는 2절로 옮김

storage는 끝났다. disposed 가드는 SDK 래퍼가 adapter 호출을 막지만 클래스를 직접 쓰는 테스트와
FFI 바인딩이 닫힌 뒤의 호출을 위해 베이스 클래스에 한 번 남겼다. opener의 경로 규칙은 이미
`windows-path.ts`, `macos-path.ts` 모듈에 있어 더 옮길 것이 없었다. 나머지 플러그인 10개의
`operations.ts`는 ratchet 목록에 있고, 각각 contract의 인스턴스 인터페이스로 바꾸며 목록에서
지운다. clipboard는 두 플랫폼의 메서드 시그니처(`signal` 유무)가 달라 인터페이스를 먼저
맞춰야 한다.

### 3.3 `ui.ts` 수명주기를 phase 유니온으로, `Windows` 클래스 분할 (L): phase와 taskbar는 2절로 옮김

phase 유니온은 계획한 네 상태 대신 실제 플래그가 표현하던 것을 그대로 옮겼다. `live`,
`committed`, `stopping`에 시작 진행도(`booting`, `starting`, `running`)와 대기 중인 quit을
더한 15개 값이며, `failure`, `initialized`, `showRequested`, `modalShutdownRequested`는 phase가
아니라 그대로 둔다. 전이표 테스트가 먼저 들어가고 lifecycle 시나리오 31개는 바꾸지 않았다.

`Windows`에서는 taskbar 협력자만 분리했다. 남은 geometry(모니터 선택, placement, 전체화면,
약 1500줄)와 icons는 Linux에서 실행할 수 없어 `windows-native` CI와 Windows 머신에서 확인할
수 있을 때 같은 방식(협력자 하나, 호스트 인터페이스로 역의존)으로 옮긴다. 호스트 `win32.ts`의
창 핸들 `Hwnd` 브랜드도 그때 함께 적용한다.

### 3.4 FFI 핸들 브랜드 타입과 기존 충돌 12개 해소 (M): 2절로 옮김

충돌 12개는 모두 공유 테이블로 해소했다. 남은 것은 호스트 `win32.ts`의 창 핸들에 `Hwnd`
브랜드를 적용하는 일이며 3.3의 남은 `Windows` geometry 분할과 함께 한다. Linux에서는 Bun 빌드와
타입 검사, clipboard의 가짜 FFI 테스트까지 확인했고 실제 호출은 `windows-native`,
`macos-native` CI 작업이 검증한다.

### 3.5 플러그인 스캐폴드 (S): 2절로 옮김

스캐폴드는 `tests/api/<name>.test.ts`를 만들지 않는다. 계약 테스트는 작업 내용에 따라 달라서
README에 파일 이름만 적어 둔다. 생성된 `operations.ts`는 3.2의 인스턴스 인터페이스 형태라
`plugin-structure` ratchet 목록에 들어가지 않는다.

## 4. 하지 않기로 한 것

- `useExhaustiveSwitchCases`: 문자열 유니온에 `null`, `true`, `false`를 요구하는 오탐.
- `useAwait`: 위반 200곳 이상이 대부분 콜백 시그니처라 비용 대비 효과가 낮다.
- `core` 패키지에 WebView 경계 override: 브라우저 번들 입력에 없다.
- AGENTS.md를 늘리는 것: 규칙은 검사와 짝지어 표로 두고, 검사가 없는 규칙만 남긴다.

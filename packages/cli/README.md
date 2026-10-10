# CLI와 vanilla, Vite, React, Vue, Svelte 템플릿

CLI로 앱을 만들고 개발 서버를 실행하거나 네이티브 앱을 빌드한다.
SDK와 정책, Host API는 프레임워크의 네이티브 호스트에 연결된다.
앱 런타임과 개발 및 빌드에는 Bun 1.4.2를 사용한다. 공개 npm에는 아직 배포하지 않았다.

## 생성 → 개발 → 빌드 → 독립 실행

저장소를 체크아웃하지 않고 CLI와 SDK를 설치하려면 [개발자 설치 안내](../../docs/framework-distribution.md)를 따른다.
패키지 구성과 버전 규칙, CLI 및 SDK를 함께 업그레이드하는 방법도 설명한다. 로컬 tarball에는 CLI
bin/API JS 번들과 모든 생성 입력이 포함된다. 공개 registry publish는 하지 않는다.
아래는 프레임워크 저장소 기여자용 직접 소스 실행 경로다.

저장소에서 `bun install` 후 실행한다. Windows에서 전역 Bun이 없으면
`build/cache/bun/bun-windows-x64-baseline/bun.exe`로 아래 `bun`을 대체한다.

```sh
bun run framework:pack --local
bun packages/cli/src/main.ts create ../my-app --package-dir build/framework
cd ../my-app
bun install
bun run doctor
bun run validate
bun run dev
# 개발 실행 종료 후:
bun run build
```

`create`는 새 디렉터리에 앱을 만든다. 기존 경로는 덮어쓰지 않으며
생성이 끝나면 의존성 설치 등 다음 단계를 안내한다. 생성 프로젝트는 @bunaway/cli와 SDK의 패키지 의존성을 선언한다.
프레임워크는 앱의 node_modules에 설치되며 원본 저장소 없이 동작한다.
의존성은 package.json과 bun.lock으로 관리하고 두 파일을 커밋한다.
로컬 tarball 묶음은 깨끗한 재설치를 위해 보관한다.
개발 도구 설치에는 Bun 패키지 레지스트리, 최초 네이티브 빌드에는 고정 런타임/헤더/SDK
다운로드 접근이 필요하다. 앱 실행에는 네트워크나 Bun 설치가 필요 없다.

명령은 `create <new-directory> [--template vanilla|vite|react|vue|svelte] [--package-dir <tarball-directory>]`와 `dev|validate|build|doctor [directory]`,
`package <channel> [directory] [--build]`다.
옵션/알 수 없는 명령, 설정 필드는 오류로 종료한다. `validate`는 버전, 앱 ID, 소스 경로, 홈
자산, 단일 뷰/정확한 origin, 기존 정책 스키마를 검사한다. `package`는
`bunaway.json.bundle`(패키징에 필요, 선언 시 dev/build에서도 형식 검사)을 읽어
`bunaway build`의 채널 중립 산출물을 채널별 패키지로 조립한다. 산출물은
`dist/<target>/packaged/<channel>/`, 결과는 그 옆의 `<channel>-report.json`에
기록한다. `--build`는 패키징 전에 빌드를 먼저 실행한다. 채널, 어댑터 계약, 서명/해시
규칙은 `@bunaway/packaging`과 `docs/decisions/0005-packaging-contract.md`에 있다.
권한은 호스트와 코어에서 검사한다. 앱 개발자는 사용할 명령과 Host API 권한을 정책에 직접 선언한다.

`create`의 기본 템플릿은 기존 `vanilla`다. Vite의 CSS HMR과 페이지 갱신을 사용하는
vanilla TypeScript 앱은 다음과 같이 생성한다.

```sh
bun packages/cli/src/main.ts create ../my-vite-app --template vite --package-dir build/framework
cd ../my-vite-app
bun install
bun run dev
```

React, Vue, Svelte도 TypeScript + Vite 템플릿으로 제공한다.

```sh
bun packages/cli/src/main.ts create ../my-react-app --template react --package-dir build/framework
bun packages/cli/src/main.ts create ../my-vue-app --template vue --package-dir build/framework
bun packages/cli/src/main.ts create ../my-svelte-app --template svelte --package-dir build/framework
```

생성한 앱에서 `bun install` → `bun run dev`로 개발하고,
`bun run build` 한 번으로 웹 UI를 포함한 앱을 만든다.
`bun run typecheck`는 UI 컴포넌트, 백엔드, Vite 설정을 검사한다.
React는 `src/App.tsx`, Vue는 `src/App.vue`와 `src/components/HelloWorld.vue`,
Svelte는 `src/App.svelte`와 `src/lib/Counter.svelte`에서 시작한다.
각 UI는 create-vite@9.2.1의 `react-ts`, `vue-ts`, `svelte-ts` 원본이다.
Vue의 vue-tsc와 Svelte의 svelte-check는 TypeScript 컴파일러 API를 사용하므로 두 템플릿의
TypeScript는 6.0.2로 고정한다. 다른 템플릿은 기존 7.0.2를 사용한다.
React Fast Refresh의 인라인 preamble은 개발 CSP에서만 허용한다.
모든 Vite 기반 템플릿의 프로덕션 CSP는 `script-src 'self'; style-src 'self'`이며
이미지는 인라인 data URL 대신 로컬 파일로 출력한다.
공통 `src-bunaway/`의 앱 정의, 메시지 명령, 이벤트, 저장 정책은 동일하다.
앱 정의에서 추론한 타입을 `createClient`에 지정하면 명령 이름과 입력, 결과, 이벤트 데이터의 타입을 검사할 수 있다.
이 클라이언트의 `client.invoke`, `client.listen`으로 호출하고 구독한다.
생성과 호출 실패를 처리하고 컴포넌트를 제거할 때는 해당 구독만 해제한다.

`vite` 템플릿은 공식 [create-vite@9.2.1의 vanilla-ts](https://github.com/vitejs/vite/tree/fea5b21dd9524ed7308632407b996f1fe5942c9c/packages/create-vite/template-vanilla-ts)
기본 화면(로고, 카운터)을 사용한다.
루트 `index.html`, `src/` UI 코드, 스타일, 이미지, `public/` 정적 자산은 upstream 원본이다.
모든 템플릿의 `dev`, `build`, `package`, `validate`, `doctor`는 앱 CLI를 호출한다.
Vite 웹 전용 명령은 `dev:web`, `build:web`, `preview`다.
UI 변경은 Vite가 처리하고 백엔드 변경은 CLI가 호스트를 재시작한다.
`build.command`는 `["bun", "run", "build:web"]`로 웹 빌드를 연결한다.
`bunaway build`와 `package --build`는 기존 출력이 있어도 웹 빌드를 매번 실행하고,
성공한 출력을 검증한 뒤 앱을 빌드한다. 웹 빌드가 실패하면 기존 앱 산출물을 유지하며 중단한다.
웹 도구의 출력과 `build.frontend`는 앱 산출물 및 잠금 경로와 분리해야 한다.
`dist` 자체는 거부하며 `web-dist`나 `dist/web`처럼 겹치지 않는 경로를 사용한다.
Ctrl+C나 SIGTERM으로 중단하면 실행한 명령과 하위 프로세스를 정리하고 빌드 잠금을 해제한다.
Windows EXE 컴파일 중에도 같은 취소 처리를 적용한다.
명령 종료 후에도 하위 프로세스의 정리 완료를 확인하며, 확인하지 못하면 빌드는 실패한다.
`validate`는 빌드 명령을 실행하지 않으므로 웹 자산만 검사할 때는 `bun run build:web` 다음 실행한다.
`package` 단독 실행은 앱 소스나 웹 출력 없이도 기존 앱 산출물을 검증해 패키징한다.
기존 앱은 웹 build/dev 스크립트를 build:web/dev:web으로 옮기고 build.command/dev.command를 연결한다.
생성 템플릿은 [templates/](./templates/)에서 관리한다. 구조와 script 역할은
[Tauri vanilla-ts 템플릿](https://github.com/tauri-apps/create-tauri-app/tree/12db955f20162e7422cbeed76c2aa630760ccca3/templates/template-vanilla-ts)을 참조한다.
각 템플릿은 UI, 백엔드, 정책, 설정을 모두 포함하며, `create`는 선택한 폴더 하나만 복사한다.
템플릿의 `gitignore`, `gitattributes`는 생성 앱에서 `.gitignore`, `.gitattributes`로 바꾼다.

## 생성 구조

```text
my-app/
  package.json, tsconfig.json
  src/{index.html,main.ts,style.css}
  src-bunaway/
    app.ts
    message/module.ts
    bunaway.json, policy.json
  bun.lock (bun install 후 생성)
```

`src-bunaway/bunaway.json` v1에 build, app, bundle을 통합한다. 권한은 policy.json에 둔다.
`app.ts`는 `defineApp({ modules: [message] })`로 기능을 조립하고
`message/module.ts`는 `defineModule`로 공개 명령, 이벤트를 등록한다.
최종 이름이 중복되면 조립이 실패하며 기존 명령을 덮어쓰지 않는다.
`build.app`은 공통 앱 정의(default export AppDefinition), `build.frontend`는 웹 UI
디렉터리다. 두 소스 경로와 패키징 파일 경로는 프로젝트 루트 상대 경로다.
플랫폼별 부팅은 프레임워크가 담당하며 개발자가 별도 `index.ts`를 작성하지 않는다.
기존 `build.backend`, `build.windowsApp`은 제거하고 앱 정의 경로를 `build.app`에 지정한다.
현재 CLI는 v1 설정과 설치 패키지를 사용한다. 이전의 분리 설정과 vendor 구조는 지원하지 않는다.

선택적 `dev`에 외부 UI 개발 서버의 `command`(인자 배열), `url`, `timeoutMs`를 지정한다.
[Vite, Next.js 개발 서버 연결](../../docs/development-server.md)을 따른다.
`vite` 템플릿은 루트 `index.html`, `public/`, `src/`, `src-bunaway/`와
`vite.config.ts`, `dev` 설정을 포함한다. `build.frontend`는 `web-dist`다.
프런트엔드의 `.ts`/`.js`는 브라우저 번들로 변환하고 나머지 정적 자산은 복사한다.
`.d.ts`는 배포하지 않는다. CSS 등 번들의 추가 출력까지 정적 자산과 대조해 기록 전에
충돌을 거부한다. 출력 이름은 Windows/macOS 이식성을 위해 대소문자를 구분하지 않고
비교하며 자산 심볼릭 링크도 거부한다.
vanilla MVP는 양쪽 호스트가 공통으로 지원하는 단일 뷰 `app` 설정과
`https://app.bunaway.local`의 호스트 소유 로컬 자산만 사용한다. Windows는 가상 호스트,
macOS는 기존 `bunaway://` 매핑이다. policy.json의 HTTP origin은 허용하지 않는다.
`dev.url`의 정확한 loopback origin은 개발 산출물에만 적용하며 프로덕션에 포함하지 않는다.

`vanilla` 템플릿은 `CommandsOf`와 `EventsOf`로 앱 정의에서 명령과 이벤트 타입을 추론한다.
이 타입을 지정한 클라이언트를 `createClient`로 만들고 명령을 호출하거나 이벤트를 구독한다.
명령과 이벤트 이름, 입력과 결과는 `bun run typecheck`로 검사한다. 타입만 import하므로 백엔드 구현은 UI 번들에 포함되지 않는다.
백엔드는 `defineModule`, `defineApp`으로 명령, 이벤트를 등록한다.
화면에서 별도의 초기화 코드를 작성할 필요는 없다. 일반 브라우저에서 백엔드 호출은
`UNSUPPORTED`로 실패하므로 `bunaway dev`로 연 앱 창을 사용한다.
호출, 구독 해제, 타입 추론은 [클라이언트 API](../../docs/architecture/common-api.md#클라이언트와-transport)를 따른다.
Windows와 macOS 부팅은 프레임워크가 앱 정의를 import해 담당한다.
두 플랫폼 모두 Bun이 진입점이며 시스템 네이티브 API를 직접 FFI로 호출한다. 개발 우선순위는
[ADR 0010](../../docs/decisions/0010-windows-first-platform-model.md)을 따른다.
`message.save` → 호출 컨텍스트의 Host API `storage.writeText` →
`appData/messages/current.txt` → `message.saved` → UI 갱신이다.
`message.read`로 시작/재실행 시 복원한다. 첫 실행의 파일 없음은 UI에 표시한다.
정책은 `main` 뷰의 두 명령, 한 이벤트와 `messages/` 읽기/쓰기만 허용하며
백엔드 자체 작업에는 저장 권한을 주지 않는다.

## 개발 수명주기

Windows의 앱별 생성 데이터는 `.bunaway/windows-x64/assets/manifest.json`에서 확인한다.
앱 설정, 정책, 플러그인 계약과 개발 SDK 모듈 목록을 담으며 CLI가 다시 빌드할 때 갱신한다.
앱 진입점, 플러그인 지연 import와 개발 SDK 연결은 빌드 전용 가상 모듈로 만들며 중간 소스 파일은 쓰지 않는다.
배포 빌드는 실행 manifest와 모듈을 EXE에 포함하고 임시 자산을 정리한다.
패키지 루트의 `manifest.json`은 최종 배포 파일의 해시를 기록하는 별도 산출물이다.

Windows `bunaway dev`는 UI DevTools를 활성화한다. WebView에 포커스를 두고 F12 또는
Ctrl+Shift+I로 연다. `bunaway dev --inspect`는 백엔드 Bun inspector를
`ws://127.0.0.1:6499/bunaway`에 연결하며 `--inspect=<port>`로 포트를 지정한다.
옵션을 생략하면 inspector를 시작하지 않는다. 포트는 1부터 65535까지 정수이며
이 옵션은 Windows x64에서만 지원한다. 백엔드가 재시작되면 같은 주소로 다시 연결한다.
개발 번들은 원본 소스를 포함한 inline 소스맵을 생성하고 외부 UI의 소스맵은 개발 서버가 제공한다.
일반 build에는 DevTools, inspector 인자나 CLI 개발 소스맵을 추가하지 않는다.
[디버깅 가이드](../../docs/site/src/content/docs/guides/debugging.mdx)에서 attach 설정과 오류 위치 확인 절차를 설명한다.

`dev`가 없으면 프로젝트 소스, 설정 변경을 debounce 후 직렬 처리한다(의존성/출력 디렉터리는 제외).
프런트엔드 변경도 **전체 네이티브 호스트/창 재시작**으로 갱신한다.
외부 개발 서버 모드에서는 서버가 UI 갱신과 HMR을 처리하고 CLI는 백엔드와 설정 변경을 처리한다. 앱 정의가 import한 프로젝트 내부 전이 의존성도 감시한다. 성공한 검증마다 목록을 갱신하고 실패하면 이전 목록을 유지한다. 서버를 한 번 실행하고 HTTP 준비를 기다린 뒤 호스트를 시작한다.
서버 설정 변경은 서버도 교체하며 Ctrl+C, 창 닫기, 서버 종료, timeout 시 서버 자손을 정리한다.
이전 호스트 종료를 확인한 후 자산을 다시 빌드하고 새 호스트를 시작한다.
호스트가 새 런타임 세대와 새 호출 컨텍스트/세션을 발급한다. Windows는 WM_CLOSE로 코어, Worker, WebView를 정리하고 Bun Job이 자손을 회수한다.
macOS는 같은 프로세스의 백엔드 Worker를 정리하고 실제 종료를 확인한다. 세션이 종료되면 SDK는 진행 중인 요청과 구독을 폐기한다.
CLI는 요청을 다시 전송하지 않으며 이미 저장한 파일은 그대로 남는다.
저장하지 않은 UI 상태는 앱이 다시 시작될 때 사라진다.

개발 감시는 최초 소스 컴파일 전에 시작한다. 시작할 때 문법 오류나 import 오류가 있어도
오류를 출력하고 다음 저장에서 다시 빌드한다. 빌드 실패 중에는 제외 디렉터리 밖의 프로젝트 파일 변경으로 재시도할 수 있으며, 성공하면 일반 감시 범위로 돌아간다. 잘못된 설정, 정책, 소스 경로나 도구 준비 오류는 시작을 실패시킨다.

빌드 실패 시 이전 프로덕션 산출물을 유지한다. 개발 빌드 실패 시 이전 앱을 다시 띄우지
않고 오류를 출력하며 다음 변경을 기다린다. 빌드 도중 추가 변경은 오래된 결과의 시작을
건너뛰고 최신 소스로 다시 빌드한다. 창을 닫거나 Ctrl+C로 개발 실행을 종료한다.

## 패키지 구조와 배포

Windows x64 개발에는 Windows 기본 제공 tar와 고정 Bun이 필요하다.
앱 실행에는 WebView2 Evergreen이 필요하다. 네이티브 빌드 의존성은 고정된 핀으로 받는다.
macOS arm64에는 macOS 14+, GUI 세션과 codesign이 필요하다. C 컴파일러는 필요하지 않다. 교차 빌드는 없다.

```text
dist/windows-x64/
  <appId>.exe
  WebView2Loader.dll
  licenses/{LICENSE.bun,License-WebView2.txt}
  manifest.json

dist/macos-arm64/<appId>.app/Contents/
  MacOS/bunaway-host
  Resources/{assets/,licenses/,manifest.json}
  Info.plist
```

개발 패키지는 `.bunaway/<target>/` 아래 생성한다. Windows 개발 모드는 외부 JS와 번들 Bun을 사용해 빠르게 재시작한다.
Windows 배포 빌드는 Bun, 앱 코드, UI/IO Worker, 웹 자산, 설정과 정책을 EXE에 포함하고 콘솔 없이 시작한다.
`app.executableName`으로 EXE 이름을 바꾸고 `app.icon`으로 프로젝트 기준 ICO 파일을 지정한다.
Windows에서는 기본 이름 `<appId>.exe`도 같은 파일 이름 검사를 받는다. 기본 이름이 유효하지 않으면
`app.executableName`에 다른 이름을 지정한다.
실행 파일, 창과 트레이에 같은 앱 아이콘을 사용한다. 초기화 실패나 앱을 종료시키는 호스트 오류는
첫 번째 창 제목의 오류 대화상자와 `%LOCALAPPDATA%/bunaway/<appId>/logs/startup-error.log`로 알린다.
앱 설정 확인 전에는 제목으로 `Bunaway`를 쓰고, 로그 경로의 `<appId>`는 확장자를 제외한 실행 파일 이름으로 대신한다.
데이터 경로를 찾거나 로그를 쓰지 못해도 대화상자는 표시한다. 명령 호출 오류는 SDK 호출 결과로 전달한다.
인자는 모두 그대로 전달하며 앱 종료까지 기다린다.
macOS 호스트 인자는 `--package <절대 패키지 경로>`이고 `.app/Contents/Resources`다.
macOS는 Finder/.app 실행 시 NSBundle Resources에서 패키지를 찾는다.

```powershell
# 다른 cwd에서도, PATH에 Bun이 없어도 실행:
& 'C:\path\my-app\dist\windows-x64\app.my-app.exe'
```

```sh
open dist/macos-arm64/app.my-app.app
# 또는 명시적 리소스 루트:
dist/macos-arm64/app.my-app.app/Contents/MacOS/bunaway-host --package "$PWD/dist/macos-arm64/app.my-app.app/Contents/Resources"
```

manifest에는 앱/프레임워크 버전, Bun 출처와 라이선스, 외부 파일 및 실행 파일 해시를 기록한다.
Windows의 `host.kind=bun-compiled`, `host.executable`, `host.sha256`은 컴파일된 앱을 가리킨다.
패키징 전에 빌드 파일을 검사하고 서명 후 해시는 `host.packagedSha256`에 기록한다.
Windows 앱은 시작할 때 manifest를 읽거나 파일 전체를 해시하지 않는다.
컴파일 옵션으로 작업 디렉터리의 .env, bunfig, tsconfig와 package.json 자동 로딩을 끈다.
Bun이 앱 코드 전에 처리하는 BUN_OPTIONS와 BUN_BE_BUN은 로컬 실행 환경의 사용자 설정으로 취급한다.

macOS 패키지에는 로컬 실행용 ad-hoc 서명만 적용하며 번들 Bun을 재서명하지 않는다.
manifest의 macOS `host.sourceSha256`은 서명 전 원본 호스트 해시다(서명된 실행 파일을
자신의 서명 대상 manifest에 해싱하는 순환을 피한다).
Developer ID 서명, 실제 공증, UI 프레임워크 템플릿의 실제 네이티브 검증, 기본 로그와 저장 플러그인,
공개 registry publish/라이선스 결정은 후속 범위다.
`packages/cli/src/native-build.ts`는 Windows에서 고정 Bun과 공식 Loader를 준비하고,
macOS에서는 고정 의존성을 검증한 뒤 네이티브 호스트를 컴파일한다.
CLI는 앱 자산을 직접 조립한다.
Windows 일반 Inno 설치는 `bunaway package win-direct`와 `win-store-unpackaged`를 사용한다.
MSIX 앱 활성화 경로와 Developer ID 공증/배포는 후속 범위다. 기존 샘플/계약 테스트
경로와 기본 빌드 동작은 유지한다.

## Windows 창 API

`src-bunaway/bunaway.json`의 `app.windows`에 창별 `view`, `title`, `home`,
`window: { width, height }`를 정의한다. 단일 창의 `app.view/home/window`와 함께
사용하지 않는다. `startup: false`인 창은 `@bunaway/backend`의 `windows.create`로
연다. `policy.json`의 `host.windows` 또는 `backend.windows`에 제어할 대상 뷰 ID를
선언한다. 새 창 API는 Windows에 구현했고 실제 GUI 회귀를 통과했다.
macOS 빌드는 `app.windows`를 거부한다.

설정 예제는 [여러 창 가이드](../../docs/site/src/content/docs/guides/windows.mdx),
메서드와 권한, 수명은 [windows API](../../docs/site/src/content/docs/reference/host/windows.mdx)를 참고한다.

## 생성물 관리

앱의 내부 생성물은 `.bunaway/`에서 관리한다. `<target>/`은 개발 실행 파일,
`work/<target>/`은 빌드와 패키징의 실행별 작업 디렉터리, `locks/<target>/`은 공유 잠금이다.
작업 디렉터리는 성공과 실패 모두 정리하며 배포 결과는 `dist/<target>/`에 게시한다.
교체 실패에 대비한 이전 출력 백업과 임시 보고서는 게시할 파일 옆에 둔다.
실행 중인 빌드나 패키징이 있다면 `.bunaway/`를 지우지 않는다.

프레임워크의 다운로드 캐시는 `build/cache/` 아래 bun, webview2, nlohmann-json으로 모은다.
네이티브 빌드, 테스트와 프레임워크 배포 산출물도 기존 `build/`를 사용한다.
검증용 스키마 스냅샷은 `native/host-api/generated/`에 버전 관리한다.
앱 원본, 사용자 저장 데이터와 WebView 프로필은 이 정리 대상에 포함하지 않는다.
프런트엔드 도구의 출력 경로는 `build.frontend`를 따르며 템플릿은 `web-dist/`를 사용한다.
프로세스 제어용 통신 파일과 독립 macOS 서명 스크립트의 작업 파일은 OS 임시 디렉터리를
사용하고 해당 프로세스가 정리한다. 프로젝트 산출물로 보관하지 않는다.

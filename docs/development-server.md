# 외부 UI 개발 서버 연결

Vite, Next.js/Turbopack 등 웹 도구가 UI 개발 서버와 HMR을 담당한다. bunaway CLI는
그 서버를 실행하고 준비를 기다린 뒤 네이티브 창과 SDK 브리지를 연결한다.
`dev`가 없는 생성 앱은 기존 로컬 자산 개발 흐름을 사용한다.

Vite용 vanilla TypeScript 앱은 `bunaway create <directory> --template vite`로 생성한다.
로컬 패키지를 사용할 때는 `--package-dir <tarball-directory>`도 지정한다.
설치 후 `bun run dev`로 네이티브 앱을 개발하고 `bun run build` 한 번으로 웹 UI와 앱을 빌드한다.
`build.command`는 `bun run build:web`을 실행하며 웹 출력이 있어도 매번 실행한다.
[메모 예제](../examples/memo/README.md)도 같은 구성을 사용한다.

## 설정

기존 `src-bunaway/bunaway.json`의 `build`, `app`, `bundle` 옆에 추가한다.

```json
{
  "dev": {
    "command": ["bun", "run", "dev:web"],
    "url": "http://127.0.0.1:5173/",
    "timeoutMs": 30000
  }
}
```

`command`는 shell 문자열이 아닌 실행 파일, 인자 배열이다. 프로젝트 루트에서 실행하며
환경과 stdout/stderr를 이어받는다. `bun`은 CLI를 실행한 Bun의 절대 경로로 해석한다.
`timeoutMs`는 생략 시 30000이며 100–300000 범위다. 이미 실행 중인 서버를 연결하는
방식은 제공하지 않는다. 지정 포트가 사용 중이면 해당 서버를 종료한 뒤 실행한다.

Vite 프로젝트의 package.json script 예시는 다음과 같다. 기존 Vite 설정, HTML의
모듈 진입점을 사용하며 프런트엔드 경로와 포트를 프로젝트에 맞춘다.

```json
{
  "scripts": {
    "dev": "bunaway dev",
    "dev:web": "bun --bun vite --host 127.0.0.1 --port 5173 --strictPort",
    "build": "bunaway build",
    "build:web": "tsc && bun --bun vite build",
    "preview": "bun --bun vite preview",
    "bunaway": "bunaway"
  }
}
```

Next.js/Turbopack도 `dev`에 해당 버전의 `next dev` 명령을 지정하고 url의 포트를
맞추면 같은 실행 구조를 사용한다. 이 연결은 Next.js SSR을 최종 앱에 번들하는 기능이
아니다. React, Vue, Svelte 템플릿은 `--template react|vue|svelte`로 생성한다.
외부 프런트엔드 production build는 `build.command`에 `["bun", "run", "build:web"]`을 지정하고
`build.frontend`를 해당 도구의 정적 출력 디렉터리로 지정한다.

URL은 `http://localhost:<port>/...`, `http://127.0.0.1:<port>/...` 또는 HTTPS의 같은
호스트만 허용한다. HTTPS 인증서는 정상 검증되어야 한다. 인증, redirect가 없는 HTTP
2xx 경로를 지정한다. 개발 서버가 자동으로 다른 포트에 뜨면 연결하지 못하므로 고정
포트를 사용한다. Vite의 HMR WebSocket도 같은 loopback 주소, 포트를 사용하도록 설정한다.

## 실행과 변경 처리

```sh
bun run dev
```

네이티브 도구를 준비한 뒤 개발 명령 실행 → HTTP 준비 확인 → 네이티브 창 실행 순서다.
Windows x64/macOS arm64의 기존 개발 도구 요구사항을 따른다. Linux에서 네이티브 앱을
실행하는 기능은 추가하지 않는다. stdout/stderr에서 개발 서버 오류를 확인한다.

- UI 변경: 서버의 HMR/페이지 갱신을 사용한다. CLI는 UI를 다시 번들하지 않는다.
- 외부 서버 없이 UI와 백엔드가 공유하는 파일을 변경하면 두 번들을 갱신하고 전체 앱을 재시작한다.
- Windows 명령 구현 변경: 새 앱 번들을 검증하고 로드한 뒤 명령 구현만 교체한다. 코어, StateStore, 창, 문서, 세션, 구독과 개발 서버를 유지한다. 진행 중인 명령은 기존 구현으로 끝내며 다음 호출부터 새 구현을 사용한다. SDK와 설치된 플러그인의 공통 모듈은 시작 시 번들에 고정해 오류 클래스와 Host API 실행 컨텍스트를 공유한다.
- 전체 재시작: 명령, 이벤트 계약, 상태 초기값, 플러그인 객체, desktop 콜백, 정책, 창 설정과 의존성 설정 변경은 이전 호스트를 정리하고 새 창과 세션을 만든다. Windows의 CLI 중단은 `desktop.beforeQuit`와 트레이 숨김을 우회하며 플러그인 StopHook과 자원 정리가 끝난 뒤 빌드한다. macOS는 백엔드 변경 때 이 방식을 사용한다.
- 감시 대상: src-bunaway, build.app 앱 정의의 디렉터리, 루트 package.json, bun.lock, tsconfig.json.
  진입점이 프로젝트 루트에 있으면 루트 파일만 감시하고 UI 하위 디렉터리는 제외한다.
  앱 정의가 import한 프로젝트 내부 전이 의존성도 감시하며 성공한 검증마다 목록을 갱신한다.
  실패하면 이전 목록을 유지한다. 프로젝트 밖과 node_modules의 파일은 감시하지 않는다.
- dev 설정 변경: 기존 호스트와 개발 서버를 종료하고 새 설정으로 시작한다.
- 백엔드 빌드 오류: 서버는 유지하고 다음 소스 저장을 기다린다. 최초 소스 컴파일에 실패하면 서버와 창을 시작하지 않고 감시를 유지한다. 빌드 실패 중에는 제외 디렉터리 밖의 프로젝트 파일 변경으로 재시도할 수 있으며, 성공하면 일반 감시 범위로 돌아간다. 소스를 수정하고 저장하면 다시 시도한다. 설정, 정책, 소스 경로나 도구 준비 오류는 시작에 실패한다.
- 서버 종료, 준비 timeout, 포트 충돌: 오류로 개발 실행을 종료한다.
- Ctrl+C: 앱과 관리한 서버 프로세스 트리를 정리한다. 창 닫기는 앱의 종료 취소와 숨김 설정을 따르며 앱이 종료되면 서버도 정리한다.

SDK API와 브리지 사용법은 같다. 개발 페이지도 뷰의 기존 명령, 이벤트, Host 권한만
사용한다. CLI가 생성한 개발 정책에만 정확한 loopback origin을 적용하므로
policy.json에 HTTP origin을 직접 추가하지 않는다.

## 프로덕션과 검증

Windows의 `bunaway dev`는 UI DevTools를 활성화하며 F12 또는 Ctrl+Shift+I로 연다.
`--inspect`를 지정하면 백엔드 inspector를 `ws://127.0.0.1:6499/bunaway`에 연결한다.
`--inspect=<port>`로 포트를 바꾸며 전체 재시작 후에는 다시 attach한다. 호환되는 Windows 앱 코드 교체는 연결을 유지한다. 다른 플랫폼의
CLI inspector 연결은 아직 지원하지 않는다. 개발 백엔드와 로컬 UI 번들에는 inline 소스맵을
생성하고, 외부 UI 소스맵은 개발 서버가 제공한다.
[디버깅 가이드](./site/src/content/docs/guides/debugging.mdx)에서 오류 위치와 연결 설정을 확인한다.

코드 교체는 StateStore의 데이터를 보존하며 모듈 변수와 클로저는 초기화한다.
앱 import 단계에서 타이머, 서버, Worker를 만들면 교체 때 중복 실행될 수 있으므로
자원은 플러그인 setup과 StopHook으로 관리한다. 같은 플러그인 객체를 재사용하지 않으면
전체 재시작한다. Bun이 캐시한 앱 세대는 제거할 수 없어 100회 로드 이후 전체 재시작한다.

`app.home`은 계속 로컬 자산 URL이다. 외부 서버 개발에서는 `build.frontend`가 아직
없는 출력 디렉터리여도 된다. `doctor`는 이 개발 설정을 검사한다.
`build`는 `build.command` 실행 후 프로덕션 자산과 앱 소스를 검증한다. `package --build`도 같은 경로를 실행한다.
`validate`는 웹 빌드를 실행하지 않으므로 `bun run build:web`으로 검사할 자산을 준비한다.
`package` 단독 실행은 기존 앱 산출물을 검증해 패키징하며 앱 소스와 웹 출력은 요구하지 않는다.
웹 도구의 출력과 `build.frontend`는 `web-dist`처럼 앱 산출물과 분리된 경로로 지정한다.
앱 출력이나 잠금 경로와 겹치면 웹 빌드 명령을 실행하기 전에 거부한다.
Ctrl+C나 SIGTERM으로 빌드를 중단하면 실행한 명령과 하위 프로세스를 정리한 뒤 잠금을 해제한다.
웹 도구의 프로덕션 빌드와 CLI 자산 번들러 사이의 호환성은 앱 개발자가 확인해야 한다.

개발 패키지는 `.bunaway/<target>`에만 생성하며 해시로 기록된 개발 URL과 명시적
`--dev-url` 실행 인자를 함께 요구한다. 일반 `build`/`package`는 `dev.command`를
실행하지 않고 개발 URL, marker를 넣지 않는다. 상세 결정은
[ADR 0009](./decisions/0009-development-server.md)와 [ADR 0012](./decisions/0012-integrated-app-build.md)를 따른다.

# 외부 UI 개발 서버 연결

Vite, Next.js/Turbopack 등 웹 도구가 UI 개발 서버와 HMR을 담당한다. bunaway CLI는
그 서버를 실행하고 준비를 기다린 뒤 네이티브 창과 SDK 브리지를 연결한다.
`dev`가 없는 생성 앱은 기존 로컬 자산 개발 흐름을 사용한다.

Vite용 vanilla TypeScript 앱은 `bunaway create <directory> --template vite`로 생성한다.
로컬 패키지를 사용할 때는 `--package-dir <tarball-directory>`도 지정한다.
설치 후 `bun run bunaway dev`로 네이티브 앱을 개발한다. `bun run build`로 Vite 자산을
빌드한 뒤 `bun run bunaway build`로 네이티브 앱을 빌드한다.
[메모 예제](../examples/memo/README.md)도 같은 구성을 사용한다.

## 설정

기존 `src-bunaway/bunaway.json`의 `build`, `app`, `bundle` 옆에 추가한다.

```json
{
  "dev": {
    "command": ["bun", "run", "dev"],
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
    "dev": "bun --bun vite --host 127.0.0.1 --port 5173 --strictPort",
    "build": "tsc && bun --bun vite build",
    "preview": "bun --bun vite preview",
    "bunaway": "bunaway"
  }
}
```

Next.js/Turbopack도 `dev`에 해당 버전의 `next dev` 명령을 지정하고 url의 포트를
맞추면 같은 실행 구조를 사용한다. 이 연결은 Next.js SSR을 최종 앱에 번들하는 기능이
아니다. React, Vue, Svelte 템플릿은 `--template react|vue|svelte`로 생성한다.
외부 프런트엔드 production build는
앱의 package.json script에서 명시적으로 연결한다.

URL은 `http://localhost:<port>/...`, `http://127.0.0.1:<port>/...` 또는 HTTPS의 같은
호스트만 허용한다. HTTPS 인증서는 정상 검증되어야 한다. 인증, redirect가 없는 HTTP
2xx 경로를 지정한다. 개발 서버가 자동으로 다른 포트에 뜨면 연결하지 못하므로 고정
포트를 사용한다. Vite의 HMR WebSocket도 같은 loopback 주소, 포트를 사용하도록 설정한다.

## 실행과 변경 처리

```sh
bun run bunaway dev
```

네이티브 도구를 준비한 뒤 개발 명령 실행 → HTTP 준비 확인 → 네이티브 창 실행 순서다.
Windows x64/macOS arm64의 기존 개발 도구 요구사항을 따른다. Linux에서 네이티브 앱을
실행하는 기능은 추가하지 않는다. stdout/stderr에서 개발 서버 오류를 확인한다.

- UI 변경: 서버의 HMR/페이지 갱신을 사용한다. CLI는 UI를 다시 번들하지 않는다.
- 백엔드 변경: 이전 호스트 종료 → 백엔드, 호스트 빌드 → 새 창/세션 시작. 서버는 유지한다.
- 감시 대상: src-bunaway, build.app 앱 정의의 디렉터리, 루트 package.json, bun.lock, tsconfig.json.
  진입점이 프로젝트 루트에 있으면 루트 파일만 감시하고 UI 하위 디렉터리는 제외한다.
  앱 정의가 import한 프로젝트 내부 전이 의존성도 감시하며 성공한 검증마다 목록을 갱신한다.
  실패하면 이전 목록을 유지한다. 프로젝트 밖과 node_modules의 파일은 감시하지 않는다.
- dev 설정 변경: 기존 호스트와 개발 서버를 종료하고 새 설정으로 시작한다.
- 백엔드 빌드 오류: 서버는 유지하고 다음 소스 저장을 기다린다.
- 서버 종료, 준비 timeout, 포트 충돌: 오류로 개발 실행을 종료한다.
- Ctrl+C, 창 닫기: 앱과 관리한 서버 프로세스 트리를 정리한다.

SDK API와 브리지 사용법은 같다. 개발 페이지도 뷰의 기존 명령, 이벤트, Host 권한만
사용한다. CLI가 생성한 개발 정책에만 정확한 loopback origin을 적용하므로
policy.json에 HTTP origin을 직접 추가하지 않는다.

## 프로덕션과 검증

`app.home`은 계속 로컬 자산 URL이다. 외부 서버 개발에서는 `build.frontend`가 아직
없는 출력 디렉터리여도 된다. `doctor`는 이 개발 설정을 검사한다. `validate`와 일반
`build`는 기존 프로덕션 소스/자산 경로를 검사하므로 먼저 웹 빌드 산출물을 준비한다.
웹 도구의 프로덕션 빌드와 CLI 자산 번들러 사이의 호환성은 앱 개발자가 확인해야 한다.

개발 패키지는 `.bunaway/<target>`에만 생성하며 해시로 기록된 개발 URL과 명시적
`--dev-url` 실행 인자를 함께 요구한다. 일반 `build`/`package`는 `dev.command`를
실행하지 않고 개발 URL, marker를 넣지 않는다. 상세 결정은
[ADR 0009](./decisions/0009-development-server.md)을 따른다.

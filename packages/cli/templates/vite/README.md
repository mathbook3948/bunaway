# bunaway Vite

vanilla TypeScript UI를 Vite 개발 서버와 연결하는 템플릿이다.
고정 Bun **1.4.2**로 실행하며 별도 Node.js 설치는 필요 없다.
Windows x64에는 PowerShell 7, WebView2 Evergreen, macOS arm64에는 macOS 14+, Xcode CLT와
GUI 세션이 필요하다.

```sh
bun install
bun run bunaway doctor
bun run bunaway dev
```

CLI가 프런트엔드 `dev` script를 실행하고 `http://127.0.0.1:5173/`의 준비를 기다린 뒤 네이티브 창을 연다.
CSS는 HMR로 갱신하고 HTML, TypeScript 변경은 Vite가 페이지를 다시 로드한다.
UI 변경은 호스트를 재시작하지 않으며, 백엔드, 설정 변경은 새 호스트/세션으로 재시작한다.
창 닫기, Ctrl+C는 서버도 종료한다. 5173 포트를 사용하는 기존 서버는 먼저 종료한다.
페이지 갱신, 백엔드 재시작 시 미완료 요청을 재전송하지 않으며 저장하지 않은 입력은 사라질 수 있다.

```sh
bun run build
bun run bunaway validate
bun run bunaway build
bun run bunaway package win-direct
```

Vite와 같이 루트 `index.html`에서 `/src/main.ts`를 불러온다.
`dev`, `build`, `preview`는 프런트엔드 개발, 타입 검사 및 빌드, 미리보기 script다.
`bunaway` script로 네이티브 CLI를 호출한다. 네이티브 빌드, 검증, 패키징 전에는
`bun run build`로 `web-dist/`를 생성한다. CLI는 프런트엔드 빌드를 자동 실행하지 않는다.
네이티브 출력이 `dist/`를 사용하므로 프런트엔드 출력은 `web-dist/`로 분리한다.
`vite.config.ts`의 상대 `base`는 Windows 가상 호스트와 macOS 로컬 자산 매핑에 맞춘다.
개발 페이지에만 CSS 갱신과 loopback WebSocket을 허용하는 CSP를 적용하며
프로덕션 HTML은 `default-src 'self'; script-src 'self'; style-src 'self'`를 유지한다.
개발 서버 URL과 marker는 프로덕션 앱에 포함하지 않는다.

`src-bunaway/bunaway.json`은 build, app, dev, bundle 설정을 담는다.
`src-bunaway/policy.json`은 `main` 뷰의 `message.save`, `message.read`, `message.saved`와
`appData/messages/` 읽기/쓰기만 허용한다. 개발 서버 origin은 CLI가 개발 산출물에만 적용한다.
백엔드, 권한, SDK 호출 예시는 기본 vanilla 템플릿과 같다.

package.json과 bun.lock을 커밋하고 재설치에는 `bun install --frozen-lockfile`을 사용한다.
프레임워크 CLI, SDK를 함께 같은 버전으로 업그레이드하며 로컬 tarball 묶음은 보관한다.
프레임워크 라이선스는 미결정이다. 자세한 계약은 설치된 패키지의
[설치 안내](node_modules/@bunaway/cli/docs/framework-distribution.md)와
[개발 서버 안내](node_modules/@bunaway/cli/docs/development-server.md)를 따른다.

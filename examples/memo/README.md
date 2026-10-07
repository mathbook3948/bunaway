# 메모 예제

CLI의 `vite` 템플릿과 같은 구조와 실행 명령을 사용하는 독립 앱이다.
메모 창 하나에서 작성 내용과 마지막 저장 내용을 표시한다.

```text
memo/
├─ index.html
├─ package.json
├─ tsconfig.json
├─ src/
│  ├─ main.ts
│  └─ memo.css
├─ vite.config.ts
└─ src-bunaway/
   ├─ app.ts
   ├─ memo/
   │  ├─ contracts.ts
   │  ├─ module.ts
   │  └─ service.ts
   ├─ bunaway.json
   └─ policy.json
```

## 로컬 실행

Windows x64에서 Bun 1.4.2, PowerShell 7, WebView2 Evergreen이 필요하다.
macOS arm64에서는 Xcode Command Line Tools와 GUI 세션이 필요하다.
아직 프레임워크를 배포하지 않았으므로 저장소에서 만든 로컬 npm 패키지를 설치한다.
저장소 루트에서 시작한다.

```sh
bun install --frozen-lockfile
bun run framework:pack --local
cd examples/memo
bun install --no-cache
bun run bunaway dev
```

이후에는 예제 폴더에서 `bun run bunaway dev`를 실행하면 된다.
프레임워크를 수정했다면 루트에서 다시 패킹한 뒤 예제 폴더에서 `bun install --force --no-cache`로 갱신한다.
로컬 패키지의 경로를 기록하는 예제의 `bun.lock`은 커밋하지 않는다.

`bun run bunaway dev`는 CLI가 프런트엔드 `dev` script의 Vite 서버를 `http://127.0.0.1:5173/`에 실행하고
준비가 끝나면 네이티브 창을 연다. 별도 Node.js 설치 없이 Bun으로 Vite를 실행한다.
5173 포트를 쓰는 서버가 이미 있다면 종료한 뒤 실행한다.
CSS 수정은 HMR로 반영하며 HTML·TypeScript 수정은 Vite가 페이지를 갱신한다.
UI 수정은 네이티브 호스트를 재시작하지 않고, `src-bunaway/`의 백엔드·설정 수정은
새 호스트와 세션으로 재시작한다. 창 닫기·Ctrl+C는 Vite 서버도 정리한다.
실행 구조와 URL 제약은 [외부 UI 개발 서버 안내](../../docs/development-server.md)를 따른다.

```sh
bun run build
bun run bunaway validate
bun run bunaway build
bun run bunaway package
```

`dev`·`build`·`preview`는 Vite 프런트엔드 개발·타입 검사 및 빌드·미리보기 명령이다.
`bun run bunaway dev`는 `.bunaway/`에 개발 앱을 만들고 실행한다.
`bun run bunaway build`는 `dist/`에 앱을 만들며, Windows의 `bunaway package`는
기본 `win-direct` 배포 패키지를 생성한다. 네이티브 검증·빌드·패키징 전에는
`bun run build`로 `web-dist/`에 프로덕션 자산을 생성한다.
Bunaway는 프런트엔드 빌드를 자동 실행하지 않는다. `vite.config.ts`는
개발 페이지에서만 CSS 갱신과 loopback HMR WebSocket을 허용하는 CSP를 적용한다.
배포 HTML의 CSP와 `app.home`, 작성한 `policy.json`의 권한·origin은 그대로 유지한다.
네이티브 회귀 테스트 실행 스크립트는 여러 테스트 창을 열기 때문에 예제 실행에 사용하지 않는다.

## 구성과 동작

- `src/`: 클라이언트 SDK를 사용하는 화면. 글자 수·저장 상태·`Ctrl+S`(`⌘+S`) 저장을 지원한다.
- `index.html`: `/src/main.ts`를 불러오는 Vite 진입점.
- `vite.config.ts`: 고정 loopback 포트·출력 경로·개발 페이지 CSP 설정.
- `web-dist/`: Vite의 프로덕션 자산 출력. 생성 파일이므로 커밋하지 않는다.
- `src-bunaway/app.ts`: `defineApp({ modules: [memo] })`로 기능을 조립하는 공통 앱 정의.
- `src-bunaway/memo/contracts.ts`: 메모 명령 입력·출력과 이벤트의 JSON Schema 계약.
- `src-bunaway/memo/module.ts`: `memo.save`, `memo.read`, `memo.saved`를 공개하고 서비스와 연결.
- `src-bunaway/memo/service.ts`: 요청마다 전달받은 Host API로 메모 파일을 읽고 쓰는 서비스.
- `src-bunaway/bunaway.json`: 빌드 진입점과 앱 식별자·제목·단일 창 설정.
- `src-bunaway/policy.json`: `main` 뷰의 메모 명령·이벤트와 `appData/notes/` 읽기·쓰기 권한.

저장 버튼은 `memo.save`를 호출하고 백엔드는 Host API로 파일을 기록한 뒤 `memo.saved`를 발행한다.
화면은 `@bunaway/client`의 `invoke`, `listen`을 별도 초기화 없이 사용한다.
백엔드 호출은 `bun run bunaway dev`로 연 앱 창에서 동작하며 일반 브라우저에서는 지원하지 않는다.
화면은 이벤트를 받아 저장 내용을 갱신하며, 앱을 다시 열면 `memo.read`로 파일을 불러온다.
Windows 저장 위치는 `%LOCALAPPDATA%/bunaway/examples.bunaway.memo/data/notes/memo.txt`다.
첫 실행에는 파일이 없어 읽기 실패를 표시하지만 새 메모를 저장할 수 있다.
저장 중 수정하거나 저장에 실패한 내용은 입력창에 남는다.

여러 창·읽기 전용 권한·자동 저장·재실행 시나리오는 `tests/fixtures/desktop/host/`에 분리되어 있다.

# 메모 예제

CLI로 생성한 앱과 같은 구조와 실행 명령을 사용하는 독립 앱이다.
메모 창 하나에서 작성 내용과 마지막 저장 내용을 표시한다.

```text
memo/
├─ package.json
├─ tsconfig.json
├─ src/
│  ├─ index.html
│  ├─ main.ts
│  └─ memo.css
└─ src-bunaway/
   ├─ src/
   │  ├─ app.ts
   │  └─ index.ts
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
bun run dev
```

이후에는 예제 폴더에서 `bun run dev`를 실행하면 된다.
프레임워크를 수정했다면 루트에서 다시 패킹한 뒤 예제 폴더에서 `bun install --force --no-cache`로 갱신한다.
로컬 패키지의 경로를 기록하는 예제의 `bun.lock`은 커밋하지 않는다.

```sh
bun run validate
bun run typecheck
bun run build
bun run package
```

`dev`는 `.bunaway/`에 개발 앱을 만들고 실행한다. `build`는 `dist/`에 앱을 만들며,
Windows의 `package`는 기본 `win-direct` 배포 패키지를 생성한다.
네이티브 회귀 테스트 실행 스크립트는 여러 테스트 창을 열기 때문에 예제 실행에 사용하지 않는다.

## 구성과 동작

- `src/`: 클라이언트 SDK를 사용하는 화면. 글자 수·저장 상태·`Ctrl+S`(`⌘+S`) 저장을 지원한다.
- `src-bunaway/src/app.ts`: `memo.save`, `memo.read` 명령과 `memo.saved` 이벤트 계약 및 구현.
- `src-bunaway/src/index.ts`: Bun 백엔드 런타임 진입점.
- `src-bunaway/bunaway.json`: 빌드 진입점과 앱 식별자·제목·단일 창 설정.
- `src-bunaway/policy.json`: `main` 뷰의 메모 명령·이벤트와 `appData/notes/` 읽기·쓰기 권한.

저장 버튼은 `memo.save`를 호출하고 백엔드는 Host API로 파일을 기록한 뒤 `memo.saved`를 발행한다.
화면은 이벤트를 받아 저장 내용을 갱신하며, 앱을 다시 열면 `memo.read`로 파일을 불러온다.
Windows 저장 위치는 `%LOCALAPPDATA%/bunaway/examples.bunaway.memo/data/notes/memo.txt`다.
첫 실행에는 파일이 없어 읽기 실패를 표시하지만 새 메모를 저장할 수 있다.
저장 중 수정하거나 저장에 실패한 내용은 입력창에 남는다.

여러 창·읽기 전용 권한·자동 저장·재실행 시나리오는 `tests/fixtures/desktop/host/`에 분리되어 있다.

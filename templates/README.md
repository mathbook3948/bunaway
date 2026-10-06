# Project templates

현재 생성 템플릿은 [CLI 템플릿](../packages/cli/templates/)에 있다.
`bunaway create <directory>`의 기본값은 `vanilla`이며,
`--template vite`는 같은 SDK·백엔드·정책에 Vite 개발 서버와 프로덕션 자산 빌드를 연결한다.
React·Vue·Svelte 전용 템플릿은 아직 제공하지 않는다.

## 초기화 구성 근거

[Tauri create-tauri-app의 vanilla TypeScript 템플릿](https://github.com/tauri-apps/create-tauri-app/tree/12db955f20162e7422cbeed76c2aa630760ccca3/templates/template-vanilla-ts)을
참조한다. Tauri는 create-vite를 호출하지 않고 자체 템플릿을 복사한다.
루트 `index.html`, `src/` UI 소스와 Vite의 `dev`·`build`·`preview` scripts를 유지하고
`tauri` script로 네이티브 CLI를 호출한다. UI는 Tauri SDK 예제이므로 create-vite의
기본 화면과 동일하지 않다.

Bunaway Vite 템플릿도 같은 구조와 script 역할을 사용하고 `bunaway` script를 추가한다.
UI는 npm에 배포된 `create-vite@9.2.1`의
[공식 vanilla-ts 샘플](https://github.com/vitejs/vite/tree/fea5b21dd9524ed7308632407b996f1fe5942c9c/packages/create-vite/template-vanilla-ts)이다.
`index.html`, `src/`, `public/`의 UI 파일은 원본 그대로 복사하며 Vite MIT 라이선스를 포함한다.
카운터·로고·스타일을 Bunaway SDK 화면으로 바꾸지 않는다. SDK UI 예시는
기본 vanilla 템플릿과 메모 예제에서 제공한다. Bun으로 Vite를 실행하고, 네이티브 출력 `dist/`와 충돌하지
않도록 프런트엔드 출력은 `web-dist/`다. 상대 자산 URL과 개발/배포 HTML에 삽입하는 CSP는 Bunaway의
로컬 자산·브리지 계약에 맞춘다. 기본 vanilla 템플릿은 그대로 제공한다.

[Tauri CLI의 init 구현](https://github.com/tauri-apps/tauri/blob/7c87f907ebca5e46f59c99ed1d30381d6e5bda5d/crates/tauri-cli/src/init.rs)은
이미 있는 프런트엔드를 유지하면서 `src-tauri/`를 추가하고 개발 서버 URL·자산 경로·
`beforeDevCommand`·`beforeBuildCommand`를 설정하는 별도 명령이다.
Bunaway는 현재 새 프로젝트를 만드는 `create`만 제공하며, 개발 서버 명령은 `dev.command`로
연결한다. 프로덕션 프런트엔드 빌드는 CLI가 자동 실행하지 않으므로 네이티브
검증·빌드·패키징 전 `bun run build`를 실행한다.

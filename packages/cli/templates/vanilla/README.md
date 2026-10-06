# bunaway vanilla

고정 Bun **1.4.2**로 `bun install` 후 `bun run doctor`, `bun run validate`,
`bun run dev`, `bun run build`를 실행한다.
앱에 설치된 @bunaway/cli와 SDK 패키지를 사용하며 원본 프레임워크 저장소는 필요 없다.
package.json과 bun.lock을 커밋하고 재설치에는 bun install --frozen-lockfile을 사용한다.
프레임워크 패키지는 같은 버전으로 함께 업그레이드한다. 로컬 tarball을 사용하는 경우 재설치에 필요한 묶음을 보관한다.
[설치, 버전 안내](node_modules/@bunaway/cli/docs/framework-distribution.md)를 참고한다.
프레임워크 라이선스는 미결정이며 CLI 패키지의 FRAMEWORK-LICENSE.txt를 확인한다.

- Windows x64: PowerShell 7, WebView2 Evergreen. C++ 빌드 도구는 필요 없다.
- macOS arm64: macOS 14+, Xcode CLT. 로컬 ad-hoc 서명만 제공한다.
- 최초 빌드의 고정 Bun/네이티브 의존성 다운로드와 개발 의존성 설치에는 네트워크가 필요하다.
- 프로덕션 앱 실행은 패키지 내부 Bun을 사용하며 전역 Bun이나 node_modules는 필요 없다.

`src-bunaway/bunaway.json` v1은 build, app, bundle 설정을 통합한다.
소스와 패키징 파일 경로는 프로젝트 루트 기준이다.

`src`는 실제 클라이언트 SDK로 명령을 호출하고 이벤트를 구독한다.
`src-bunaway/app.ts`는 공통 앱 정의를 default export한다. 백엔드 SDK의 Host API로 허용된 범위에 파일을 저장한 뒤 이벤트를 발행한다.
`src-bunaway/policy.json`은 `main` 뷰의 `messages/` 읽기/쓰기만 허용한다.
저장 위치는 Windows `%LOCALAPPDATA%/bunaway/<appId>/data/messages/current.txt`,
macOS `~/Library/Application Support/bunaway/<appId>/data/messages/current.txt`다.

개발 변경은 UI/백엔드를 다시 번들하고 **전체 호스트/창을 재시작**한다.
이전 세션과 요청, 구독은 종료된다. 저장 요청은 자동으로 다시 전송되지 않으며 저장하지 않은 입력은 사라진다.
Ctrl+C를 누르거나 창을 닫아 개발 실행을 종료한다.
외부 Vite, Next.js 개발 서버는 bunaway.json의 선택적 `dev.command`, `dev.url`로 연결한다.
[포함된 개발 서버 안내](node_modules/@bunaway/cli/docs/development-server.md)를 따른다.
이 모드의 UI 변경은 서버가 처리하고 백엔드, 설정 변경만 호스트를 재시작한다.

빌드 실패는 오류로 종료하고 마지막 성공 산출물을 유지한다.
Windows 패키지는 `dist/windows-x64/bunaway.cmd`를 실행한다.
`build.app`은 `src-bunaway/app.ts`를 지정한다. 모든 플랫폼에서 이 앱 정의를 사용하고
플랫폼별 부팅은 프레임워크가 담당한다.
macOS는 `dist/macos-arm64/<appId>.app`을 연다.
Windows는 함께 제공된 `launch.ps1`이 내부 Bun을 검증하고 실행한다.
macOS 명시적 인자는 `--package <절대 리소스 경로>`이며 `.app/Contents/Resources`다.
설치 프로그램, 정식 서명, 공증은 포함하지 않는다.

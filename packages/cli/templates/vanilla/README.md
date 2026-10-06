# bunaway vanilla

고정 Bun **1.4.2**로 `bun install` 후 `bun run doctor`, `bun run validate`,
`bun run dev`, `bun run build`를 실행한다.
프로젝트에 포함한 `vendor/bunaway` 스냅샷을 사용하므로 생성 원본 저장소는 필요 없다.
`bunaway.lock.json`이 프레임워크/SDK/host/프로토콜 버전과 vendor 파일 해시를 고정한다.
업그레이드는 [포함된 설치·버전 안내](vendor/bunaway/docs/framework-distribution.md)의
전체 snapshot 교체 절차를 따른다. 일부 SDK만 registry 버전으로 교체하지 않는다.
프레임워크 라이선스는 미결정이며 포함된 FRAMEWORK-LICENSE.txt/third-party 고지를 확인한다.

- Windows x64: PowerShell 7, MSVC C++ Build Tools, CMake/Ninja, WebView2 Evergreen.
- macOS arm64: macOS 14+, Xcode CLT. 로컬 ad-hoc 서명만 제공한다.
- 최초 빌드의 고정 Bun/네이티브 의존성 다운로드와 개발 의존성 설치에는 네트워크가 필요하다.
- 프로덕션 앱 실행은 패키지 내부 Bun을 사용하며 전역 Bun이나 node_modules는 필요 없다.

`src/web`는 실제 클라이언트 SDK로 명령을 호출하고 이벤트를 구독한다.
`src/backend`는 실제 백엔드 SDK로 범위 제한 Host API 저장 후 이벤트를 발행한다.
`policy.json`은 `main` 뷰의 `messages/` 읽기/쓰기만 허용한다.
저장 위치는 Windows `%LOCALAPPDATA%/bunaway/<appId>/data/messages/current.txt`,
macOS `~/Library/Application Support/bunaway/<appId>/data/messages/current.txt`다.

개발 변경은 UI/백엔드를 다시 번들하고 **전체 호스트/창을 재시작**한다.
이전 세션·요청·구독을 무효화하고 저장 요청을 자동 재전송하지 않는다.
HMR/입력 상태 보존은 제공하지 않는다. Ctrl+C 또는 창 닫기로 종료한다.

빌드 실패는 오류로 종료하고 마지막 성공 산출물을 유지한다.
Windows 패키지는 `dist/windows-x64/bunaway-host.exe`를 직접 실행한다.
macOS는 `dist/macos-arm64/<appId>.app`을 연다.
양쪽 명시적 실행 인자는 `--package <절대 리소스 경로>`이며 macOS는 `.app/Contents/Resources`다.
설치 프로그램·정식 서명·공증은 포함하지 않는다.

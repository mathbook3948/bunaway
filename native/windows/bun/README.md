# Windows Bun 호스트

번들 Bun 1.4.2가 앱 진입점이다. 메인은 기존 `createCore`와 앱을 실행하고,
UI Worker 하나가 STA에서 `bun:ffi`로 Win32 창과 WebView2 COM을 직접 소유한다.
I/O Worker 하나가 승인된 Host API를 검사한 파일 핸들로 실행한다.
앱 호스트와 백엔드 사이의 프로세스 IPC는 없으며 WebView2 자식 프로세스는 유지된다.

```powershell
# 저장소: 의존성 검증, 패키지 빌드, 실제 GUI/보안/수명/CLI 회귀
pwsh -NoProfile -File native/windows/bun/run.ps1
# 의존성만 확인 (다운로드/추출하지 않음)
pwsh -NoProfile -File native/windows/bun/prepare.ps1 -VerifyOnly
```

개발/빌드에는 PowerShell 7과 고정 Bun, 실행에는 WebView2 Evergreen이 필요하다.
MSVC, CMake, Ninja와 사용자 C/C++ 또는 Rust DLL은 필요 없다. Microsoft의 공식
`WebView2Loader.dll`과 시스템 DLL은 사용한다. 생성 앱은 `bunaway.json`의
`build.app`에 **default export AppDefinition** 파일을 지정한다.
프레임워크가 이 앱 정의를 가져와 부팅하며 개발자가 별도 프로세스 진입점을 작성하지 않는다.

CLI 생성 앱의 `bun run build` 결과는 `dist/windows-x64/bunaway.cmd` 또는
`pwsh -NoProfile -File dist/windows-x64/launch.ps1 -Wait`로 실행한다.
Launcher는 내부 Bun 절대 경로와 실행 전 해시를 검사하고 환경을 정리한다.
`bunaway package win-direct`와 `win-store-unpackaged`는 이 실행기를 사용하는
Inno Setup 설치 프로그램을 만든다. 서명으로 Bun 파일이 바뀌면 배포본 해시로
실행기를 갱신하며, 원본 Bun의 출처 해시는 별도로 유지한다.
단일 앱 exe는 제공하지 않는다. `win-store-msix`는 안전한 패키지 실행 경로가
검증될 때까지 명시적으로 거부한다. [패키징 안내](../../../packages/packaging/README.md).

같은 앱 데이터 디렉터리는 한 프로세스만 사용한다. 앱 import 전에 `host.lock`을
Windows 파일 핸들로 독점한다. 두 번째 실행은 기존 앱에 인자와 작업 디렉터리를
named pipe로 전달하고 종료한다. 앱 import, Worker, WebView 생성은 소유자만 수행한다.
기존 WebView 프로필과
저장 데이터는 유지한다. 잠금은 정상/강제 종료 때 OS가 해제하므로 남은 파일을 삭제할 필요가 없다.

STA의 bounded PeekMessage pump는 64개 처리 후 Bun에 제어를 돌려준다. OS 모달 중에는
UI Worker 메시지가 지연될 수 있으나 메인의 타이머, Promise, 네트워크는 계속 진행한다.
COM 콜백은 같은 OS 스레드에서 동기 HRESULT를 반환한다. `threadsafe: true`는 쓰지 않는다.
이벤트 분리, Close, HWND 파괴, 실제 프로세스 종료, COM 참조 0, 콜백 정지 이후 해제한다.
정상 WebView 정리는 30초, UI/메인 종료는 35/40초 제한을 갖고 초과는 실패다.

[실행 결과와 제약](../../../docs/architecture/windows-bun-results.md),
[실행 구조 ADR](../../../docs/decisions/0006-windows-bun-ui-worker.md).
기존 Windows C++ 호스트, probe, CMake와 전용 테스트는 삭제했다. macOS와 공유하는
앱, 화면 회귀 데이터는 `tests/fixtures/desktop/host/`에 있다.

명령 핸들러의 예기치 않은 예외는 stderr와 앱 로그의 `command-failed`에 명령 이름, 원래 메시지와 스택을 기록한다. WebView 응답에는 내부 오류를 넣지 않는다. 진단 기록 실패는 명령 응답에 영향을 주지 않는다.

실패한 로그 기록은 다시 시도하지 않는다. 쓰기 실패는 해당 호출에만 전달하며 이후 기록은 계속 처리한다. drain()은 대기 중인 기록 처리가 끝날 때까지 기다린다.

앱 정의의 `desktop.onOpen`은 초기 실행과 두 번째 실행의 인자, URL, 파일을 받는다.
`desktop.beforeQuit`는 마지막 창, 트레이, 앱의 종료 요청을 취소할 수 있다.
`desktop.closeBehavior: "hide"`와 `desktop.tray: { tooltip: "Memo" }`를 함께 지정하면
닫기 버튼으로 창을 숨기고 백엔드, WebView, 세션을 유지한다. 트레이 Open 또는
두 번째 실행으로 복원하며 Quit은 종료 검사를 거친다. 기본값은 마지막 창 닫기로 종료다.
URL scheme과 파일 확장자의 OS 등록은 제공하지 않으며 실행기에 전달된 인자를 처리한다.
[데스크톱 수명주기 결정](../../../docs/decisions/0013-desktop-lifecycle.md).

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
MSVC·CMake·Ninja와 사용자 C/C++ 또는 Rust DLL은 필요 없다. Microsoft의 공식
`WebView2Loader.dll`과 시스템 DLL은 사용한다. 생성 앱은 `bunaway.json`의
`windowsApp`에 **default export AppDefinition** 파일을 지정한다.
`backend`는 기존 프로세스 플랫폼의 `runBunApp` 진입점이다.

CLI 생성 앱의 `bun run build` 결과는 `dist/windows-x64/bunaway.cmd` 또는
`pwsh -NoProfile -File dist/windows-x64/launch.ps1 -Wait`로 실행한다.
Launcher는 내부 Bun 절대 경로와 실행 전 해시를 검사하고 환경을 정리한다.
서명된 단일 exe나 설치 프로그램은 제공하지 않는다.

STA의 bounded PeekMessage pump는 64개 처리 후 Bun에 제어를 돌려준다. OS 모달 중에는
UI Worker 메시지가 지연될 수 있으나 메인의 타이머·Promise·네트워크는 계속 진행한다.
COM 콜백은 같은 OS 스레드에서 동기 HRESULT를 반환한다. `threadsafe: true`는 쓰지 않는다.
이벤트 분리·Close·HWND 파괴·실제 프로세스 종료·COM 참조 0·콜백 정지 이후 해제한다.
정상 WebView 정리는 30초, UI/메인 종료는 35/40초 제한을 갖고 초과는 실패다.

[실행 결과와 제약](../../../docs/architecture/windows-bun-results.md),
[실행 구조 ADR](../../../docs/decisions/0006-windows-bun-ui-worker.md).
기존 Windows C++ 호스트·probe·CMake와 전용 테스트는 삭제했다. macOS와 공유하는
앱·화면 회귀 데이터는 `tests/fixtures/desktop/host/`에 있다.

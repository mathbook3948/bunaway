# Windows direct Bun FFI probe

프레임워크 이식 전의 독립 검증이다. `worker.ts`가 앱 백엔드를 실행하고, 같은
Bun 프로세스의 `ui.ts` Worker가 `main.ts`의 Win32, WebView2 COM 구현을 소유한다.
네이티브 포인터는 스레드 사이에 전달하지 않고 요청, 결과만 postMessage로 전달한다.
자체 C/C++, Rust 래퍼는 없으며 WebView2의 브라우저, 렌더러 프로세스는 유지된다.
제품 적용 구조와 단계별 검증 조건은 [ADR 0006](../../../docs/decisions/0006-windows-bun-ui-worker.md)을 따른다.

## 실행

Windows x64, PowerShell 7, WebView2 Evergreen 런타임이 필요하다. 스크립트가
저장소에 고정된 Bun과 SDK를 다운로드하고 해시를 검사한다. MSVC, Rust는 필요 없다.

```powershell
# Basic과 네 가지 Worker 모드를 각각 한 번 실행
mise run probe:windows-ffi
# 한 모드 실행 (기본값 Worker)
pwsh -NoProfile -File native/windows/ffi-probe/run.ps1 -Mode WorkerMulti
# 동일 시나리오 반복, 실패해도 나머지 실행 및 배치별 로그 보존
pwsh -NoProfile -File native/windows/ffi-probe/repeat.ps1 -Repeat 3
# 공식 WebView2 WinForms 종료 대조군 (진단 전용, Bun 구현에서 호출하지 않음)
pwsh -NoProfile -File native/windows/ffi-probe/control.ps1 -Repeat 3
```

| 모드 | 검사 |
| --- | --- |
| Basic | 단일 스레드의 창, WebView 생성, 21→42 화면 왕복, Promise, fetch, 타이머, GC, 크기 변경, 종료 |
| EarlyClose | 환경 생성 직후 종료, 늦은 생성 콜백과 COM 참조 해제 |
| Modal | Basic에 실제 SC_MOVE 추가. 같은 스레드의 Bun 타이머 정지를 재현하므로 실패 예상 |
| Worker / WorkerSize | 이동 / 크기 조절 모달 중 메인 백엔드의 타이머, Promise, fetch 실행, 모달 후 UI 메시지 전달 |
| WorkerEarlyClose | Worker 초기화 중 종료와 native teardown 후 늦은 응답 차단 |
| WorkerMulti | 한 UI Worker의 두 창, 첫 창의 42 표시, HWND 종료 후 두 번째 창의 44 표시, 각각의 자원 해제 |

종료 시 Close→DestroyWindow 후 environment와 STA pump를 유지한다. 브라우저 핸들
종료와 BrowserProcessExited를 따로 기록하고 이벤트 제거, 콜백 참조 0을 확인한 뒤
JSCallback을 해제한다. 해제 뒤 추가 pump에서 Invoke가 늘지 않는지도 검사한다.
최대 15초 관측하며 **Close 직전부터 정상 종료 이벤트 수신까지 5초 초과는 실패**다.
이는 실험 기준이며 WebView2의 시간 보장이 아니다. 실제 자원 누수와 구분해야 한다.

실행 로그, 프로필은 `build/windows-ffi-probe/`에 남는다. 단일 모드 로그는 덮어쓰지만
`repeat-*`는 stdout, stderr, 드라이버 출력, 결과, 소스 해시를 배치별로 보존한다.
`control-*`는 대조군 소스와 결과를 보존한다. 프로필은 실행마다 별도로 생성된다.
드라이버는 30초 제한 후 해당 테스트 프로세스 트리만 종료한다(대조군 35초).

## 확인한 결과: 2026-10-06

Windows `10.0.26200.0`, Bun `1.4.2` revision `744846f844374847c902b5e7fd59b4342a51ef99`,
SDK `1.0.4129.50`, 실제 WebView2 `154.0.4258.53`에서 실행했다.

- UI Worker에서 화면 왕복, 다중 창, 개별 종료, 콜백 해제를 확인했다. 약 313ms 이동
  모달 동안 백엔드 ticks=28, promises=28, network=27이었다. UI Worker 자체의
  Bun 작업과 메시지 수신은 모달이 끝날 때까지 지연된다.
- 최종 FFI 배치 `repeat-20261006-110204`: Worker 5.203초, 초기 종료 8.962초,
  두 창 2.865초, 3.744초. 4개 뷰 모두 정상 종료, 콜백 참조 0, 늦은 응답 차단을
  확인했지만 5초 기준으로는 **1/3 실행 통과**다.
- 공식 컨트롤 배치 `control-20261006-105928`: 정상 종료 이벤트가 14.406초,
  0.411초, 2.364초에 도착해 **2/3 실행 통과**다. 이 대조 없이 5초 초과를
  FFI 구조의 한계로 해석했던 판단은 정정했다. 네이티브 C++와 동일한 대조는 아니다.
- 이전 반복 배치 `repeat-20261006-103352`는 10/12, `repeat-20261006-104456`은
  4/15 통과했다. 종료 시간 초과와 모달이 타이머 전에 끝난 실패가 포함된다.
  `repeat-20261006-105051`, `105118`에서는 임시 폴더에서도 종료 지연이 재현됐다.
  이전 종료 시간은 HWND 파괴 뒤부터 측정했으므로 최종 계측과 구분한다.
- `Failed to unregister class Chrome_WidgetWin_0. Error = 1411` 경고의 원인은 미확정이다.
- 타입, Biome 검사는 통과했다. 최초 기존 계약 테스트는 **153 pass / 1 skip / 7 fail**:
  Windows symlink 생성 EPERM(로그 `contracts.txt`). 후속 실험에서 전체 계약 테스트와
  기존 C++ 제품 호스트 회귀는 재실행하지 않았다.

직접 FFI + UI Worker의 후속 이식 검증은 가능하다. 고정 about:blank 문서와 CSP는
제품의 실제 출처, 프레임, 세션, 권한, 탐색, 파일 정책을 대체하지 않는다. 요청 취소,
렌더러 장애 복구, 장시간 안정성, 모든 COM 실패 경로도 이 실험에서는 검증하지 않았다.
현재 제품은 `native/windows/bun/`에 적용했고 기존 Windows C++ 호스트는 삭제했다.

## 구현 근거

Windows x64 ABI만 지원한다. WNDCLASSEXW=80, MSG=48, RECT=16바이트이며, HRESULT는
i32, HWND는 u64, COM 포인터는 ptr로 다룬다. vtable, UTF-16 버퍼, COM 반환 문자열과
참조 수, 콜백 수명을 명시적으로 관리한다. 동기 반환이 필요한 COM 콜백에
`threadsafe: true`는 사용하지 않는다. 스레드 ID 검사는 외부 스레드의 JS 진입을
안전하게 만드는 장치가 아니다.

- [Tauri](https://github.com/tauri-apps/tauri/blob/79d3537620ddd136b81896b2048207e7c15e08b9/crates/tauri-runtime-wry/src/lib.rs), [Tao](https://github.com/tauri-apps/tao/blob/3fcda65f3f5a7c9ad164a622d2b98e4b5e313554/src/platform_impl/windows/event_loop.rs), [Wry](https://github.com/tauri-apps/wry/blob/cab3eace983007a16f132c14a34d0a220c707bea/src/webview2/mod.rs): UI 스레드 소유권과 WebView2 수명 순서.
- [WebView2 스레딩](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/threading-model), [종료 이벤트](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environment5#add_browserprocessexited): STA, 재진입 제약과 전체 런타임 자원 종료 확인.
- [고정 Bun의 FFI 콜백 구현](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/jsc/bindings/JSCFFIBridge.cpp#L58): threadsafe 호출의 비동기 전달.

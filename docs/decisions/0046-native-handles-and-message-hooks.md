---
status: accepted
---

# 네이티브 핸들과 Windows 메시지 훅은 범용 API로 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `f295a967`.

## 배경

아래 Electron과 Tauri 서술은 Electron v45.0.0과 Tauri 2.12.5(tao 0.37.2)의 문서와 소스 확인에 따른 것이며 이 저장소의
테스트로 검증한 것은 아니다.

두 가지를 정해야 했다. 하나는 신뢰된 네이티브 어댑터(플러그인의 Windows 어댑터)에 창 HWND와 WebView2 객체를 넘기는 범위,
다른 하나는 Windows 창 메시지를 임의로 구독하는 훅이다.

- Electron의 `BrowserWindow.getNativeWindowHandle()`은 플랫폼 핸들(Windows는 HWND)을 `Buffer`로 돌려준다.
  `hookWindowMessage(message, callback)`, `isWindowMessageHooked`, `unhookWindowMessage`, `unhookAllWindowMessages`는
  Windows 전용이며 실행 중 등록, 조회, 해제가 가능하다. 콜백은 `wParam`과 `lParam`을 `Buffer`로 받고 메시지당 하나만
  등록된다. 결과를 돌려주거나 기본 처리를 막는 수단은 없어 알림 전용이다.
- Tauri는 Rust 쪽 `Window::hwnd()`(Windows)를 제공하고, 플랫폼 WebView 접근인 `with_webview`는 `Webview`와
  `WebviewWindow`에만 공개돼 있다. 메시지 훅은 tao의 `with_msg_hook`이 창 빌더가 아니라 이벤트 루프 빌더에 한 번만
  설정하는 옵션이다. Tauri는 이를 메뉴 단축키 처리에 내부적으로 쓰며, 앱이 등록하는 공개 API와 실행 중 등록, 조회,
  해제 API는 확인하지 못했다. 앱이 `Window::hwnd()`로 직접 서브클래싱하는 것은 이 서술의 범위 밖이다.
- 이 저장소의 어댑터는 범용 핸들 대신 기능별 호스트 서비스를 받고, 창을 다루는 방식은 네 가지다.
  - 창 ID를 HWND로 해석하는 방식: 메뉴 어댑터는 `NativeMenuWindowHost.resolve`로 창 ID를 살아 있는 HWND로 해석하고
    `subscribe`로 파괴 전 알림을 받는다.
  - HWND 없이 창별 기능만 받는 방식: appearance 어댑터는 `NativeAppearanceWindows.subscribe`로 창별 기능
    (`NativeAppearanceWindow`)을 받으며, 호스트가 창 파괴 전에 그 기능을 무효화한다.
  - 호스트가 만든 숨은 창을 어댑터가 소유하는 방식: 트레이 어댑터는 `NativeTrayWindowHost.create`가 돌려준 HWND를 보관하고
    `destroy`로 직접 파괴한다. 대화상자 어댑터(`NativeDialogServices`)는 보이지 않는 임시 창을 `createWindow`로 만들어
    선택창이 닫힌 뒤 어댑터가 `destroyWindow`로 파괴한다. 단축키 어댑터도 같은 방식으로 숨은 창을 만들고 파괴한다.
  - 호스트 창의 HWND를 직접 받는 방식: 대화상자 서비스의 `owner()`는 선택창 소유자로 쓸 앱 창의 HWND를 `alive()`와 함께
    돌려준다.

  HWND는 공개 작업과 이벤트 경계를 넘지 않는다. 창 프로시저는 대체로 세션 메시지, 호스트 소유 메시지, 정책 거부, 등록된
  창 핸들러, 기본 프로시저 순서로 처리하며(`native/windows/bun/win32.ts`), `WM_GETMINMAXINFO`와 `WM_DPICHANGED`는 호스트
  단계가 등록된 핸들러를 직접 부르고 `WM_CLOSE`는 기본 프로시저 전에 반환하는 예외가 있다. `WM_APPCOMMAND`와 시스템
  컨텍스트 메뉴는 알림 전용 이벤트로 이미 제공한다.

## 결정

1. HWND나 WebView2 컨트롤러를 어댑터에 넘기는 범용 접근자를 추가하지 않는다(위 네 방식의 기존 서비스는 유지). 공개 작업과 이벤트에는 HWND, 컨트롤러
   포인터 같은 네이티브 값을 싣지 않는다.
2. 어댑터가 창에 접근해야 하는 새 기능은 기존처럼 그 기능에 필요한 최소 동작만 담은 서비스를 해당 플러그인의 어댑터
   계약에 추가한다. 호스트 창은 창 ID 해석과 파괴 전 알림, 또는 호스트가 무효화하는 창별 기능으로 접근시키고,
   수명 확인 수단 없이 호스트 창의 HWND를 넘기지 않는다. 어댑터가 숨은 창을 직접 만들면 그 창의 파괴는 어댑터가 맡는다.
3. Windows 메시지 훅(등록, 조회, 개별 해제, 전체 해제)을 제공하지 않는다. 앱이 필요로 하는 메시지는 `windows.appCommand`와
   `windows.systemContextMenu`처럼 이름이 고정된 알림 전용 이벤트로 추가한다. 이때 각 메시지마다 별도 결정과 테스트로
   처리 단계와 취소 가능 여부를 정한다.
4. 위 방식으로 만들 수 없는 용도가 확인되면 별도 결정에서 다룬다. 이때 호스트가 소유한 메시지 단계를 건드리지 않는
   알림 전용 구독으로 검토한다.

## 근거

- 두 프레임워크가 다르다. Electron은 핸들과 훅을 모두 열어 두고, Tauri는 창 핸들과 WebView 접근(`with_webview`)을
  열지만 메시지 훅은 앱에 공개하지 않는다. 이 저장소에는 Electron식 핸들 접근자와 메시지 훅을 쓰는 곳이 없고, 코어 계약은 작게 유지하고 기능은 플러그인별 좁은 계약으로
  두는 현재 구조에 맞는 쪽을 따랐다.
- 원시 HWND는 창이 파괴된 뒤 같은 값이 다른 창에 재사용될 수 있어 수명 검사 없이 넘기면 엉뚱한 창을 조작할 수 있다.
  메뉴는 창 ID 해석과 파괴 전 알림으로 HWND 수명을 호스트가 보호하고, 대화상자 소유자는 파괴 전 알림 없이 `alive()`로만
  확인한다. 이 저장소는 Electron의 `Buffer` 핸들처럼 수명 확인 수단 없이 핸들을 넘기지 않는
  쪽을 택하며, 호스트 창 HWND를 직접 받는 경로는 이 결정으로 늘리지 않는다.
- 범용 메시지 훅은 모든 메시지가 UI 스레드에서 Bun 콜백까지 오가야 하고, `WM_ENDSESSION`처럼 응답 기한이 있는 메시지와
  호스트가 먼저 처리하는 메시지 단계에 끼어들 수 있다. Electron의 훅도 결과를 돌려주지 못해 알림 용도에 한정되므로
  고정 이름 이벤트로 같은 용도를 안전하게 덮을 수 있다.
- 어댑터는 같은 프로세스에서 실행되는 신뢰된 앱 코드이므로 이 결정은 권한 경계를 바꾸지 않고, 호스트 계약이 늘어나는
  범위만 정한다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 두 항목을 완료로 표시한다.

---
status: accepted
---

# 네이티브 핸들과 Windows 메시지 훅은 범용 API로 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `f295a967`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

두 가지를 정해야 했다. 하나는 신뢰된 네이티브 어댑터(플러그인의 Windows 어댑터)에 창 HWND와 WebView2 객체를 넘기는 범위,
다른 하나는 Windows 창 메시지를 임의로 구독하는 훅이다.

- Electron의 `BrowserWindow.getNativeWindowHandle()`은 메인 프로세스에서 플랫폼 핸들을 `Buffer`로 돌려준다.
  `hookWindowMessage(message, callback)`, `isWindowMessageHooked`, `unhookWindowMessage`, `unhookAllWindowMessages`는
  Windows 전용이며 콜백은 `wParam`과 `lParam`을 `Buffer`로 받는다. 결과를 돌려주거나 처리를 막는 수단은 없다.
- Tauri는 Rust 쪽 `Window::hwnd()`와 `with_webview`(플랫폼 WebView 컨트롤러 접근)를 제공하고, 메시지 훅은 창 생성 시
  빌더 옵션(`with_msg_hook`)으로만 받는다. 실행 중 등록, 조회, 해제는 없다.
- 이 저장소의 어댑터는 범용 핸들 대신 기능별 호스트 서비스를 받고, HWND를 다루는 방식은 세 가지다.
  - 창 ID로 해석하는 방식: 메뉴 어댑터는 `NativeMenuWindowHost`로 창 ID를 살아 있는 HWND로 해석(`resolve`)하고 파괴 전
    알림(`subscribe`)을 받는다. appearance 어댑터는 `NativeAppearanceWindows.subscribe`로 창별 기능
    (`NativeAppearanceWindow`)을 받으며, 호스트가 창 파괴 전에 그 기능을 무효화한다.
  - 호스트가 만든 숨은 창을 어댑터가 소유하는 방식: 트레이 어댑터는 `NativeTrayWindowHost.create`가 돌려준 HWND를 보관하고
    `destroy`로 직접 파괴한다. 대화상자 어댑터(`NativeDialogServices`)는 보이지 않는 임시 창을 `createWindow`로 만들어
    선택창이 닫힌 뒤 호출자가 파괴한다.  - 호스트 창의 HWND를 직접 받는 방식: 대화상자 서비스의 `owner()`는 선택창 소유자로 쓸 앱 창의 HWND를 `alive()`와 함께
    돌려준다.
  HWND는 공개 작업과 이벤트 경계를 넘지 않는다. 창 프로시저는 대체로 세션 메시지, 호스트 소유 메시지, 정책 거부, 등록된
  창 핸들러, 기본 프로시저 순서로 처리하며(`native/windows/bun/win32.ts`), `WM_GETMINMAXINFO`와 `WM_DPICHANGED`는 호스트
  단계가 등록된 핸들러를 직접 부르고 `WM_CLOSE`는 기본 프로시저 전에 반환하는 예외가 있다. `WM_APPCOMMAND`와 시스템
  컨텍스트 메뉴는 알림 전용 이벤트로 이미 제공한다.

## 결정

1. HWND나 WebView2 컨트롤러를 어댑터에 넘기는 범용 접근자를 추가하지 않는다(위 세 방식의 기존 서비스는 유지). 공개 작업과 이벤트에는 HWND, 컨트롤러
   포인터 같은 네이티브 값을 싣지 않는다.
2. 어댑터가 창에 접근해야 하는 새 기능은 기존처럼 그 기능에 필요한 최소 동작만 담은 빌려 쓰는 기능
   (창 ID 해석, 파괴 전 알림, 해당 동작)을 해당 플러그인의 어댑터 계약에 추가한다. 호출자가 창 수명을 직접 관리하게
   하는 원시 핸들은 넘기지 않는다.
3. Windows 메시지 훅(등록, 조회, 개별 해제, 전체 해제)을 제공하지 않는다. 앱이 필요로 하는 메시지는 `windows.appCommand`와
   `windows.systemContextMenu`처럼 이름이 고정된 알림 전용 이벤트로 추가한다. 이때 각 메시지마다 별도 결정과 테스트로
   처리 단계와 취소 가능 여부를 정한다.
4. 위 방식으로 만들 수 없는 용도가 확인되면 별도 결정에서 다룬다. 이때 호스트가 소유한 메시지 단계를 건드리지 않는
   알림 전용 구독으로 검토한다.

## 근거

- 두 프레임워크가 다르다. Electron은 핸들과 훅을 모두 메인 프로세스에 열어 두고, Tauri는 핸들만 Rust 쪽에 열고 훅은
  생성 시 한 번만 받는다. 이 저장소에는 둘을 쓰는 곳이 없고, 코어 계약은 작게 유지하고 기능은 플러그인별 좁은 계약으로
  두는 현재 구조에 맞는 쪽을 따랐다.
- 원시 HWND는 창이 파괴된 뒤 같은 값이 다른 창에 재사용될 수 있어 수명 검사 없이 넘기면 엉뚱한 창을 조작할 수 있다.
  메뉴처럼 창 ID 해석과 파괴 전 알림을 거치는 방식은 이 문제를 호스트가 막는다. Electron의 `Buffer` 핸들은 이 보호가 없다
  (개선점). 호스트 창 HWND를 직접 받는 기존 경로는 대화상자 소유자 하나이며 `alive()`로 확인하고, 이 결정으로 늘리지 않는다.
- 범용 메시지 훅은 모든 메시지가 UI 스레드에서 Bun 콜백까지 오가야 하고, `WM_ENDSESSION`처럼 응답 기한이 있는 메시지와
  호스트가 먼저 처리하는 메시지 단계에 끼어들 수 있다. Electron의 훅도 결과를 돌려주지 못해 알림 용도에 한정되므로
  고정 이름 이벤트로 같은 용도를 안전하게 덮을 수 있다.
- 어댑터는 같은 프로세스에서 실행되는 신뢰된 앱 코드이므로 이 결정은 권한 경계를 바꾸지 않고, 호스트 계약이 늘어나는
  범위만 정한다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 두 항목을 완료로 표시한다.

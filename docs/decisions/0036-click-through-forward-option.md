---
status: accepted
---

# click-through 중 마우스 이동을 WebView에 전달하는 forward 옵션을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `480ec2b6`.

## 배경

`windows.setIgnoreMouseEvents`는 창을 click-through로 만든다. 켜진 동안 마우스 입력이 WebView를 포함한 창
전체를 지나 아래 창으로 간다. 이때 마우스 이동만이라도 WebView에 전달하는 `forward` 옵션을 제공할지 정해야 했다.

- Electron 45의 `setIgnoreMouseEvents(ignore, { forward })`는 macOS와 Windows에서만 `forward`를 받고 Linux는
  `ignore`만 쓴다. `forward`가 `true`이면 마우스 이동만 웹 페이지로 전달되어 `mousemove`, `mouseleave`(hover)가
  동작하고 클릭과 휠은 전달되지 않는다. Windows에서 관리자 권한 창이 활성이면 UIPI 때문에 `forward`가 일시
  정지된다. Electron의 Windows 구현은 `ignore`에서 `WS_EX_TRANSPARENT | WS_EX_LAYERED`를 설정하고, `forward`이면
  전역 저수준 마우스 훅(`SetWindowsHookEx(WH_MOUSE_LL)`)을 설치해 `WM_MOUSEMOVE`만 받아 합친 뒤, 커서가 창 안이면
  합성 `WM_MOUSEMOVE`를, 벗어나면 `WM_MOUSELEAVE`를 창에 보낸다. 마지막 창이 정리되면 훅을 해제한다. 폴링이나
  `WM_NCHITTEST`는 쓰지 않는다. macOS는 `setIgnoresMouseEvents`에 `setAcceptsMouseMovedEvents:`를 더한다. 흔한 용도는 투명 오버레이에서 "마우스가 그려진 요소 위에 있을 때만 입력을 받는" 동작이며, 요소 위에서
  `setIgnoreMouseEvents(false)`, 벗어나면 `true`로 전환한다.
- Tauri 2의 `set_ignore_cursor_events(bool)`은 `forward`에 해당하는 인자가 없다(tauri#6164가 열려 있다). tao는
  Windows에서 `WS_EX_TRANSPARENT | WS_EX_LAYERED`, macOS에서 `setIgnoresMouseEvents`, Linux에서 1x1 입력 영역을
  쓰며, 그 상태에서 WebView가 마우스 이동을 받는 경로는 제공하지 않는다.
- 이 저장소의 Windows 구현은 `WS_EX_LAYERED | WS_EX_TRANSPARENT`다. `WS_EX_TRANSPARENT` 창은 hit-test에서 제외되어
  마우스 메시지가 창으로 오지 않으므로, 이동을 WebView에 넘기려면 창 밖 입력을 따로 얻어야 한다. Electron처럼
  전역 저수준 마우스 훅(`WH_MOUSE_LL`)을 쓰면 앱 창이 아닌 곳의 마우스 움직임을 호스트가 계속 읽게 되고, 호스트가
  커서 위치를 상시 폴링해도 같다.
- 앱이 권한을 받아 주기적으로 조회하는 것은 호스트의 상시 관찰과 주체와 권한이 다르며, 앱이 이미 할 수 있다.
  `windows.getCursorPosition`(물리 화면 좌표)과 창 bounds 조회로 커서가 창 안 어느 요소 위에 있는지 계산해
  `setIgnoreMouseEvents`를 전환할 수 있다. 이 경우 앱은 click-through 중에도 주기적으로 조회해야 한다.

## 결정

1. `setIgnoreMouseEvents`에 `forward` 옵션과 마우스 이동 전달 이벤트를 제공하지 않는다. `ignore: boolean` 하나만
   받는 계약을 유지한다.
2. "요소 위에서만 입력을 받는" 오버레이는 앱이 `getCursorPosition`과 창 bounds로 커서가 상호작용 영역 안인지 계산해
   `setIgnoreMouseEvents`를 전환하는 방식으로 만든다. 두 조회는 물리 화면 좌표로 단위를 맞춰야 하고 각각 권한이
   필요하다. `setIgnoreMouseEvents`가 Windows 전용이므로 이 대안도 Windows 기준이다. 문서의 `setIgnoreMouseEvents` 절에 이
   방법과 `forward`가 없다는 점을 적는다.
3. 폴링 방식이 지연이나 부하 때문에 실제 요구를 못 채운다고 확인되면, 호스트가 창 영역별로 hit-test 여부를
   정하는 선언형 영역 옵션(앱 응답을 기다리지 않는 형태)을 별도 결정에서 다룬다.

## 근거

- 두 프레임워크가 다르다. Electron은 `forward`를 제공하고 Tauri는 없다. 이 저장소에서 `forward`를 쓰는 곳은 없고,
  Electron과 같게 구현하면 `WH_MOUSE_LL` 훅으로 앱 창 밖의 전역 마우스 입력을 호스트가 읽어야 한다. 사용처가 없는 기능을 위해 코어에 전역 입력
  관찰 경로를 두지 않고, 같은 결과를 낼 수 있는 `getCursorPosition` 조합을 쓴다.
- Electron의 `forward`가 덮는 용도(오버레이의 요소별 입력 수용)는 위 방식으로 구현할 수 있다. 다만 이 방식은
  마우스 이동이 WebView DOM 이벤트로 오지 않으므로 `mouseenter`, `mouseleave` 같은 이벤트를 쓰는 코드는 그대로
  옮길 수 없다. 이 차이를 문서에 적는다.
- 전역 저수준 훅은 다른 앱의 입력 흐름과 같은 메시지 큐 경로에 끼어들어, 훅 프로시저가 느리면 시스템 전체 마우스
  입력이 지연된다(Win32 문서 기준). 요구가 확인되기 전에 이 위험을 호스트에 들이지 않는다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 `setIgnoreMouseEvents` 절에 `forward`가 없다는 점과 `getCursorPosition` 기반 대안을 적는다.

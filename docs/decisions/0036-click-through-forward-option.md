---
status: accepted
---

# click-through 중 마우스 이동을 WebView에 전달하는 forward 옵션을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `480ec2b6`.

## 배경

`windows.setIgnoreMouseEvents`는 창을 click-through로 만든다. 켜진 동안 마우스 입력이 WebView를 포함한 창
전체를 지나 아래 창으로 간다. 이때 마우스 이동만이라도 WebView에 전달하는 `forward` 옵션을 제공할지 정해야 했다.

- Electron 45의 `setIgnoreMouseEvents(ignore, { forward })`는 macOS와 Windows에서만 `forward`를 받는다. `true`이면
  마우스 이동 메시지를 Chromium에 전달해 `mouseleave` 같은 마우스 이벤트가 계속 발생한다. 클릭은 계속 아래 창으로
  간다. 흔한 용도는 투명 오버레이에서 "마우스가 그려진 요소 위에 있을 때만 입력을 받는" 동작이며, 요소 위에서
  `setIgnoreMouseEvents(false)`, 벗어나면 `true`로 전환한다.
- Tauri 2의 `set_ignore_cursor_events(bool)`은 `forward`에 해당하는 인자가 없다. 켜면 창 전체가 입력을 받지 않고,
  그 상태에서 WebView가 마우스 이동을 받는 경로는 제공하지 않는다.
- 이 저장소의 Windows 구현은 `WS_EX_LAYERED | WS_EX_TRANSPARENT`다. `WS_EX_TRANSPARENT` 창은 hit-test에서 제외되어
  마우스 메시지가 창으로 오지 않으므로, 이동을 WebView에 넘기려면 창 밖 입력을 따로 가로채야 한다. 마우스
  메시지를 가로채는 방법은 전역 저수준 마우스 훅(`WH_MOUSE_LL`) 또는 커서 위치 폴링이며, 어느 쪽이든 앱 창이 아닌
  곳의 마우스 움직임을 호스트가 계속 읽게 된다.
- 폴링은 앱이 이미 할 수 있다. `windows.getCursorPosition`(물리 화면 좌표)과 창 bounds 조회로 커서가 창 안 어느
  요소 위에 있는지 계산해 `setIgnoreMouseEvents`를 전환할 수 있다.

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
  기능을 켜는 데 앱 창 밖의 전역 마우스 입력을 호스트가 읽어야 한다. 사용처가 없는 기능을 위해 코어에 전역 입력
  관찰 경로를 두지 않고, 같은 결과를 낼 수 있는 `getCursorPosition` 조합을 쓴다.
- Electron의 `forward`가 덮는 용도(오버레이의 요소별 입력 수용)는 위 폴링으로 구현할 수 있다. 다만 폴링은
  마우스 이동이 WebView DOM 이벤트로 오지 않으므로 `mouseenter`, `mouseleave` 같은 이벤트를 쓰는 코드는 그대로
  옮길 수 없다. 이 차이를 문서에 적는다.
- 전역 저수준 훅은 다른 앱의 입력 흐름과 같은 메시지 큐 경로에 끼어들어, 훅 프로시저가 느리면 시스템 전체 마우스
  입력이 지연된다(Win32 문서 기준). 요구가 확인되기 전에 이 위험을 호스트에 들이지 않는다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 `setIgnoreMouseEvents` 절에 `forward`가 없다는 점과 `getCursorPosition` 기반 대안을 적는다.

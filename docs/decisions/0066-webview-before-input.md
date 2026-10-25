---
status: accepted
---

# WebView before-input 이벤트와 취소를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `ab181b62`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

백엔드가 WebView로 가는 키보드, 마우스, wheel 입력을 페이지보다 먼저 받아 취소할 수 있는 이벤트를 제공할지 정해야 했다.

- Electron의 `webContents`는 `before-input-event`를 발생시킨다. 페이지에 입력이 전달되기 전에 메인 프로세스가 `preventDefault()`로 취소할 수
  있고, 문서상 대상은 키보드 입력(`keyDown`, `keyUp`)이다. 마우스와 wheel을 취소하는 같은 형태의 이벤트는 문서에서 확인하지 못했다.
- Tauri는 WebView 입력을 가로채는 이벤트를 제공하지 않는다. 앱은 페이지의 DOM 이벤트로 입력을 처리하고 `invoke`로 백엔드에 알린다.
  Tauri 쪽 전역 단축키는 별도 플러그인이다.
- WebView2의 `ICoreWebView2Controller::AcceleratorKeyPressed`는 포커스가 WebView에 있을 때 브라우저 가속키와 단축키 조합을 호스트에 먼저
  알리고 `Handled`로 막을 수 있다. 일반 문자 입력과 마우스, wheel은 이 이벤트의 대상이 아니다. WebView2에는 마우스와 wheel을 페이지보다
  먼저 받아 취소하는 호스트 이벤트가 없다.
- 이 저장소는 이미 `AcceleratorKeyPressed`로 Alt와 F10 메뉴 탐색을 처리한다. 메뉴 `accelerator`는 표시 전용이고, 포커스가 있는 WebView의
  키 입력은 일반 실행에서 페이지로 전달된다([TODO-windows](../TODO-windows.md)의 WebView 포커스 시 단축키 우선순위 항목).
  포커스와 관계없는 단축키는 `globalShortcut`이 맡는다. 입력 주입과 IME composition API는 제공하지 않는다([ADR 0047](./0047-input-injection-and-ime.md)).
- 입력마다 백엔드가 응답해야 취소가 가능한 이벤트는 UI 스레드의 입력 처리가 백엔드의 응답 시간에 묶인다. 키 입력 하나가 백엔드의 deadline을
  기다리면 입력 지연과 입력 순서 문제가 생기고, 백엔드가 응답하지 않을 때의 기본 동작을 계약으로 정해야 한다.
- 이 이벤트는 비밀번호 입력을 포함해 페이지의 모든 키 입력을 백엔드가 볼 수 있게 한다. 신뢰된 백엔드라 권한 경계를 넘지는 않지만, 모든 앱의
  입력 경로에 항상 켜진 관찰 지점을 만든다.

## 결정

1. 키보드, 마우스, wheel의 before-input 이벤트와 취소 API를 추가하지 않는다.
2. 페이지 안의 입력 처리는 페이지의 DOM 이벤트가 맡고, 백엔드가 필요하면 UI가 명령으로 알린다. 창 포커스와 관계없는 단축키는
   `globalShortcut`, 메뉴 표시용 조합은 메뉴 `accelerator`를 쓴다.
3. 특정 키 조합을 페이지보다 먼저 가로채야 하는 쓰는 곳이 확인되면 별도 결정에서 다룬다. 이때 대상은 `AcceleratorKeyPressed`가 알려주는
   조합으로 한정하고, 응답 시간 제한과 응답이 없을 때의 기본 동작, 입력 순서, 비밀번호 입력에서의 노출을 계약으로 먼저 정한다.

## 근거

- Electron은 키보드에 한해 취소 가능한 이벤트를 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는
  쪽을 따른다. 쓰는 곳이 없다(`plugins`, `packages`, `examples`에서 입력 가로채기 요구를 찾지 못했다).
- Electron과 같은 범위를 지금 제공해도 WebView2는 마우스와 wheel을 지원하지 않고 키보드도 가속키 조합에 한정된다. 같은 이름의 이벤트가
  플랫폼마다 다른 입력 범위를 약속하게 되어 계약이 모호해진다.
- 입력 경로에 백엔드 응답을 끼우지 않으면 기존 deadline 규칙과 UI 스레드 처리 순서를 그대로 유지한다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

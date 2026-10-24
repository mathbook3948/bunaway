---
status: accepted
---

# 앱 포커스와 활성 상태는 창의 `focused` 상태로 제공한다

결정일: 2026-10-25. 검토 기준: main `323b57a3`.

## 배경

앱 전체 포커스와 활성 상태를 앱 단위 API로 따로 제공할지 정해야 했다.
[ADR 0026](./0026-single-webview-single-window.md)에 따라 앱은 동시에 네이티브 창을 최대 하나만 가진다.
창 API는 이미 OS 전경 창 여부를 제공한다.

- `windows.isFocused()`는 창이 OS 전경 창인지 조회한다. Windows와 macOS에서 지원하며 창이 닫혀 있으면 `false`, 창을 만들거나 다시 만드는 중이면 `BUSY`다.
  모바일은 창 제어 작업이 `UNSUPPORTED`라 앱 포커스를 조회하는 경로가 없다.
- `windows.getSnapshot()`의 `state.focused`는 같은 값을 다른 상태와 함께 돌려준다. 창이 없으면 다른 상태 조회처럼 `INVALID_ARGUMENT`다.
- `windows.changed` 이벤트의 `changes`에 `focus`, `blur`가 전경 창 여부 변경으로 들어간다.
  `getSnapshot`과 `windows.changed`는 현재 Windows에서만 지원한다. 이벤트는 창의 문서에만 전달하며 뷰 `events`에
  `windows.changed`를 허용하면 받는다. `getSnapshot`은 뷰 `commands`와 `host.permissions`의 허용이 따로 필요하다.
  백엔드는 구독하지 않는다.
- [ADR 0026](./0026-single-webview-single-window.md)이 창이 없을 때 `INVALID_ARGUMENT`의 예외로 든 작업에
  `isFocused`가 더해진 상태다. `isFocused`는 닫힌 창에 `false`를 돌려준다.

`getWebViewState().focused`는 이 값과 다르다. 전경 창이면서 WebView 안에 키보드 포커스가 있을 때만 `true`이므로
앱 포커스 판단에 쓰지 않는다.

## 결정

앱 단위 포커스와 활성 상태 API는 추가하지 않는다. 앱이 포커스를 가졌는지는 그 앱의 창이 OS 전경 창인지로 정의하고
위 경로로 조회한다. 플랫폼마다 쓸 수 있는 경로가 다르므로 지원 범위는 위 설명을 따른다.

- Electron과 Tauri는 다르다. Electron은 앱 단위 신호를 제공한다. 모든 OS에서 `app`의 `browser-window-focus`,
  `browser-window-blur` 이벤트가 있고 macOS에는 `did-become-active`, `did-resign-active`, `app.isActive()`가
  더 있다. Windows와 Linux에서 앱 포커스는 `BrowserWindow.getFocusedWindow() !== null`로 판단한다.
  Tauri v2는 앱 단위 포커스 API 없이 창의 `is_focused()`와 `WindowEvent::Focused`만 제공한다.
- 두 방식이 다르므로 코어를 작게 두는 쪽을 따른다. 창이 하나뿐이면(ADR 0026) 앱 단위 신호가 가리키는 대상이 그 창
  하나라서 대부분의 경우 창 신호로 충분하고, 앱 단위 API를 따로 두면 비슷한 사실을 두 곳에서 제공하게 된다.
  두 신호가 갈리는 경우가 있다는 것을 알고도 Tauri처럼 창 신호만 제공한다. 예를 들어 Windows에서 소유 대화상자가
  전경이면 `isFocused`는 `false`이고, macOS에서 앱은 활성인데 창이 key window가 아니면 `isFocused`는 `false`다.
  macOS 앱 활성 이벤트가 쓰이는 곳이 생기면 그때 별도로 결정한다.
- 창이 닫혀 있으면 `isFocused`는 `false`다. Windows 구현은 창이 `GetForegroundWindow()`와 같은지 비교하므로
  소유 창(대화상자)이 전경이면 메인 창은 `false`다. 소유 대화상자나 시트가 열린 부모 창의 포커스 값은 Electron과
  Tauri 공식 문서에 정의되어 있지 않다. macOS에서 Electron의 `isFocused()`는 key window 기준이고 focus, blur
  이벤트는 main window 기준이라 서로 어긋날 수 있다. Tauri(tao)는 둘 다 key window 기준이다.
  bunaway의 macOS `isFocused`는 앱 활성과 key window를 함께 보며 시트와 대화상자 결과는 검증하지 않았다.
- 앱 단위 활성화 작업은 두지 않는다. 창을 전경으로 올리는 일은 창 작업인 `windows.focus()`와
  `windows.activate()`(Windows 한정)가 맡는다.

## 결과

- 새 API, 권한, 이벤트, 문서 변경은 없다. 창 포커스 상태는 기존 windows 레퍼런스가 설명한다.
- 추가 구현 항목이 없다.
- 백엔드가 포커스 변화를 구독하는 경로는 이 결정의 범위 밖이다.

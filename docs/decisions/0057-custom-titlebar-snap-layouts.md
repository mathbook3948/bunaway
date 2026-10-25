---
status: accepted
---

# 사용자 타이틀바 창에 Snap Layouts용 HTMAXBUTTON을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `68ce84a6`.

## 배경

Windows 11의 Snap Layouts는 최대화 버튼에 마우스를 올리면 뜨는 창 배치 선택기이다. 시스템은 창의
`WM_NCHITTEST` 결과가 `HTMAXBUTTON`일 때 그 위치를 최대화 버튼으로 보고 선택기를 띄운다. `titlebar: "custom"` 창은
시스템 caption을 제거하고 WebView의 CSS `app-region: drag`로 끌기 영역만 지정하므로 최대화 버튼이 앱의 HTML 버튼이다.
이 버튼에서 Snap Layouts를 보이려면 호스트가 그 버튼의 위치에서 `HTMAXBUTTON`을 돌려줘야 한다.

현재 구현:

- `titlebar: "custom"` 창은 `WS_CAPTION`만 빼고 `WS_THICKFRAME`, `WS_SYSMENU`, `WS_MAXIMIZEBOX`를 유지한다
  ([ADR 0037](./0037-window-corners-shape-and-creation-styles.md)). Win+방향키와 가장자리 끌기 Snap은 이 스타일로 동작하는 경로이다.
- `WM_NCHITTEST`에서 `HTMAXBUTTON`을 돌려주는 코드는 없다. 최대화 버튼은 앱이 그린 button이고 호스트는 그 위치를 모른다.
- `docs/site/src/content/docs/reference/host/windows.mdx`는 자동 snap-layout 버튼 overlay를 제공하지 않는다고 적고 있다.

선례(공개 API 기준):

- Electron은 `BrowserWindow`에 `HTMAXBUTTON`을 반환하거나 최대화 버튼 영역을 등록하는 옵션이 없다. 네이티브 caption 버튼을
  유지하는 `titleBarOverlay`(`titleBarStyle: "hidden"`과 함께)가 시스템 최대화 버튼을 그대로 쓰므로 Snap Layouts는
  이 경로로만 얻는다.
- Tauri 2의 `Window`와 `WindowBuilder`에도 같은 옵션이 없다. 사용자 타이틀바는 `decorations: false`와 `data-tauri-drag-region`으로 만들며
  Snap Layouts용 영역을 지정하는 API가 없다.

## 결정

1. `titlebar: "custom"` 창의 최대화 버튼 위치에 `HTMAXBUTTON`을 돌려주는 기능과, 그 위치를 앱이 등록하는 API는 제공하지 않는다.
2. Snap Layouts가 필요한 앱은 `titlebar: "system"`을 쓴다. 네이티브 caption 버튼을 유지하는 title-bar overlay는
   별도 항목([TODO-windows.md](../TODO-windows.md)의 title-bar overlay)에서 정하고, 그 결정이 이 용도를 대신 채운다.
3. 사용자 타이틀바 창의 Win+방향키와 가장자리 끌기 Snap은 지금처럼 `WS_THICKFRAME`과 `WS_MAXIMIZEBOX`로 유지한다.
   이 ADR은 그 동작을 바꾸지 않는다.
4. 문서에는 사용자 타이틀바의 HTML 최대화 버튼이 Snap Layouts를 띄우지 않으며, 필요하면 시스템 타이틀바를 쓰라고 적는다.

## 근거

- 두 프레임워크 모두 최대화 버튼 영역을 앱이 등록하는 API를 제공하지 않으므로 같은 쪽을 따른다. 쓰는 곳이 없는 기능으로 코어 API를
  늘리지 않는다.
- `HTMAXBUTTON`은 비클라이언트 hit-test 결과라서 그 영역에서는 마우스 이동, 눌림과 클릭이 WebView가 아니라 창 프로시저로 가고
  시스템이 최대화를 직접 수행한다. 그러면 HTML 버튼의 CSS hover와 active 표시, 클릭 핸들러, 키보드와 접근성 이름을
  대체 경로로 다시 맞춰야 하고, 앱이 `setMaximizable(false)`로 막은 최대화를 우회하지 않도록 호스트가 따로 보장해야 한다.
- 버튼 위치는 렌더러의 레이아웃, zoom, DPI와 문서 전환에 따라 바뀐다. 호스트가 이를 맞추려면 좌표 목록을 앱이 계속 갱신해 보내는 계약과
  갱신 전 오래된 좌표에서의 오작동 규칙까지 정해야 한다. 지금 CSS `app-region` 방식은 WebView2가 현재 문서에서 직접 hit-test하므로 이 부담이 없다.
- 이 영역이 최대화 버튼이 아닌 곳에 남으면 사용자의 클릭이 앱 대신 창 최대화로 처리되는 오동작이 되므로, 근거 없이 열어 둘 수 없다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 사용자 타이틀바 절 마지막 문장을 위 결정 4로 바꾼다.
- `docs/TODO-windows.md`의 해당 항목을 결정 완료로 표시한다.
- 이 영역을 지원하려면 별도 결정이 필요하다. 그때는 버튼 영역 등록 계약, 갱신 규칙과 `setMaximizable`과의 관계를 먼저 정하고
  Windows 11 CI에서 `WM_NCHITTEST` 결과와 선택기 표시를 확인한다.

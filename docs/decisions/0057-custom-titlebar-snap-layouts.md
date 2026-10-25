---
status: accepted
---

# 사용자 타이틀바 창에 Snap Layouts용 HTMAXBUTTON을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `ee1d2a1d`.

## 배경

Windows 11의 Snap Layouts는 최대화 버튼에 마우스를 올리면 뜨는 창 배치 선택기이다. 시스템은 창의
`WM_NCHITTEST` 결과가 `HTMAXBUTTON`일 때 그 위치를 최대화 버튼으로 보고 선택기를 띄운다. `titlebar: "custom"` 창은
시스템 caption을 제거하고 WebView의 CSS `app-region: drag`로 끌기 영역만 지정하므로 최대화 버튼이 앱의 HTML 버튼이다.
이 버튼에서 Snap Layouts를 보이려면 호스트가 그 버튼의 위치에서 `HTMAXBUTTON`을 돌려줘야 한다.

현재 구현:

- `titlebar: "custom"` 창은 `WS_CAPTION`만 빼고 `WS_THICKFRAME`, `WS_SYSMENU`, `WS_MAXIMIZEBOX`를 유지한다.
  `setResizable(false)`와 `setMaximizable(false)`는 각각 `WS_THICKFRAME`과 `WS_MAXIMIZEBOX`를 뺀다
  ([ADR 0037](./0037-window-corners-shape-and-creation-styles.md)).
- `WM_NCHITTEST`에서 `HTMAXBUTTON`을 돌려주는 코드는 없다. 최대화 버튼은 앱이 그린 button이고 호스트는 그 위치를 모른다.
- `docs/site/src/content/docs/reference/host/windows.mdx`는 네이티브 caption 버튼 overlay를 지원하지 않는다고 적고 있다.

선례(Electron 45.0.0, Tauri 2.12.5 소스와 문서 기준):

- Electron의 `BrowserWindow`에는 최대화 버튼 영역을 등록하거나 `HTMAXBUTTON`을 반환하게 하는 공개 옵션이 없다.
  소스에서 `HTMAXBUTTON`을 반환하는 곳은 Window Controls Overlay의 캡션 버튼 컨테이너뿐이고, 이는 `titleBarStyle: "hidden"`과
  `titleBarOverlay`를 함께 지정할 때만 켜진다. CSS `-webkit-app-region: drag` 영역은 `HTCAPTION`만 반환한다.
  `titleBarOverlay`의 하위 키는 `color`, `symbolColor`, `height`뿐이다. 그래서 공식적으로 Snap Layouts를 얻는 방법은 Electron이 그리는 캡션 버튼을
  쓰는 것뿐이다. `hookWindowMessage`는 메시지를 관찰만 하고 반환값을 돌려줄 수 없어 이 용도로 쓸 수 없다.
- Tauri의 `WindowBuilder`, `WebviewWindowBuilder`, `Window`에도 최대화 영역 등록이나 `HTMAXBUTTON` 관련 API가 없다.
  `title_bar_style`은 macOS 전용이고 Windows용 overlay 옵션도 없다. `data-tauri-drag-region`은 `mousedown`에서 창 끌기 또는
  더블클릭 최대화를 호출할 뿐 `WM_NCHITTEST`에 응답하지 않는다. 메인테이너는 WebView 안의 클릭에는 `WM_NCHITTEST`가
  전달되지 않아 Snap Layouts를 열 수 없다고 설명했고, 요청 이슈 tauri#4531은 열려 있다.
  이슈에는 앱이 `hwnd()`로 최대화 버튼 위치에 자식 창을 덮고 `HTMAXBUTTON`을 반환하는 비공식 우회가 올라와 있으나 공개 API는 아니다.

## 결정

1. `titlebar: "custom"` 창의 최대화 버튼 위치에 `HTMAXBUTTON`을 돌려주는 기능과, 그 위치를 앱이 등록하는 API는 제공하지 않는다.
2. Snap Layouts가 필요한 앱은 시스템 타이틀바(`titlebar: "system"`)를 쓴다. 시스템 caption 버튼은 OS가 hit-test하는
   경로라서 Snap Layouts의 전제가 되지만, 이 저장소의 창에서 실제로 뜨는지는 확인하지 않았다(`maximizable: false`와
   `resizable: false` 창은 `WS_MAXIMIZEBOX`와 `WS_THICKFRAME`이 빠진다). 네이티브 caption 버튼을 유지하는 title-bar overlay는
   아직 제공하지 않으며 별도 항목([TODO-windows.md](../TODO-windows.md)의 title-bar overlay)에서 정한다.
3. 이 ADR은 `WS_THICKFRAME`과 `WS_MAXIMIZEBOX`를 다루는 현재 동작(`resizable`, `maximizable`)을 바꾸지 않는다.
   `resizable: false` 창의 Snap 참여는 확인되지 않았고 [TODO-windows.md](../TODO-windows.md)의 해당 항목에서 확인한다.
4. 문서에는 사용자 타이틀바의 HTML 최대화 버튼이 Snap Layouts를 띄우지 않는다고 적고, 대안으로 최대화가 켜진 시스템 타이틀바를
   안내한다. 대안에서 Snap Layouts가 뜨는지는 확인하지 않았다고 함께 적는다.

## 근거

- 두 프레임워크 모두 최대화 버튼 영역을 앱이 등록하는 API를 제공하지 않으므로 같은 쪽을 따른다. Electron의 유일한 경로인
  네이티브 caption 버튼 overlay는 이 저장소에서 별도 항목으로 남아 있다. 쓰는 곳이 없는 기능으로 코어 API를
  늘리지 않는다.
- `HTMAXBUTTON`은 비클라이언트 hit-test 결과이다. 이 저장소의 WebView 호스팅에서 부모 창이 WebView 영역의 `WM_NCHITTEST`를
  받는지는 확인하지 않았다. Tauri 메인테이너는 WebView 안의 클릭에는 이 메시지가 전달되지 않는다고 설명했다. 받는다면 그 영역의
  입력은 WebView 대신 창 프로시저가 처리하므로 HTML 버튼의 CSS hover와 active 표시, 클릭 핸들러, 접근성 이름을 별도 경로로 맞춰야
  하고, `setMaximizable(false)`로 막은 최대화를 우회하지 않는지도 확인해야 한다. 받지 못한다면 호스트가 자식 창을 덮는 식의 우회가 필요하다.
  어느 쪽이든 코어가 새 계약과 검증을 떠안는다.
- 버튼 위치는 렌더러의 레이아웃, zoom, DPI와 문서 전환에 따라 바뀐다. 호스트가 이를 맞추려면 좌표 목록을 앱이 계속 갱신해 보내는 계약과
  갱신 전 오래된 좌표에서의 오작동 규칙까지 정해야 한다. 지금 CSS `app-region` 방식은 WebView2가 현재 문서에서 직접 hit-test하므로 이 부담이 없다.
- 이 영역이 최대화 버튼이 아닌 곳에 남으면 사용자의 클릭이 앱 대신 창 최대화로 처리되는 오동작이 되므로, 근거 없이 열어 둘 수 없다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 사용자 타이틀바 절 마지막 문장을 위 결정 4로 바꾼다.
- `docs/TODO-windows.md`의 해당 항목을 결정 완료로 표시한다.
- 이 영역을 지원하려면 별도 결정이 필요하다. 그때는 버튼 영역 등록 계약, 갱신 규칙과 `setMaximizable`과의 관계를 먼저 정하고
  Windows 11 CI에서 `WM_NCHITTEST` 결과와 선택기 표시를 확인한다.

---
status: accepted
---

# 네이티브 caption 버튼을 유지하는 title-bar overlay를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `01de66d6`.

## 배경

title-bar overlay는 시스템 caption(제목 줄)을 없애고 WebView가 그 자리까지 차지하되, 최소화, 최대화와 닫기 버튼만
네이티브 모양으로 오른쪽 위에 남기는 방식이다. 앱은 나머지 영역을 자기 HTML 타이틀바로 채운다.

현재 구현:

- `titlebar: "custom"` 창은 `WS_CAPTION`만 빼고 `WS_THICKFRAME`, `WS_SYSMENU`, `WS_MAXIMIZEBOX`를 유지한다.
  CSS `app-region: drag`로 끌기 영역을 지정하고, 최소화, 최대화와 닫기는 앱이 그린 button이
  `windows.minimize`, `windows.toggleMaximize`, `windows.close`를 호출한다.
- 호스트가 caption 버튼을 그리거나 그 위치를 `WM_NCHITTEST`로 돌려주는 코드는 없다
  ([ADR 0057](./0057-custom-titlebar-snap-layouts.md)).

선례(Electron 45.0.0, Tauri 2.12.5 소스와 문서 기준, [ADR 0057](./0057-custom-titlebar-snap-layouts.md)의 검토 결과):

- Electron은 `titleBarStyle: "hidden"`과 `titleBarOverlay`(`color`, `symbolColor`, `height`)를 함께 지정할 때만
  Windows에서 caption 버튼 컨테이너를 켠다. 버튼은 Electron이 그리고 `HTMINBUTTON`, `HTMAXBUTTON`, `HTCLOSE`
  hit-test로 처리한다. 앱이 정하는 것은 색과 높이뿐이다.
- Tauri에는 Windows용 title-bar overlay 옵션이 없다. `decorations: false` 창에서 앱이 직접 버튼을 만든다.
  `title_bar_style`은 macOS 전용이다.

## 결정

1. 네이티브 caption 버튼을 유지하는 title-bar overlay와 그 옵션(`titleBarOverlay`에 해당하는 색, 높이 설정)을
   제공하지 않는다.
2. 사용자 타이틀바가 필요한 앱은 `titlebar: "custom"`과 CSS `app-region`, 앱이 그린 button으로
   `windows.minimize`, `windows.toggleMaximize`, `windows.close`를 호출한다. 네이티브 caption 모양과 Snap Layouts가
   필요한 앱은 `titlebar: "system"`을 쓴다.
3. `titlebar: "custom"`의 현재 동작과 `getTitlebar()` 계약은 바꾸지 않는다.
4. 문서에는 overlay를 지원하지 않는다고 적고 위 대안을 안내한다.

## 근거

- Electron은 호스트가 버튼을 그리는 방식이고 Tauri는 제공하지 않는다. 두 선례가 갈리므로 코어를 작게 두는 쪽을 따른다.
  앱이 만든 버튼으로 같은 결과를 얻을 수 있고 이 저장소에서 이를 요구한 사용처도 없다.
- 호스트가 버튼을 그리면 WebView 위에 겹치는 자식 창이나 비클라이언트 영역 처리가 필요하다. 그러면 시스템 테마(밝음, 어두움, 고대비),
  DPI 변경, hover와 pressed 상태, 접근성 이름, `setMaximizable(false)`와 `setClosable(false)` 반영, RTL 배치,
  전체화면 진입과 해제 때의 숨김을 코어가 모두 맞춰야 한다. 버튼 영역을 WebView 문서와 겹치지 않게 하려면 앱에 영역 크기를 알려
  주는 계약도 새로 정해야 한다.
- 이 검증은 Windows 11, Windows 10과 고대비 테마에서 시각 결과를 비교해야 하고 CI의 합성 입력으로 hit-test 결과와 렌더링을
  모두 확인하기 어렵다. 확인하지 못한 채 공개 API를 늘리지 않는다.
- 앱이 그린 버튼은 `app-region: no-drag`와 키보드로 접근 가능한 이름 있는 button이라는 기존 계약으로 접근성을 앱이 책임진다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 사용자 타이틀바 절에서 overlay 문장을 결정 2로 바꾼다.
- `docs/TODO-windows.md`의 해당 항목을 결정 완료로 표시한다. 전체 decorations와 frame API 항목은 그대로 둔다.
- 이를 지원하려면 별도 결정이 필요하다. 그때는 색과 높이 옵션, 앱에 알려 줄 영역 계약, 버튼 상태와 접근성, 테마별
  Windows CI 검증 방법을 먼저 정한다.

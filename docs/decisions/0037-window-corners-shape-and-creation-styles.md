---
status: accepted
---

# 창 모서리, shape와 생성 스타일 옵션의 지원 범위

결정일: 2026-10-25.

## 배경

Windows 창의 둥근 모서리, 창 shape, `WS_THICKFRAME`과 `WS_EX_NOREDIRECTIONBITMAP` 같은 생성 옵션을
공개 계약으로 둘지 정해야 했다. 아래 Electron과 Tauri 동작은 Electron v45.0.0(Chromium 156)과
Tauri 2.12.5(tao 0.37.0)의 소스와 문서를 읽어 확인한 것이며 이 저장소의 테스트로 실행한 것은 아니다.

Electron:

- `roundedCorners`: Windows에서는 frameless 창 생성 시 `DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE)`만
  호출한다. Windows 11(빌드 22000) 미만에서는 효과가 없고, `thickFrame: false`나 `transparent: true`이면 꺼진다.
  프레임 있는 창은 옵션을 읽지 않고 OS 기본을 따른다.
- `thickFrame`: Windows 전용, 기본 `true`, `WS_THICKFRAME` 사용 여부다. `false`이면 그림자, 최소화와 최대화 애니메이션,
  가장자리 크기 조절이 사라진다. frameless 창은 `WS_THICKFRAME|WS_CAPTION`을 제거하고 둥근 모서리를 끄며,
  프레임 창은 `WS_THICKFRAME`만 제거하고 `CanResize()`가 `false`가 된다. `transparent`이면 강제로 `false`다.
- `setShape`: v45 문서에서 Windows와 Linux의 Experimental이고 macOS는 지원하지 않는다. 사각형의 합집합을
  `SetWindowRgn`으로 적용하므로 곡선은 계단 모양이고, 영역 밖은 그려지지 않으며 클릭은 뒤 창으로 간다.
- `WS_EX_NOREDIRECTIONBITMAP`은 API로 노출하지 않는다. Chromium이 Windows 11 22H2 이상에서 기본으로 붙인다.

Tauri 2와 tao:

- `no_redirection_bitmap`(Windows)과 `shadow`(decorations 없는 창에서 1px 테두리, Windows 11 둥근 모서리)가 있다.
- `roundedCorners`, shape, `thickFrame`에 해당하는 API는 없다(tauri#9287 열림).

이 저장소의 현재 구현(`native/windows/bun/window-style.ts`, `win32.ts`):

- 모든 창은 `WS_OVERLAPPEDWINDOW`로 만든다. `titlebar: "custom"`은 `WS_CAPTION`만 빼므로 `WS_THICKFRAME`,
  `WS_SYSMENU`, `WS_MINIMIZEBOX`, `WS_MAXIMIZEBOX`는 유지한다.
- `resizable: false`(`setResizable`)는 `WS_THICKFRAME`을 제거한다. 최소화와 최대화 버튼 스타일은 `minimizable`과
  `maximizable`이 따로 제어한다.
- `WM_NCHITTEST`에서 `HTMAXBUTTON`을 반환하는 코드는 없다. 사용자 제목 표시줄은 CSS `app-region`으로 끌기만 한다.
- 그림자는 `setHasShadow`가 DWM 비클라이언트 렌더링 정책으로 제어한다.
- 둥근 모서리를 다루는 코드는 없다.

## 결정

1. 둥근 모서리: 제공한다. `titlebar: "custom"` 창에서만 `false`로 끌 수 있다. Windows 11 미만은 효과가 없고
   기본 상태를 그대로 조회한다. 네이티브 제목 표시줄(프레임) 창은 OS 기본을 따르며 `false` 설정은 `UNSUPPORTED`로
   거부한다(`setHasShadow`와 같은 규칙). 구현은 이 ADR과 별개의 PR에서 한다.
2. `WS_THICKFRAME` 옵션: 별도 옵션으로 제공하지 않는다. 크기 조절을 막는 수단은 `resizable`이고, 그림자는
   `setHasShadow`가 맡는다. 이 ADR은 Windows 11에서 `resizable: false` 창의 Snap 동작을 확정하지 않는다(열린 질문).
3. 창 shape(`setShape`에 해당)는 제공하지 않는다.
4. `WS_EX_NOREDIRECTIONBITMAP`은 제공하지 않는다.
5. corner-smoothing CSS는 렌더러가 정하는 영역이고 이 저장소는 관여하지 않는다. 문서에는 둥근 모서리가
   창 프레임(DWM)에만 적용되고 WebView 콘텐츠의 CSS 모서리와 별개라고 적는다.

## 근거

- 둥근 모서리는 Electron이 제공하고 Tauri는 제공하지 않는다. 다를 때는 Electron을 따른다. 호출이 DWM 속성
  한 번이라 코어가 늘지 않고, 타이틀바 없는 창이 Windows 11에서 둥근 모서리를 원하는 흔한 요구에 맞다.
  Electron은 frameless 창이면 옵션이 적용되지만 이 저장소는 `custom`일 때만 끌 수 있게 제한한다. 프레임 창에
  `false`를 조용히 무시하면 설정과 조회가 어긋나므로 `hasShadow`처럼 명시적으로 거부한다. 이는 Electron과 다른 부분이다.
- 아래 DWM 동작은 Microsoft의 [Apply rounded corners](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-rounded-corners)
  문서를 출처로 하며 이 저장소에서 실행으로 확인하지 않았다. 이 문서에 따르면 `DWMWA_WINDOW_CORNER_PREFERENCE`는 힌트이며
  보장이 아니고, 최대화와 스냅된 창은 설계상 둥글지 않으며, per-pixel alpha나 window region이 있는 창은 둥글게 처리되지
  않는다. Windows 11(빌드 22000 이상)에서만 효과가 있다는 조건은 Electron 구현에서 확인한 것이다. 그래서 구현 PR은
  이 동작을 Windows CI에서 먼저 확인하고, 계약은 조회 값을 "요청한 선호"로 정의한다.
- `WS_THICKFRAME` 옵션을 제공하지 않는 것은 Electron과 다른 결정이다. 이유는 다음과 같다.
  - `titlebar: "custom"` 창은 `resizable: true`인 동안 `WS_THICKFRAME`을 유지하므로 Electron의 `thickFrame: false`가
    만드는 Snap과 최대화 문제가 생기지 않는다. `resizable: false`로 `WS_THICKFRAME`이 빠진 창은 아래 열린 질문 1과
    같은 상태이며 확인하지 못했다. Electron에서 `thickFrame: false`는 프레임 창의 최대화 버튼 비활성
    ([electron/electron#10414](https://github.com/electron/electron/issues/10414)), Windows 10 frameless 창의
    Win+방향키와 끌기 Snap 실패(기본값에서는 동작, [#11568](https://github.com/electron/electron/issues/11568)),
    `transparent: true`(thickFrame 강제 `false`)에서 Snap Assist의 창 인식 실패
    ([#37888](https://github.com/electron/electron/issues/37888))와 함께 보고되어 있다.
  - 크기 조절 금지는 `resizable`로, custom titlebar 창의 그림자 제거는 `setHasShadow`로 표현된다. 네이티브 제목 표시줄
    창은 그림자를 끌 수 없고(`setHasShadow(false)`는 `UNSUPPORTED`) Electron의 `thickFrame: false`는 이 경우의 그림자도
    제거하므로 두 API가 옵션을 완전히 대신하지는 않는다. 그 외 남는 효과는 최소화와 최대화 애니메이션 제거이고, 이를 위해 Snap과
    시스템 메뉴 동작이 달라지는 스타일 비트를 공개 계약으로 만들 필요는 확인되지 않았다.
  - Tauri에는 같은 옵션이 없다.
- 창 shape는 Electron도 Experimental로 표시하고 macOS는 지원하지 않으며 Tauri에는 없다. `SetWindowRgn`은 안티앨리어싱이
  없어 곡선이 계단 모양이고, 영역 밖 입력 통과 규칙과 layered 스타일(opacity, click-through), WebView2와 DWM 그림자와의
  관계를 계약으로 정해야 한다. 쓰는 곳이 없어 제공하지 않는다.
- `WS_EX_NOREDIRECTIONBITMAP`은 Electron이 노출하지 않고 Chromium이 조건에 맞으면 스스로 붙인다. Tauri만 노출한다.
  Microsoft의 [Extended Window Styles](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles)
  문서는 이 스타일을 "The window does not render to a redirection surface. This is for windows that do not have visible
  content or that use mechanisms other than surfaces to provide their visual."로 정의한다. 이 저장소에는 이 스타일을
  쓰거나 요구하는 코드와 문서가 없고, WebView2를 호스팅하는 창에서 어떻게 동작하는지는 확인하지 않았다. bunaway는
  이 스타일을 앱 옵션으로 두지 않는다.

## 열린 질문

- Windows 11에서 `WS_THICKFRAME`이 없는 창(`resizable: false`)이 Snap(Win+방향키, 가장자리 끌기)에 참여하는지.
  Windows 10의 Electron 보고(위 #11568)는 있으나 Windows 11 근거는 확인하지 못했다. 깨지는 것으로 확인되면
  `resizable: false`가 `WS_THICKFRAME`을 빼는 방식 자체를 다시 봐야 하며, 그때 `thickFrame` 옵션 결정도 다시 연다.
- `titlebar: "custom"` 창에 Snap Layouts(최대화 버튼 hover)를 주려면 `WM_NCHITTEST`가 `HTMAXBUTTON`을 반환해야 하는데
  현재 구현은 반환하지 않는다. 별도 기능으로 다룬다.
- `setHasShadow(false)`로 비클라이언트 렌더링을 끈 창에서 둥근 모서리 선호가 어떻게 보이는지는 구현 PR의 Windows CI에서
  실행으로 확인한다.

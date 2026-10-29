---
status: accepted
---

# Windows에서 Electron 방식의 창 shape는 제공하지 않는다

결정일: 2026-10-29. 검토 기준: main `943583d2`.

## 배경

[ADR 0037](./0037-window-corners-shape-and-creation-styles.md)은 창 모서리, shape와 생성 스타일을 함께 다루며
결정 3에서 창 shape를 제공하지 않는다고 정했다. 이 ADR은 그중 Windows 창 shape 항목만 따로 떼어, 무엇을
제공하지 않는지와 앱이 대신 쓸 수 있는 수단, 다시 열 조건을 정한다. ADR 0037의 결정은 바꾸지 않는다.

Electron과 Tauri 동작은 ADR 0037이 Electron v45.0.0과 Tauri 2.12.5(tao 0.37.0)의 소스와 문서를 읽어 확인한
내용을 따른다. 이 저장소의 테스트로 실행한 것은 아니다.

- Electron `BrowserWindow.setShape(rects)`는 v45 문서에서 Windows와 Linux의 Experimental API이고 macOS는 지원하지
  않는다. Windows 구현은 사각형의 합집합을 `SetWindowRgn`으로 적용한다. 그래서 곡선은 계단 모양이 되고, 영역 밖은
  그려지지 않으며 클릭은 뒤 창으로 간다.
- Tauri 2와 tao에는 창 shape에 해당하는 API가 없다.
- 이 저장소에는 창 region을 설정하는 코드와 공개 계약이 없다. Windows 창 모양과 관련된 기존 계약은 둥근 모서리
  (`DWMWA_WINDOW_CORNER_PREFERENCE`, ADR 0037 결정 1), `window.transparent`(`titlebar: "custom"` 전제),
  `setHasShadow`, layered 스타일을 공유하는 opacity와 click-through(`setIgnoreMouseEvents`)다.

## 결정

1. Windows에서 Electron `setShape`에 해당하는 창 shape API를 제공하지 않는다. 사각형 목록, 경로, 마스크 이미지 등
   어떤 형식으로도 창 region을 설정하는 공개 계약을 만들지 않는다.
2. 둥근 모서리는 이 결정과 별개로 ADR 0037 결정 1의 계약을 그대로 따른다. 창 프레임(DWM)에만 적용되고 WebView
   콘텐츠의 CSS 모서리와는 별개다.
3. 사각형이 아닌 모양이 필요한 앱은 `window.transparent: true` 창에서 WebView 콘텐츠를 CSS(`border-radius`,
   `clip-path`, 투명 배경)로 그린다. 이 방법은 보이는 모양만 바꾼다. 투명한 영역의 입력이 뒤 창으로 가는지는 이
   저장소가 계약으로 정하지 않았고 확인하지도 않았다. 창 전체의 입력을 통과시켜야 하면 앱이 `getCursorPosition`과
   창 bounds로 `setIgnoreMouseEvents`를 전환한다([ADR 0036](./0036-click-through-forward-option.md)).
4. 이 결정은 Windows만 다룬다. macOS는 Electron도 `setShape`를 지원하지 않으며, macOS 지원 범위는 이 ADR에서 정하지
   않는다.
5. 코드, 공개 계약, 스키마, 권한, 이벤트, 네이티브 코드 변경은 없다.

## 근거

- Electron 안에서도 Experimental이고 macOS는 지원하지 않으며 Tauri에는 없다. Experimental API를 Windows 공개 계약으로
  옮기면 upstream이 바꾸거나 없앨 수 있는 동작을 이 저장소가 안정 계약으로 떠안는다.
- `SetWindowRgn`은 안티앨리어싱이 없어 곡선이 계단 모양이다. 매끄러운 모양이 필요한 경우 결국 투명 창과 CSS를
  쓰게 되므로, region API는 그 용도를 대신하지 못한다.
- region을 계약으로 두려면 영역 밖 입력 통과 규칙, layered 스타일(opacity, click-through)과의 조합, WebView2
  콘텐츠 경계, DWM 그림자와 둥근 모서리와의 관계를 정해야 한다. Microsoft의
  [Apply rounded corners](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-rounded-corners)
  문서에 따르면 window region이 있는 창은 둥글게 처리되지 않으므로(ADR 0037 근거에서 인용, 이 저장소에서 실행으로
  확인하지 않음), 이미 제공하는 둥근 모서리 계약과도 충돌한다.
- 현재 앱과 플러그인 어디에도 창 region이 필요한 사용처가 확인되지 않았다.

## 다시 열 조건

- Electron이 `setShape`의 Experimental 표시를 없애거나 Tauri가 같은 기능을 제공할 때.
- 투명 창과 CSS, click-through 전환으로 해결되지 않는 사용처(모양 밖 영역의 입력이 반드시 뒤 창으로 가야 하는 경우)가
  앱이나 플러그인에서 확인될 때. 이때 region과 둥근 모서리, layered 스타일의 조합을 Windows CI로 먼저 확인한다.

## 결과

- `docs/TODO-windows.md`의 창 shape 항목이 이 결정과 ADR 0037을 참조한다.
- Electron에서 `setShape`를 쓰던 앱은 결정 3의 투명 창과 CSS로 옮기고, 입력 통과가 필요하면 `setIgnoreMouseEvents`
  전환을 쓴다.

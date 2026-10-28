---
status: accepted
---

# 창 decorations의 실행 중 변경과 별도 frameless 모드를 제공하지 않는다

결정일: 2026-10-28. 검토 기준: main `5832b295`.

## 배경

`docs/TODO-windows.md`의 "decorations와 frame의 초기 설정, 변경과 조회" 항목은 세 가지로 나뉜다.

- 초기 설정: 선언과 생성별 `options.window.titlebar`가 `"system"`(기본) 또는 `"custom"`을 고른다.
- 조회: `windows.getTitlebar()`가 `"system" | "custom"`을 돌려준다(`plugins/windows/src/contract.ts`의
  `windows.getTitlebar`, 입력 `null`). 전체화면 중에도 전체화면 진입 전에 저장한 스타일을 읽으므로 생성 시 모드를 반환한다
  (`native/windows/bun/win32.ts`의 `getTitlebar`, `normalStyle`).
- 변경: 실행 중 모드 전환(`setDecorations`류)과, 창 스타일 비트를 직접 지정하는 옵션이나 별도 frameless 모드는 없다.

이미 제공하는 것:

- `titlebar: "custom"` 창은 `WS_CAPTION`만 빼고 `WS_THICKFRAME`, `WS_SYSMENU`, `WS_MAXIMIZEBOX`를 유지한다
  (`native/windows/bun/window-style.ts`). 사용자에게 보이는 caption 없는 창, CSS `app-region` 끌기, 네이티브 크기 조절
  테두리, 그림자와 시스템 메뉴가 그대로 있다.
- 네이티브 caption 버튼을 유지하는 title-bar overlay는 제공하지 않는다([ADR 0088](./0088-titlebar-overlay.md)).
- `WS_THICKFRAME` 생성 옵션은 제공하지 않는다. 크기 조절은 `resizable`, 그림자는 `setHasShadow`가 맡는다
  ([ADR 0037](./0037-window-corners-shape-and-creation-styles.md)).
- Snap Layouts는 `titlebar: "system"`에서만 쓰도록 안내한다([ADR 0057](./0057-custom-titlebar-snap-layouts.md)).

선례(Electron 45.0.0, Tauri 2.12.5의 공개 문서와 소스를 읽은 결과이며 이 저장소의 실행 결과가 아니다):

- Electron은 `frame: false`와 `titleBarStyle`을 창 생성 옵션으로만 받는다. 생성 후 frame을 켜고 끄는 API는 없다.
- Tauri는 `decorations: false` 생성 옵션 외에 `set_decorations`와 `is_decorated`로 실행 중 변경과 조회를 제공한다.

## 결정

1. 실행 중 decorations 전환(`setDecorations`, `isDecorated`에 해당하는 API)을 제공하지 않는다. 모드는 생성 시에 정하고
   `getTitlebar()`로 읽는다. 모드가 바뀌어야 하는 앱은 창을 새로 만든다.
2. 창 스타일 비트(`WS_CAPTION`, `WS_THICKFRAME`)를 직접 지정하는 공개 옵션과 `titlebar`의 새 값 같은 별도 frameless
   모드를 제공하지 않는다. caption이 없는 창이 필요한 앱은 `titlebar: "custom"`을 쓴다. 이 모드는 기본으로 크기 조절
   테두리와 그림자를 유지하고, 앱이 `resizable: false`로 크기 조절 테두리를, `setHasShadow(false)`로 그림자를 끌 수 있다.
   두 설정을 모두 쓰면 caption과 크기 조절 테두리가 없는 창이 되며, 이 조합의 Snap 동작은 확인되지 않았다.
3. `titlebar`의 값 집합, `getTitlebar()` 계약, `titlebar: "custom"`의 현재 동작은 바꾸지 않는다.
4. 문서의 "완전히 테두리 없는 창은 아직 제공하지 않습니다"를 별도 frameless 모드가 없다는 문장과 대안 안내로 고친다.

## 근거

- 선례가 갈린다. Electron은 생성 시 고정이고 Tauri는 실행 중 변경이 있다. 갈릴 때는 코어를 작게 두는 쪽을 따르고,
  Electron과도 같다. 앱은 선언 시점의 `titlebar: "custom"`으로 caption 없는 화면을 얻고, 모드를 바꾸려면 창을 다시 만든다.
- 실행 중 전환은 이 저장소의 구현에서 다음 상태 조합을 새로 만든다. 모두 코드를 읽어 확인한 것이며 실행으로 재현하지는 않았다.
  - 모드가 `WS_CAPTION` 비트 하나로 정해진다. `getTitlebar`가 그 비트를 읽고, `setHasShadow(false)`와
    `setRoundedCorners(false)`는 `custom`일 때만 허용하며 `system`이면 그림자를 항상 켜진 것으로 본다(`win32.ts`의 그림자
    분기). 그림자를 끈 `custom` 창을 `system`으로 바꾸면 DWM 쪽 값은 꺼진 채인데 `hasShadow`는 `true`를 답한다. 둥근 모서리는
    `hasRoundedCorners`가 요청 값 집합만 읽으므로 `system`으로 바꾼 뒤에도 `false`를 유지하고, `system`에서 모서리를
    각지게 하는 요청을 거부하는 계약과 어긋난다. 전환 때마다 이 값들을 다시 맞추는 규칙을 계약에 넣어야 한다.
  - 전체화면 중에는 원래 스타일을 `fullscreen` 상태에 저장했다가 해제 때 복원한다. 전체화면 중 전환은 저장된 스타일을
    바꿔야 하고, `custom` 창의 전체화면 중 시스템 명령 차단(`SC_MOVE`, `SC_SIZE` 등)도 모드를 보고 정해진다.
  - 최대화나 스냅된 상태에서 `WS_CAPTION`을 바꾸면 비클라이언트 영역 크기가 달라질 것으로 추정되며(확인하지 않았다) 같은 위치와 크기를 유지하는 규칙, 크기
    제약을 모두 다시 맞춰야 한다. 최소 추적 크기가 `WS_CAPTION` 유무로 다르다는 구현 주석은 ReactOS와 Wine의 동작을 따른
    것이며 Windows에서 확인하지 않았다.
  - WebView의 CSS `app-region` 영역은 `custom`에서만 의미가 있어, 전환 시 문서에 남은 드래그 영역이 갑자기 효과를 잃거나
    얻을 것으로 추정한다(확인하지 않았다).
  이 조합을 Windows CI에서 확인하는 비용에 비해, 사용처가 확인되지 않았다.
- 별도 frameless 모드는 ADR 0037이 `WS_THICKFRAME`을 생성 옵션으로 제공하지 않기로 한 결정과 같은 이유로 제공하지 않는다.
  `resizable: false`이면서 `titlebar: "custom"`인 창이 이미 caption과 크기 조절 테두리가 모두 없는 창이므로 새 모드가
  주는 화면이 거의 없다. 남는 차이는 `WS_THICKFRAME`이 없는 창의 Snap 참여 여부와 최소화, 최대화 애니메이션 유무
  (ADR 0037 근거 절)이며, Snap은 TODO의 별도 항목으로 실측이 남아 있다. `setHasShadow`는 실행 중 호출이라 선언만으로는
  처음부터 그림자 없는 창을 만들 수 없다. 그 결과가 나오기 전에는 같은
  스타일 조합을 공개 계약으로 만들지 않는다. Electron은 `frame: false`로 이 조합을 제공하므로 이 결정은 Electron과 다르다.
  이유는 ADR 0037과 같다. 앱이 얻을 수 있는 화면이 이미 있고, 스타일 비트를 계약에 노출하면 Snap, 그림자, 둥근 모서리의
  상호작용을 계약으로 보장해야 한다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 사용자 타이틀바 절은 "생성 후 모드 변경을 지원하지 않는다"를 이미 적고 있으므로 frameless 문장만
  바꾸고 `titlebar: "custom"` 대안을 안내한다.
- `docs/TODO-windows.md`의 해당 항목은 결정 완료로 표시한다. 별도 frameless 모드를 다시 열 때의 조건은 212행의 Snap 실측
  결과다.
- 실행 중 전환이나 별도 frameless 모드가 필요해지면 별도 결정에서 다음을 먼저 정한다. 전환 때 그림자와 둥근 모서리 값의 재적용,
  전체화면과 최대화 중 전환 동작, 크기 제약과 콘텐츠 크기 보존, 각 조합을 확인할 Windows CI 테스트.

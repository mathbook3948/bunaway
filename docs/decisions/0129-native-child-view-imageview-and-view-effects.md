---
status: accepted
---

# 네이티브 자식 view, ImageView와 view 단위 둥근 모서리와 background blur는 제공하지 않는다

결정일: 2026-10-27. 검토 기준: 이 결정을 올린 시점의 main.

## 배경

창 안에 WebView 말고 네이티브 자식 요소를 두는 능력군을 Windows 앱에 제공할지 정해야 했다. 대상은 view tree(배치, 순서, bounds, clipping, visibility),
네이티브 ImageView, view 단위 둥근 모서리와 background blur다.

- Electron은 `View`, `WebContentsView`, `ImageView`로 view tree를 구성하는 API를 제공한다. view마다 bounds, 자식 순서, visibility, border radius와 background material을 정한다. Tauri 2는 한 창에 여러 webview를 두는 기능을 unstable로 두고, 네이티브 ImageView나 view 단위 blur에 해당하는 API는 없다. 두 동작은 공개 문서를 읽고 정리한 것이며 이 저장소의 테스트로 실행해 확인하지 않았다. 두 선례가 갈린다.
- 이 저장소는 앱 하나에 창 하나, 창 하나에 WebView 하나다(ADR 0026). WebView는 창 내용 영역 전체를 채우고, `native/windows/bun/ui.ts`의 `WM_SIZE` 처리가 `WebView.resize()`로 그 크기를 맞춘다(ADR 0090). 따라서 자식 view를 배치하고 쌓을 대상이 없다. 한 창에 WebView를 여러 개 두는 구성은 ADR 0026이 기각했고, 추가 WebView의 재제안 조건도 그 ADR에 있다.
- 창 단위 기능은 이미 있다. 창 둥근 모서리는 `windows.setRoundedCorners`가 DWM 창 프레임에 적용하고(ADR 0037), 배경 재질은 `windows.setBackgroundMaterial`이 `auto`, `none`, `mica`, `acrylic`, `tabbed` 중 하나를 창 프레임 뒤에 요청한다(`DWMWA_SYSTEMBACKDROP_TYPE`, Windows 11 22H2 이상에서만 적용). 둘 다 창 프레임에 대한 DWM 힌트이고 창 안의 개별 요소를 대상으로 하지 않는다.
- 시각 요소는 UI 문서가 그린다. 이미지는 `<img>`, 둥근 모서리는 CSS `border-radius`와 `overflow: hidden`, 흐림은 CSS `backdrop-filter`로 표현할 수 있다.

## 결정

1. view tree와 네이티브 자식 view(배치, 순서, bounds, clipping, visibility)는 제공하지 않는다. 창 안의 내용은 하나의 WebView 문서가 구성한다.
2. 네이티브 ImageView는 제공하지 않는다. 앱은 이미지를 문서의 `<img>`나 CSS로 표시한다. 이 결정은 이미지 데이터를 만드는 기능(예: 파일 형식 아이콘을 만드는 image 플러그인)과 무관하며, 그 기능들의 범위는 각 플러그인 문서가 정한다.
3. view 단위 border radius와 background blur는 제공하지 않는다. 창 단위 둥근 모서리(ADR 0037)와 창 배경 재질(`setBackgroundMaterial`)은 그대로 유지하며 이 결정의 대상이 아니다. 두 기능은 창 프레임에만 적용되고 WebView 안의 요소에는 영향을 주지 않는다.
4. 계약, 스키마, 권한, 이벤트와 네이티브 코드는 바꾸지 않는다. 호스트와 코어에 변경은 없다.
5. 재검토 조건: ADR 0026의 재제안 조건을 충족해 추가 WebView나 다중 창이 도입되고, 그 앱 사례에서 문서 안에서 그릴 수 없는 네이티브 요소(예: 문서 아래에 놓는 네이티브 미리보기 표면)가 확인되면 그 결정에서 view 계층의 필요를 다시 정한다. view 단위 효과는 그 계층이 생긴 뒤에만 의미가 있다.

## 근거

- view tree는 단일 WebView 모델에서 대상이 없는 기능이다. 이를 위해 자식 HWND의 수명, 입력 라우팅, DPI와 z 순서 정책을 코어 계약에 넣으면 ADR 0026이 줄인 계약과 검증 범위를 다시 키운다. 코어는 작게 둔다는 방침과 맞지 않는다.
- Electron과 Tauri의 선례가 갈리고(전자는 제공, 후자는 unstable 또는 없음), 쓰는 곳이 이 저장소에서 확인되지 않았다. 이 경우 코어를 작게 두는 쪽을 따른다.
- 이미지, 둥근 모서리와 흐림은 WebView 문서가 이미 표현할 수 있어, 네이티브 view를 추가하면 같은 결과를 두 경로로 만들게 된다.
- WebView 위에 겹치는 네이티브 요소는 WebView2 컨트롤러와 같은 영역에서 합성과 입력 우선순위 문제를 만들 수 있다. 이 저장소에서 확인한 사실은 아니며, 이를 검증할 앱 사례도 지금은 없다.

## 결과

- 스키마, 이벤트, 권한과 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 view tree와 ImageView, border radius, background blur 항목을 완료로 표시하고 이 결정을 참조한다.

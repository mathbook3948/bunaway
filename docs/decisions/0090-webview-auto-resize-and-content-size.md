---
status: accepted
---

# WebView auto-resize 옵션과 콘텐츠 크기에 맞춘 창 크기 자동 조절을 제공하지 않는다

결정일: 2026-10-26. 검토 기준: main `01de66d6`.

## 배경

창 크기가 바뀔 때 WebView 크기를 따로 맞추는 옵션(auto-resize)과, 문서 콘텐츠의 크기에 맞춰 창 크기를 정하는 기능을 제공할지 정해야 했다.

- 창 하나에 WebView 하나이고(ADR 0026) WebView는 창 내용 영역 전체를 차지한다. `native/windows/bun/ui.ts`는 `WM_SIZE`마다 `WebView.resize()`를 호출하고,
  이 함수는 `GetClientRect`로 읽은 내용 영역 전체를 컨트롤러의 `put_Bounds`로 적용한다(`native/windows/bun/webview.ts`).
  최대화, 복원, 전체화면 진입과 해제, DPI 변경, 앱이 부른 `setSize`(전체화면 중에는 `INVALID_ARGUMENT`로 거부)와 사용자 크기 조절에서 바뀐 크기는 같은 경로를 지난다.
- 한 창에 WebView를 여러 개 두는 구성은 ADR 0026이 기각했고 다시 여는 조건도 정해 두었다. 따라서 WebView에 따로 bounds를 줄 일이 없고 창과 WebView 크기가 어긋날 수 있는 구성이 없다.
- 콘텐츠 크기 기준의 배치는 이미 제공한다. 초기 크기는 기본으로 내용 영역 크기이고(`useContentSize`, ADR 0019), `setSize`는 내용 영역 크기를 받으며,
  `getContentSize`, `getContentBounds`, `setContentBounds`, `setContentPosition`이 내용 영역 기준 조회와 설정을 제공한다. 최소와 최대 크기도 내용 영역 기준이다.
- 문서 콘텐츠 크기의 변화를 호스트가 통지하는 preferred-size 이벤트는 제공하지 않기로 했다(ADR 0039). 앱은 `ResizeObserver`로 관찰해 IPC로 보낼 수 있다.

## 결정

1. WebView auto-resize 옵션은 추가하지 않는다. WebView는 항상 창 내용 영역을 채운다.
2. 문서 콘텐츠 크기에 맞춰 창 크기를 자동으로 바꾸는 옵션이나 이벤트는 추가하지 않는다. 필요한 앱은 페이지에서 `ResizeObserver`로 크기를 얻어
   백엔드로 보내고 `setSize`(내용 영역, 96 DPI 논리 픽셀)로 적용한다. 최소와 최대 크기 제약은 그대로 적용된다.
3. 콘텐츠 크기 기준 배치는 기존 `useContentSize`와 내용 영역 기준 geometry API로 충족한다.
4. 여러 WebView가 필요해지면 ADR 0026을 다시 열고 그때 bounds와 auto-resize를 함께 정한다.

## 근거

- 단일 WebView에서는 auto-resize가 켜진 상태만 올바르다. 꺼진 상태는 내용 영역에 빈 공간이나 잘린 문서를 만들 뿐이다.
- 문서 크기에 맞춘 자동 창 조절은 어느 요소의 크기를 기준으로 할지, 사용자가 조절한 크기와 어떻게 겹칠지, 조절 중 깜박임을 어떻게 막을지에 대한 정책이 필요하고
  쓰는 곳이 확인되지 않았다. 코어 계약을 늘리지 않고 앱과 페이지가 이미 있는 API로 처리할 수 있다.

## 결과

- 스키마, 이벤트, 권한과 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

---
status: accepted
---

# WebView 페이지 find API를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `ee1d2a1d`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

앱 백엔드가 WebView 안의 텍스트를 검색하고, 일치 개수와 활성 위치를 이벤트로 받고, 검색을 끝내는 API를 제공할지 정해야 했다.

- Electron의 `webContents`는 `findInPage(text, options)`와 `stopFindInPage(action)`을 제공하고, 결과는 `found-in-page`
  이벤트(`matches`, `activeMatchOrdinal`, `finalUpdate`)로 돌려준다.
- Tauri 2의 `Webview`와 `Window`에는 페이지 find API가 없다.
- 이 저장소의 Windows 호스트는 일반 빌드에서 `AreBrowserAcceleratorKeysEnabled`를 끈다(`native/windows/bun/README.md`).
  그래서 WebView2의 기본 Ctrl+F 찾기 창은 뜨지 않고, 검색 UI는 앱이 만든다.
- 페이지 안에서는 DOM을 직접 탐색해 텍스트를 찾고 `Range`와 `Selection`, CSS Custom Highlight API로 일치 위치를
  표시하고 `scrollIntoView`로 이동할 수 있다. 검색 UI를 앱이 그리므로 입력 상자와 이전/다음 단추도 렌더러에 있다.
- 편집 명령과 selection 제어를 제공하지 않기로 한 결정([ADR 0050](./0050-webview-edit-commands-and-selection.md))은
  페이지 소유의 selection 상태를 호스트가 바꾸지 않는다는 같은 방침이다. 호스트 find는 selection과 스크롤을 페이지가
  모르게 바꾸는 경로가 된다.

## 결정

1. 페이지 find 시작, 다음/이전 이동, 종료 API와 결과 이벤트를 추가하지 않는다.
2. 앱은 렌더러에서 DOM 탐색과 `Selection`, CSS Custom Highlight API로 검색을 구현한다. 백엔드가 시작해야 하면
   앱 명령으로 렌더러에 요청을 보낸다.
3. 브라우저 기본 Ctrl+F 찾기 창은 켜지 않는다. 가속키는 개발 빌드에서만 켜는 현재 방침을 유지한다.
4. 렌더러 구현으로 만들 수 없는 용도(예: cross-origin 중첩 프레임 안의 검색)가 확인되면 별도 결정에서 다룬다.

## 근거

- 두 프레임워크가 다르다. Electron은 제공하고 Tauri는 제공하지 않는다. 검색 UI를 앱이 만드는 구조이므로 같은 일을
  렌더러의 웹 표준 API로 할 수 있고, 이 저장소에서 쓰는 곳이 없는 기능을 위해 코어 API와 이벤트 계약을 늘리지 않는다.
- 호스트 find는 결과 이벤트가 `finalUpdate` 같은 비동기 상태를 가져 검색어 변경, 탐색, 창 닫기와의 경합 규칙이 필요하다.
  렌더러 구현은 문서 수명과 함께 끝나 정리 규칙이 따로 필요 없다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

---
status: accepted
---

# WebView caret browsing, selection 가운데 표시, image-at-point 복사를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `42fdd220`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.
확인한 버전은 Electron v45.0.0, Tauri 2.12.5, wry 0.57.1, WebView2 SDK 1.0.4314.35이다.

백엔드가 WebView의 caret browsing(문서 안에서 방향키로 커서를 옮겨 텍스트를 고르는 접근성 모드)을 켜고 끄는 API, 현재 selection을 보이는
영역의 가운데로 스크롤하는 API, 화면 좌표의 이미지를 클립보드에 복사하는 API를 제공할지 정해야 했다.

- Electron의 `webContents`는 세 기능을 모두 제공한다. 좌표의 이미지를 클립보드에 복사하는 `copyImageAt(x, y)`, selection을 가운데로 옮기는
  `centerSelection()`, caret browsing을 켜고 조회하는 `setCaretBrowsingEnabled()`, `isCaretBrowsingEnabled()`와 `caretBrowsingEnabled`
  속성(v43.6.0, v44.0.0, v45.0.0에 포함)이다. F7 단축키는 Electron이 추가하지 않고 앱이 구성한다.
- Tauri 2와 wry의 `Webview`, `WebviewWindow`, `Window`, `WebView`에는 세 기능에 해당하는 공개 API가 없다. 페이지가 `Selection` API,
  `Element.scrollIntoView`, `navigator.clipboard.write`를 쓰거나 `with_webview`로 플랫폼 객체를 직접 다룬다.
- WebView2의 `ICoreWebView2Settings`부터 `Settings9`, `ICoreWebView2Controller`부터 `Controller4`에는 caret browsing 설정, 좌표 이미지 복사,
  selection 스크롤 API가 없다. caret browsing은 F7 브라우저 단축키로만 존재하고 `AreBrowserAcceleratorKeysEnabled`를 끄면 함께 꺼진다.
  이미지 복사는 기본 컨텍스트 메뉴의 `copyImage` 항목으로만 존재하며 호스트가 좌표로 실행하는 API는 아니다. 구현하려면 DevTools 프로토콜로
  좌표의 노드를 찾아 이미지 바이트를 읽고 클립보드 형식으로 직접 변환해야 한다.
- 이 저장소의 Windows 호스트는 `AreBrowserAcceleratorKeysEnabled`를 개발 도구가 켜진 빌드에서만 켜고 일반 빌드에서는 끈다
  (`native/windows/bun/webview.ts`, `native/windows/bun/README.md`). 따라서 일반 빌드에서는 F7 caret browsing도 꺼져 있다고 보는 것이 문서 기준의 추론이다.
- 이 저장소의 메뉴 role은 `copy`와 `selectAll`을 제공하고, selection 변경과 스크롤 API는 제공하지 않기로 했다([ADR 0050](./0050-webview-edit-commands-and-selection.md)).
- 백엔드가 호출하는 이미지 복사는 사용자 활성화 없이 클립보드를 쓰는 경로가 된다. 사용자가 시작하는 복사는 컨텍스트 메뉴의 `copy` role이 이미 담당한다.

## 결정

1. caret browsing 활성화 API를 추가하지 않는다. 일반 빌드에서 WebView2의 F7 caret browsing은 꺼져 있고, 앱이 필요하면 페이지 안에서
   직접 구현한다.
2. selection 가운데 표시 API를 추가하지 않는다. 앱은 렌더러에서 `Selection`과 `scrollIntoView`를 쓰고, 백엔드가 시작해야 하면 앱 명령으로
   렌더러에 요청을 보낸다.
3. 좌표 기반 이미지 복사 API를 추가하지 않는다. 앱은 렌더러에서 `navigator.clipboard.write`를 쓰거나 이미지 데이터를 백엔드로 보내
   클립보드 플러그인으로 쓴다.
4. 위 방법으로 만들 수 없는 용도가 확인되면 별도 결정에서 다룬다. caret browsing은 WebView2에 호스트 설정이 없어, 브라우저 단축키를 켜는
   방식의 부작용(다른 브라우저 가속키도 함께 켜짐)과 프로세스 전역 인자 방식의 한계를 먼저 정한다. 이미지 복사는 호스트가 사용자 제스처나
   클립보드 권한을 대신하지 않는 형태로만 검토한다.

## 근거

- Electron은 세 기능을 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는 쪽을 따른다. 이 저장소에서
  쓰는 곳이 없고, selection 가운데 표시와 이미지 복사는 렌더러의 웹 표준 API로 같은 일을 할 수 있다.
- caret browsing은 WebView2에 호스트 설정이 없고 F7이 브라우저 가속키 전체와 묶여 있다. 켜려면 개발 도구용 가속키까지 열거나 환경 전역
  인자에 의존해야 해서 공식 지원 범위 밖이다.
- 이미지 복사는 WebView2에 호스트 API가 없어 DevTools 경로와 형식 변환을 새로 유지해야 하고, 사용자 활성화 없이 클립보드를 쓰는 경계를 만든다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

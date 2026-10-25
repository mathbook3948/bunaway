---
status: accepted
---

# WebView caret browsing, selection 가운데 표시, image-at-point 복사를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `42fdd220`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

백엔드가 WebView의 caret browsing(문서 안에서 방향키로 커서를 옮겨 텍스트를 고르는 접근성 모드)을 켜고 끄는 API, 현재 selection을 보이는
영역의 가운데로 스크롤하는 API, 화면 좌표의 이미지를 클립보드에 복사하는 API를 제공할지 정해야 했다.

- Electron의 `webContents`는 좌표의 이미지를 클립보드에 복사하는 `copyImageAt(x, y)`와 selection을 가운데로 옮기는 `centerSelection()`을
  제공한다. caret browsing을 켜는 공개 API는 찾지 못했다.
- Tauri 2의 `Webview`와 `Window`에는 세 기능에 해당하는 API가 없다. 페이지가 `Selection` API, `Element.scrollIntoView`,
  `navigator.clipboard.write`를 쓴다.
- WebView2의 `CoreWebView2Settings`에는 caret browsing 설정이 없다. 이미지 복사와 selection 스크롤에 해당하는 호스트 API도 없어서, 구현하려면
  DevTools 프로토콜로 좌표의 요소를 찾아 이미지를 읽고 클립보드 형식으로 변환해야 한다.
- 이 저장소의 메뉴 role은 `copy`와 `selectAll`을 제공하고, selection 변경과 스크롤 API는 제공하지 않기로 했다([ADR 0050](./0050-webview-edit-commands-and-selection.md)).
- 백엔드가 호출하는 이미지 복사는 사용자 활성화 없이 클립보드를 쓰는 경로가 된다. 사용자가 시작하는 복사는 컨텍스트 메뉴의 `copy` role이 이미 담당한다.

## 결정

1. caret browsing 활성화 API를 추가하지 않는다. 사용자는 WebView2 런타임이 제공하는 키 조작과 보조 기술을 그대로 쓴다.
2. selection 가운데 표시 API를 추가하지 않는다. 앱은 렌더러에서 `Selection`과 `scrollIntoView`를 쓰고, 백엔드가 시작해야 하면 앱 명령으로
   렌더러에 요청을 보낸다.
3. 좌표 기반 이미지 복사 API를 추가하지 않는다. 앱은 렌더러에서 `navigator.clipboard.write`를 쓰거나 이미지 데이터를 백엔드로 보내
   클립보드 플러그인으로 쓴다.
4. 위 방법으로 만들 수 없는 용도가 확인되면 별도 결정에서 다룬다. 이때 호스트가 사용자 제스처나 클립보드 권한을 대신하지 않는 형태로만 검토한다.

## 근거

- Electron은 이미지 복사와 selection 가운데 표시를 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는 쪽을
  따른다. 이 저장소에서 쓰는 곳이 없고, 같은 일을 렌더러의 웹 표준 API로 할 수 있다.
- caret browsing은 Electron도 API로 제공하지 않고 WebView2에도 설정이 없어 따를 선례와 구현 수단이 모두 없다.
- 이미지 복사는 WebView2에 호스트 API가 없어 DevTools 경로와 형식 변환을 새로 유지해야 하고, 사용자 활성화 없이 클립보드를 쓰는 경계를 만든다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

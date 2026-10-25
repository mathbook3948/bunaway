---
status: accepted
---

# WebView media 시작과 중단, theme-color, 링크 hover URL 이벤트를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `e43c2d59`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

WebView의 media 시작과 중단, HTML `theme-color` 변경, 링크 위에 포인터가 놓였을 때의 대상 URL을 앱에 알리는 이벤트를 제공할지 정해야 했다.

- Electron의 `webContents`는 `media-started-playing`, `media-paused`, `did-change-theme-color`, `update-target-url` 이벤트를 메인
  프로세스에서 제공한다. `update-target-url`은 포인터가 링크 위에 있을 때 대상 URL을 알린다.
- Tauri 2는 이 세 가지에 해당하는 공개 이벤트를 제공하지 않는다.
- WebView2는 `IsDocumentPlayingAudioChanged`(`ICoreWebView2_8`)와 `StatusBarTextChanged`(`ICoreWebView2_12`)를 제공한다.
  `IsDocumentPlayingAudioChanged`는 문서의 audio 출력 여부이며 `<video>` 등 media 요소의 재생 시작과 중단을 직접 알리지 않는다.
  `theme-color`에 대응하는 이벤트나 속성은 없다.
- 이 저장소의 Windows 호스트는 `getWebViewAudioState`로 음소거와 문서의 audio 재생 상태를 조회한다. 그 상태의 변경 이벤트는 별도 TODO
  항목이다. 페이지 제목은 `windows.documentTitleChanged`로 전달한다.
- WebView에 로드되는 문서는 앱이 `origins`로 허용한 출처의 페이지이며 앱이 작성한다. 이 페이지는 `<meta name="theme-color">`,
  `<video>`와 `<audio>`의 `play`와 `pause` 이벤트, 링크의 `pointerover`와 `focus` 이벤트를 직접 관찰할 수 있고, 값을 앱 명령으로 백엔드에 보낼 수 있다.

## 결정

1. media 시작과 중단, `theme-color` 변경, 링크 hover URL을 알리는 새 이벤트, 작업과 권한을 추가하지 않는다.
2. 앱 UI가 이 값을 필요로 하면 페이지에서 직접 관찰한다(`meta[name=theme-color]`의 `MutationObserver`, media 요소의 `play`와 `pause`,
   링크의 `pointerover`). 백엔드가 필요로 하면 UI가 앱 명령으로 보낸다.
3. 문서의 audio 재생 상태는 기존 `getWebViewAudioState`로 조회한다. 그 변경 이벤트는 별도 항목에서 다루며 이 결정에 포함하지 않는다.
4. 허용되지 않은 출처의 페이지가 쓰는 값이나, 페이지에서 알 수 없는 media 상태를 확인해야 하는 용도가 나오면 별도 결정에서 다룬다.

## 근거

- Electron은 제공하고 Tauri는 제공하지 않는다. 쓰는 곳이 확인되지 않았고, 값이 앱이 작성한 페이지 안에서 이미 관찰 가능하므로 코어 계약을
  작게 유지한다.
- WebView2에는 `theme-color`에 대응하는 이벤트가 없어 제공하려면 호스트가 문서에 스크립트를 삽입해 관찰해야 한다. media 요소 단위의 시작과
  중단도 같은 방식이 필요하다. 문서 초기화 스크립트는 별도 항목에서 범위를 정한다.
- 링크 hover URL은 WebView2 상태 표시줄 텍스트로 얻을 수 있으나 페이지 UI가 `pointerover`로 같은 정보를 얻는다. 이벤트는 포인터 이동마다
  발생해 큐 한도와 합치기 규칙이 필요하다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

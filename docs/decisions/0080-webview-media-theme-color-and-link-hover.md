---
status: accepted
---

# WebView media 시작과 중단, theme-color, 링크 hover URL 이벤트를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `e43c2d59`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

WebView의 media 시작과 중단, HTML `theme-color` 변경, 링크 위에 포인터가 놓였을 때의 대상 URL을 앱에 알리는 이벤트를 제공할지 정해야 했다.

- Electron의 `webContents`는 `media-started-playing`, `media-paused`, `did-change-theme-color`, `update-target-url` 이벤트를
  메인 프로세스에서 제공한다. `update-target-url`은 마우스가 링크 위로 이동하거나 키보드 포커스가 링크로 옮겨질 때 대상 URL을 알린다.
- Tauri 2와 wry의 공개 이벤트와 핸들러에는 이 세 가지에 해당하는 것이 없다(Tauri 2.12, wry 0.57 소스 기준).
  Tauri의 `ThemeChanged`는 창의 시스템 테마 변경이며 페이지의 `theme-color`와 무관하다.
  Windows에서는 WebView2 객체에 접근해 직접 등록할 수 있다.
- WebView2의 `IsDocumentPlayingAudioChanged`(`ICoreWebView2_8`)는 해당 WebView의 audio 출력 재생 여부(음소거 상태에서도 true)가
  바뀔 때 발생한다. `<video>` 등 media 요소의 재생 시작과 중단을 알리지는 않는다.
  `theme-color`에 대응하는 호스트 이벤트나 속성은 없다(WebView2 SDK 1.0.4314 기준).
- 링크 hover URL은 WebView2에서 `StatusBarTextChanged`(`ICoreWebView2_12`)와 `StatusBarText`로 간접적으로만 얻을 수 있다.
  이 이벤트는 상태 메시지, URL 또는 상태 표시줄을 숨기라는 빈 문자열에 대해 발생하므로 텍스트가 항상 URL이라는 보장이 없다.
  키보드 포커스에서도 발생하는지, 상태 표시줄 설정(`IsStatusBarEnabled`)을 끈 경우에도 발생하는지는 확인하지 못했다.
- 이 저장소의 Windows 호스트는 `getWebViewAudioState`로 음소거와 문서의 audio 재생 상태를 조회한다. 그 상태의 변경 이벤트는 별도 TODO
  항목이다. 페이지 제목은 `windows.documentTitleChanged`로 전달한다.
- 앱이 작성하고 제어하는 페이지는 `<meta name="theme-color">`,
  `<video>`와 `<audio>`의 `play`와 `pause` 이벤트, 링크의 `pointerover`와 `focus` 이벤트를 직접 관찰할 수 있고, 값을 앱 명령으로 백엔드에 보낼 수 있다.

## 결정

1. media 시작과 중단, `theme-color` 변경, 링크 hover URL을 알리는 새 이벤트, 작업과 권한을 추가하지 않는다.
2. 앱 UI가 이 값을 필요로 하면 페이지에서 직접 관찰한다(`meta[name=theme-color]`의 `MutationObserver`, media 요소의 `play`와 `pause`,
   링크의 `pointerover`와 `focus`). 백엔드가 필요로 하면 UI가 앱 명령으로 보낸다.
3. 문서의 audio 재생 상태는 기존 `getWebViewAudioState`로 조회한다. 그 변경 이벤트는 별도 항목에서 다루며 이 결정에 포함하지 않는다.
4. `origins`에 넣은 외부 출처처럼 앱이 제어하지 않는 페이지의 값이나, 페이지에서 알 수 없는 media 상태를 확인해야 하는 용도가 나오면 별도 결정에서 다룬다.

## 근거

- Electron은 제공하고 Tauri는 제공하지 않는다. 쓰는 곳이 확인되지 않았고, 값이 앱이 작성한 페이지 안에서 이미 관찰 가능하므로 코어 계약을
  작게 유지한다.
- WebView2에는 `theme-color`에 대응하는 이벤트가 없어 제공하려면 호스트가 문서에 스크립트를 삽입해 관찰해야 한다. media 요소 단위의 시작과
  중단도 같은 방식이 필요하다. 문서에 스크립트를 삽입하는 기능은 이 결정과 별개로 TODO의 문서 초기화 script 항목에서 다룬다.
- 링크 hover URL은 페이지 UI가 `pointerover`와 `focus`로 얻을 수 있다. WebView2의 상태 표시줄 텍스트는 URL과 상태 메시지를 구분하지 않는
  간접 경로이고 동작 조건이 확인되지 않았으므로, 호스트가 전달하려면 별도 이벤트와 권한을 계약에 추가하고 그 조건을 먼저 확인해야 한다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

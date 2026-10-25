---
status: accepted
---

# WebView 로드 시작, DOM ready, 완료, 실패 이벤트를 새로 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `94fa3d36`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

WebView 문서의 로드 시작, DOM ready, 완료, 실패를 앱에 알리는 이벤트를 따로 제공할지 정해야 했다.

- Electron의 `webContents`는 `did-start-loading`, `dom-ready`, `did-finish-load`, `did-fail-load`, `did-stop-loading`
  이벤트를 메인 프로세스에서 제공한다.
- Tauri 2는 창 빌더의 `on_page_load` 콜백 하나로 `Started`와 `Finished` 두 단계를 알리며, DOM ready와 실패를 구분하지
  않는다.
- WebView2는 `NavigationStarting`, `NavigationCompleted`(성공 여부와 `WebErrorStatus` 포함), `DOMContentLoaded`
  (`ICoreWebView2_2`)를 제공한다.
- 이 저장소의 Windows 호스트는 이미 허용된 최상위 문서의 `NavigationStarting`과 `NavigationCompleted`를 쓴다.
  - `windows.getWebViewState`의 `loading`은 탐색 시작부터 해당 탐색 완료까지다.
  - `windows.readiness`와 `windows.getReadiness`의 `document`는 `pending`, `ready`, `failed`, `cancelled`로
    탐색마다 `documentGeneration`과 함께 바뀌고 오류를 `error`로 전달한다. 같은 문서의 fragment 이동은 세대를
    바꾸지 않는다.
- 이 저장소의 이벤트는 WebView(UI)로 전달된다. 새 문서의 스크립트는 로드가 시작된 뒤에 실행되어 구독하므로, 그 문서의
  "로드 시작"은 UI 이벤트로 받을 수 없다. 스크립트 실행 이후 단계는 페이지의 `DOMContentLoaded`와 `load`
  이벤트가 같은 정보를 준다. 허용된 출처 밖으로의 탐색은 호스트가 막으므로 외부 페이지의 로드 실패를 UI가 겪는 경우도
  없다.

## 결정

1. 로드 시작, DOM ready, 완료, 실패를 알리는 새 이벤트와 작업을 추가하지 않는다.
2. 탐색의 진행과 결과는 기존 계약으로 확인한다. 백엔드는 `windows.getReadiness`의 `document`와 `error`,
   `windows.getWebViewState`의 `loading`을 쓰고, 이벤트가 필요하면 `windows.readiness`를 구독한다. 페이지는
   `DOMContentLoaded`와 `load`를 쓴다.
3. 이 결정은 Windows 호스트 기준이다. macOS 호스트는 이 결정에서 다루지 않는다.
4. 프레임 단위 로드 단계나 로드 중단 원인의 구분처럼 기존 계약으로 얻을 수 없는 용도가 확인되면 별도 결정에서
   다룬다. 문서, 프레임과 same-document 탐색 이벤트는 같은 근거로 따로 다룬다.

## 근거

- 두 프레임워크가 다르다. Electron은 네 단계를 제공하고 Tauri는 시작과 완료만 제공한다. 이 저장소는 완료와 실패, 취소를
  `windows.readiness`로 이미 전달하므로 같은 정보를 담은 이벤트가 둘이 되면 순서와 세대 규칙을 두 곳에서 지켜야 한다.
  코어 계약은 작게 유지한다.
- UI로 가는 이벤트는 새 문서가 구독하기 전의 시작 단계를 전달할 수 없고, DOM ready 이후는 페이지의 표준 이벤트로 얻는다.
  이 저장소에서 쓰는 곳이 없는 이벤트를 위해 정렬, 합치기와 큐 한도 규칙을 만들지 않는다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

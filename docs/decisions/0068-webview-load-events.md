---
status: accepted
---

# WebView 로드 시작, DOM ready, 완료, 실패 이벤트를 새로 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `42fdd220`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

WebView 문서의 로드 시작, DOM ready, 완료, 실패를 앱에 알리는 이벤트를 따로 제공할지 정해야 했다.

- Electron의 `webContents`는 `did-start-loading`, `dom-ready`, `did-finish-load`, `did-fail-load`, `did-stop-loading`
  다섯 이벤트를 포함한 로드 관련 이벤트를 메인 프로세스에서 제공한다. `did-stop-loading`은 성공, 실패와 중단을 가리지 않고 로딩이 멈출 때 오며,
  이 저장소에서는 `loading`이 false가 되는 시점과 `cancelled` 상태가 이에 해당한다.
- Tauri 2는 창 빌더의 `on_page_load` 콜백 하나로 `Started`와 `Finished` 두 단계를 알리며, DOM ready와 실패를 구분하지
  않는다.
- WebView2는 `NavigationStarting`, `NavigationCompleted`(성공 여부와 `WebErrorStatus` 포함), `DOMContentLoaded`
  (`ICoreWebView2_2`)를 제공한다.
- 이 저장소의 Windows 호스트는 이미 허용된 최상위 문서의 `NavigationStarting`과 `NavigationCompleted`를 쓴다.
  - `windows.getWebViewState`의 `loading`은 탐색 시작부터 해당 탐색 완료까지다.
  - `windows.readiness`와 `windows.getReadiness`의 `document`는 `pending`, `ready`, `failed`, `cancelled` 중 하나이고,
    `failed`의 원인은 `error`로 전달한다. 탐색 실패뿐 아니라 완료 기한 초과(`TIMEOUT`)도 `failed`가 되며, 이때
    `loading`은 `NavigationCompleted`가 올 때까지 true로 남을 수 있다.
  - 허용된 새 최상위 탐색은 `document`를 `pending`으로 되돌리고 `documentGeneration`을 올린다.
  - `ready`는 `NavigationCompleted` 성공이다. 호스트는 `DOMContentLoaded`를 구독하지 않는다.
- 이 저장소의 이벤트는 WebView(UI)로 전달된다. 새 문서의 스크립트는 로드가 시작된 뒤에 실행되어 구독하므로, 그 문서의
  "로드 시작"은 UI 이벤트로 받을 수 없다. 스크립트 실행 이후 단계는 페이지의 `DOMContentLoaded`와 `load`
  이벤트로 UI가 알 수 있다. 문서가 커밋되기 전에 실패하면(허용된 출처의 네트워크 오류 등) 그 문서는
  스크립트가 실행되지 않아 실패를 관찰할 수 없고, 백엔드는 `getReadiness`로 확인한다.

## 결정

1. 로드 시작, DOM ready, 완료, 실패를 알리는 새 이벤트와 작업을 추가하지 않는다.
2. 탐색의 진행과 결과는 기존 계약으로 확인한다. 백엔드는 `windows.getReadiness`의 `document`와 `error`,
   `windows.getWebViewState`의 `loading`을 조회한다(`error.code`로 `TIMEOUT`과 탐색 실패를 구분한다). 이벤트가 필요한
   UI는 `windows.readiness`를 구독하고, 페이지는 `DOMContentLoaded`와 `load`를 쓴다. DOM ready와 load 완료의 구분은 UI에서만 가능하고 백엔드는 `ready`(탐색 완료)만
   본다. 백엔드가 이 구분을 필요로 하면 UI가 페이지 이벤트를 앱 명령으로 백엔드에 보낸다.
3. 새 이벤트를 추가하지 않는 결정은 Windows와 macOS 호스트에 같이 적용한다. 로드 단계 구분이 두 호스트에서 동등하다는
   판단은 Windows만 다루며, macOS의 문서 완료와 `loading`은 `windows.mdx`에 적힌 기존 계약을 따른다.
4. 프레임 단위 로드 단계나 로드 중단 원인의 구분처럼 기존 계약으로 얻을 수 없는 용도가 확인되면 별도 결정에서
   다룬다. 문서, 프레임과 same-document 탐색 이벤트는 같은 근거로 따로 다룬다.

## 근거

- 두 프레임워크가 다르다. Electron은 로드 단계별 이벤트를 제공하고 Tauri는 시작과 완료만 제공한다. 이 저장소는 완료와 실패, 취소를
  `windows.readiness`로 이미 전달하므로 같은 정보를 담은 이벤트가 둘이 되면 순서와 세대 규칙을 두 곳에서 지켜야 한다.
  코어 계약은 작게 유지한다.
- UI로 가는 이벤트는 새 문서가 구독하기 전의 시작 단계를 전달할 수 없고, DOM ready 이후는 페이지의 표준 이벤트로 얻는다.
  `plugins`, `packages`, `examples`, `native`에서 `windows.readiness`, `getReadiness`, `DOMContentLoaded`를 검색했을 때
  계약과 호스트 구현(`plugins/windows/src`, `packages/plugin-api/src/native.ts`, `native`) 밖의 소비처는 없었고,
  `DOMContentLoaded`를 쓰는 코드는 없었다.
  이 저장소에서 쓰는 곳이 없는 이벤트를 위해 정렬, 합치기와 큐 한도 규칙을 만들지 않는다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

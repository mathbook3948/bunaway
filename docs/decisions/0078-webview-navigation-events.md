---
status: accepted
---

# WebView 문서, 프레임, same-document 탐색 이벤트를 새로 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `e43c2d59`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

문서 탐색, 프레임 탐색과 same-document 탐색(해시 변경, `history.pushState`, `history.replaceState`)을 앱에 알리는
이벤트를 따로 제공할지 정해야 했다.

- Electron 45의 `webContents`는 `did-navigate`(최상위 프레임만), `did-navigate-in-page`(same-document, 하위 프레임 포함),
  `did-frame-navigate`(하위 프레임 포함), `did-redirect-navigation`(하위 프레임 포함)을 제공하고, 탐색 전에는
  `will-navigate`, `will-frame-navigate`(하위 프레임 포함, same-document 탐색에는 발생하지 않음)로 취소할 수 있다.
  `did-navigate`와 `did-frame-navigate`는 same-document 탐색에는 발생하지 않는다.
- Tauri 2(2.12 기준)와 wry가 공개하는 탐색 관련 콜백은 탐색 전 허용 여부를 정하는 `on_navigation`과 페이지 로드의
  시작과 완료를 알리는 `on_page_load` 둘뿐이다. 탐색 완료, 프레임 단위, same-document, 리디렉션 전용 이벤트와 콜백
  인자의 프레임 정보는 없다.
- WebView2는 `NavigationStarting`, `NavigationCompleted`, `FrameNavigationStarting`, `FrameNavigationCompleted`,
  `SourceChanged`(`IsNewDocument`로 same-document를 구분), `HistoryChanged`, `ContentLoading`을 제공한다.
- 이 저장소의 Windows 호스트는 이미 아래 범위를 다룬다.
  - 최상위 `NavigationStarting`: 허용 origin이 아니면 취소하고, 허용되면 `loading`을 올리고 새 탐색 id마다 이전 문서의
    세션과 보류 중인 다운로드를 폐기한다. 이 폐기가 문서 단위 세대(`documentGeneration`)를 올린다. `windows.mdx`는 같은 문서의
    fragment 이동이 세션과 세대를 유지한다고 적는다. WebView2가 fragment 이동에 새 탐색 id를 내는지는 이 저장소에서 확인하지
    않았다.
  - `FrameNavigationStarting`: 허용 origin이 아니면 취소하고 로그만 남긴다. 허용된 프레임 탐색은 상태를 바꾸지 않는다.
  - `SourceChanged`의 same-document: 새 문서가 아니면 세션의 신뢰된 URL(UI 요청의 출처 판단에 쓰는 값)만 갱신한다. 허용
    origin이 아니면 갱신하지 않는다. `windows.getWebViewState`의 `url`은 이 값과 별개로 호출 시점의 WebView2 `Source`를
    직접 읽는다.
  - `NavigationCompleted`: `windows.readiness`와 `getReadiness`의 `document` 상태와 `loading`을 갱신한다.
  - 제목 변경은 `windows.documentTitleChanged`로 따로 제공한다.
- 이 저장소의 이벤트는 WebView(UI)로 전달된다. UI의 스크립트는 같은 문서 안에서 `hashchange`, `popstate`와 Navigation API
  (`navigation` 객체의 `currententrychange`, 엔진이 지원할 때만) 이벤트로 same-document 탐색을 직접 안다. Navigation
  API의 지원 범위는 호스트별 WebView 엔진에 따르며 이 저장소에서 확인하지 않았다. 새 문서의 탐색은 새
  스크립트가 구독하기 전에 시작되므로 UI가 이벤트로 받을 수 없다. 프레임 안의 탐색은 허용 origin 안에서만 일어나며, 프레임은
  이 저장소의 호스트 API 대상이 아니다(앱 명령과 이벤트 구독은 최상위 문서 하나에 묶인다).

## 결정

1. 문서, 프레임과 same-document 탐색을 알리는 새 이벤트와 작업을 추가하지 않는다.
2. 백엔드는 기존 계약으로 탐색 결과를 확인한다.
   - 현재 URL, `loading`, `canGoBack`, `canGoForward`: `windows.getWebViewState`. macOS도 같은 작업을 제공하며 `url`은 WKWebView의 현재 URL을 읽고 앱 URL의 자산 scheme을 `https://app.bunaway.local`로 되돌려 돌려준다.
   - 새 문서의 준비 상태, 실패와 취소: `windows.readiness`, `windows.getReadiness`. Windows의 `loading`은 탐색 완료 이벤트가
     올 때까지 true로 남으므로 완료 기한 초과로 `document`가 `failed`가 된 뒤에도 true일 수 있다. macOS의 `loading`은
     WKWebView의 `isLoading`을 그대로 돌려준다.
   - same-document 탐색 뒤의 URL: `getWebViewState`의 `url`이 호출 시점의 현재 URL을 돌려준다. 호출 직후 값이 방금 시작한
     탐색을 반영한다는 보장은 없다.
   - same-document 탐색의 시점이 필요한 UI는 `hashchange`, `popstate`(엔진이 지원하면 Navigation API)를 쓰고
     백엔드가 필요로 하면 앱 명령으로 보낸다.
3. 프레임 탐색은 호스트가 허용 origin 검사와 로그만 맡고 앱에 알리지 않는다. 프레임별 탐색 정보, 프레임 URL과 origin 조회는
   별도 TODO(프레임 tree 지원 범위)에서 다룬다.
4. 이 결정은 Windows와 macOS 호스트에 같이 적용한다. 두 호스트 모두 `getWebViewState`로 현재 URL과 `loading`을 조회한다.
   same-document 탐색에서 세션 URL을 갱신하는 계기는 다르다. Windows는 `SourceChanged` 이벤트에서, macOS는 UI 메시지가
   도착할 때 그 시점의 출처로 `ViewBoundary.sameDocument`를 호출한다.
5. 기존 계약으로 얻을 수 없는 용도(탐색 이력 추적, 리디렉션 체인 조회 등)가 확인되면 별도 결정에서 다룬다. 탐색 전 허용과
   거부, 리디렉션과 popup 처리는 별도 TODO 항목이다.

## 근거

- 두 프레임워크가 다르다. Electron은 문서, 프레임, same-document 이벤트를 제공하고 Tauri는 이를 제공하지 않는다. 다르면
  코어는 작게 두는 쪽을 따른다. 이 저장소는 탐색 결과를 `getWebViewState`와 `windows.readiness`로 이미 제공하므로 같은 정보의 이벤트를 더하면 순서, 세대와 큐 한도 규칙을
  두 곳에서 지켜야 한다. 코어 계약은 작게 유지한다.
- same-document 탐색은 UI가 표준 웹 API로 직접 알 수 있고, 시점이 필요 없는 현재 URL 확인은 조회로 충분하다. 시점이 필요한
  백엔드는 UI가 앱 명령으로 알린다. 문서 탐색은 새 문서가 구독하기 전에
  일어나 UI 이벤트로 전달할 수 없다. 프레임은 최상위 문서 하나에 묶인 호스트 API의 대상이 아니라 이벤트를 받을 소비자가 없다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

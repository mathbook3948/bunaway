---
status: accepted
---

# WebView cache 크기 조회와 저장 데이터 삭제를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `a419fe05`.

## 배경

앱 백엔드가 WebView의 cache 크기를 조회하고, cache와 localStorage, IndexedDB, service worker 데이터 등 저장 데이터를
종류, origin, 기간별로 지우는 API와 인증 cache, DNS cache, code cache를 조회하거나 지우는 API를 둘지 정해야 했다.

- Electron의 `session`은 `getCacheSize`, `clearCache`, `clearStorageData`(storage 종류, origin, quota 종류 지정),
  `clearAuthCache`, `clearHostResolverCache`, `clearCodeCaches`를 제공한다.
- Tauri는 WebView 하나의 브라우징 데이터를 전부 지우는 `clear_all_browsing_data`만 제공하고, 종류, origin, 기간, 크기 조회는 제공하지 않는다.
- WebView2는 `ICoreWebView2Profile2`의 `ClearBrowsingData`(데이터 종류 비트 지정), `ClearBrowsingDataInTimeRange`,
  `ClearBrowsingDataAll`로 디스크 cache, service worker, cache storage, localStorage, IndexedDB 등을 종류와 기간별로 지울 수 있다.
  origin 단위 삭제는 이 API에 없고 DevTools 프로토콜(`Storage.clearDataForOrigin`)으로만 가능하다. cache 크기를 읽는 API와
  인증 cache, DNS cache, code cache를 따로 조회하거나 지우는 API는 없다.
- 이 호스트는 사용자 데이터 폴더를 호스트가 정하고(`native/windows/bun/webview.ts`) 같은 사용자 데이터 폴더의 컨트롤러는 프로필을 공유한다.
  창 하나에 WebView 하나이고(ADR 0026) 탐색은 앱 정의의 `origins` 안으로 제한된다.
- 앱 UI는 자기 origin의 데이터를 `localStorage.clear()`, `indexedDB.deleteDatabase()`, Cache Storage API의 `caches.delete()`,
  `serviceWorker.getRegistrations()`와 `unregister()`로 직접 지울 수 있다. `HttpOnly` cookie는 이 방법으로 지울 수 없으며
  백엔드용 cookie API도 제공하지 않는다.
- 프로필 폴더의 위치는 공개 계약이 아니다.

## 결정

1. cache 크기 조회, 저장 데이터 삭제(종류, origin, 기간별), 인증 cache, DNS cache, code cache의 조회와 삭제 API를 추가하지 않는다.
2. cache 크기, 인증 cache, DNS cache, code cache는 WebView2에 대응하는 API가 없어 이 호스트에서 지원하지 않는다.
3. 앱이 자기 데이터를 지워야 하면 UI 코드가 웹 표준 API를 쓴다. 앱 백엔드가 소유한 데이터는 저장소 플러그인으로 지운다.
4. 로그아웃 때 WebView의 전체 브라우징 데이터를 지워야 하는 앱이 확인되면 별도 결정에서 다룬다. 그때는 Tauri와 같이 인자 없는
   전체 삭제 하나를 먼저 검토하고, 종류, origin, 기간 지정은 그 뒤에 따로 판단한다.

## 근거

- 가능한 범위(종류와 기간별 삭제)만 열어도 호스트가 WebView2 데이터 종류 비트와 완료 콜백, 실패 처리를 계약으로 정해야 한다.
  쓰는 곳이 확인되지 않은 기능을 위해 코어 계약을 늘리지 않는다.
- Electron의 범위 중 cache 크기와 인증, DNS, code cache는 WebView2로 만들 수 없어 Electron과 같은 표면을 제공할 수 없다.
  Tauri는 전체 삭제 하나만 제공하므로 요구가 생기면 이 형태가 먼저다.
- UI가 자기 origin의 데이터를 웹 표준으로 지울 수 있고, 백엔드가 WebView 저장 데이터를 대신 지워야 하는 경우는 확인되지 않았다.

## 결과

- 스키마, 이벤트, 권한과 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목 세 개를 `[x] 결정 완료`로 표시하고 이 결정을 참조한다.

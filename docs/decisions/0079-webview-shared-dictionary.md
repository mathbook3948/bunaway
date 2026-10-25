---
status: accepted
---

# WebView shared dictionary와 압축 dictionary cache 관리는 제공하지 않는다

결정일: 2026-10-25.

## 배경

Compression Dictionary Transport(응답의 `Use-As-Dictionary` 헤더로 이전 응답을 dictionary로 저장하고, 이후 요청의
`Available-Dictionary`와 `Accept-Encoding: dcb, dcz`로 Brotli 또는 Zstandard 차분 압축을 받는 기능)가 저장한 dictionary를
조회하거나 지우는 API를 제공할지 정해야 했다.

아래 외부 동작은 Electron v45.0.0, Tauri 2.12.5(wry 0.57.1), WebView2 SDK 1.0.4314.35와 Chromium을 공식 문서와 해당 태그의
소스로 확인한 것이며 이 저장소의 테스트로 검증한 것은 아니다.

- Electron의 `Session`은 `getSharedDictionaryUsageInfo()`(격리 키별 사용량), `getSharedDictionaryInfo({ frameOrigin, topFrameSite })`
  (항목 조회), `clearSharedDictionaryCache()`(전체 삭제), `clearSharedDictionaryCacheForIsolationKey({ frameOrigin, topFrameSite })`
  (격리 키별 삭제)를 제공한다. v33.3.0과 v34.0.0에서 추가됐다. 범위는 세션 단위이고 `webContents`에는 없다. 문서는 이 API를
  호출하지 않아도 dictionary 압축이 동작하며 API는 검사와 제어용이라고 밝힌다. `clearData()`로 cache를 지우면 dictionary
  cache도 함께 지워지고, dictionary만 지우려면 전용 메서드를 쓴다.
- Tauri 2.12.5와 wry 0.57.1에는 dictionary 전용 API가 없다. 관련된 것은 전체 삭제 `clear_all_browsing_data()` 하나이며
  Windows에서는 WebView2의 `ClearBrowsingDataAll`을 호출한다.
- WebView2 SDK 1.0.4314.35의 IDL과 헤더에는 dictionary 조회나 삭제 API가 없다. `COREWEBVIEW2_BROWSING_DATA_KINDS`에도
  전용 항목이 없다. Chromium의 BrowsingDataRemover는 cookies 또는 cache를 지울 때 shared dictionary도 지운다. WebView2의
  `DISK_CACHE`, `COOKIES`, `ClearBrowsingDataAll`이 이 경로로 dictionary를 함께 지우는지는 공개 문서로 확인되지 않았다.
- Chromium은 130(130.0.6723.58)부터 `CompressionDictionaryTransport`를 기본으로 켠다. WebView2 런타임에서 기본값을 밝힌
  문서는 없으며, 같은 Chromium 기반이므로 켜져 있을 것으로 본다.

이 저장소에는 WebView2 browsing data를 지우는 호출(`ClearBrowsingData` 계열)이 없다.

## 결정

1. shared dictionary와 압축 dictionary cache의 조회, 삭제, 사용량 확인 API를 추가하지 않는다.
2. Compression Dictionary Transport의 켜기와 끄기 설정도 추가하지 않는다. WebView2 런타임 기본값을 따른다. 이 기본값이
   켜짐인지는 문서로 확인되지 않았고, 결정은 켜짐과 꺼짐 어느 쪽이든 같다.
3. 이 기능이 필요한 구체적 사용처가 확인되면 별도 결정에서 다룬다. 그때 browsing data 삭제 계열 API의 설계와 함께 정한다.

## 근거

- 쓰는 곳이 없다. dictionary는 페이지와 서버가 맺는 전송 최적화이고 앱 로직이 직접 다루지 않으며, Electron 문서도 호출 없이
  동작한다고 밝힌다. 계약을 만들 만한 요구가 이 저장소에 없다.
- WebView2에는 조회와 선택 삭제 수단이 없다. 제공하려면 `ClearBrowsingData`의 `DISK_CACHE`나 `COOKIES`처럼 범위가 넓은
  삭제에 기대야 하는데, 그 삭제가 dictionary를 지우는지 공개 문서로 확인되지 않고 cache나 cookies까지 함께 지우게 된다.
  Electron의 격리 키별 조회와 삭제는 WebView2로 구현할 수 없다.
- Electron은 제공하고 Tauri는 제공하지 않아 둘이 다르다. Electron 방식은 WebView2 API 밖이라 그대로 따를 수 없고, 코어는
  작게 두고 사용처가 확인되면 browsing data 삭제 계열과 함께 정하는 편이 맞다. 이 결정은 dictionary 전용 API를 두지 않는다는
  점에서 Tauri와 같다. Tauri의 전체 삭제 `clear_all_browsing_data()`에 해당하는 일반 삭제 API는 이 결정의 범위가 아니다.
- 켜기와 끄기 설정은 브라우저 인자(`--disable-features=CompressionDictionaryTransport`)가 필요하다. 이 인자가 WebView2에서
  실제로 기능을 끄는지는 문서로 확인되지 않았다. 또한 인자는 같은 사용자 데이터 폴더의 브라우저 프로세스 전체에 적용되고
  환경 생성 때만 넘길 수 있어 앱 설정과 묶이므로([ADR 0065](./0065-webview-content-settings.md)와 같은 이유) 제공하지 않는다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

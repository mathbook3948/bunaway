---
status: accepted
---

# WebView 세션의 persistent 여부와 storage path 조회는 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `42fdd220`.

## 배경

창의 WebView 세션이 디스크에 저장되는지(persistent)와 그 저장 경로를 앱이 조회하는 API를 둘지 정해야 했다.

아래 외부 동작은 Electron v45.0.0, Tauri 2.12.5(wry 0.57.1), WebView2 SDK 1.0.4314.35의 공식 문서와 해당 태그의 소스를
확인한 것이며 이 저장소의 테스트로 검증한 것은 아니다.

- Electron의 `session`은 `ses.isPersistent()`(`boolean`, 구현은 `!IsOffTheRecord()`)와 `ses.storagePath`,
  `ses.getStoragePath()`(`string | null`, in-memory 세션이면 `null`)를 제공한다. partition 이름이 `persist:`로 시작하면
  persistent, 아니면 in-memory 세션이다.
- Tauri 2.12.5는 `data_directory`, `incognito`, `data_store_identifier`를 생성 때만 지정하는 builder 설정으로 제공하고,
  생성된 WebView의 persistent 여부나 데이터 경로를 읽는 공개 getter는 없다. Windows에서는 `with_webview`가 넘기는
  WebView2 COM 객체로 직접 읽을 수 있을 뿐이다. 크로스플랫폼 API가 아니다.
- WebView2의 기본 `ICoreWebView2Profile`에 `ProfileName`(슬롯 3), `IsInPrivateModeEnabled`(슬롯 4), `ProfilePath`(슬롯 5)가
  있고 프로필은 `ICoreWebView2_13::get_Profile`(슬롯 105)로 얻는다. 환경의 사용자 데이터 폴더는
  `ICoreWebView2Environment7::get_UserDataFolder`(슬롯 15)로 얻는다. InPrivate 프로필에서 `ProfilePath`가 무엇을 돌려주는지는
  IDL과 문서에 규정이 없어, Electron의 "in-memory면 null" 의미는 호출 측 매핑으로만 만들 수 있다.
- 이 호스트는 InPrivate를 쓰지 않는다. 사용자 데이터 폴더를 `<dataRoot>/webview/<뷰 식별자 인코딩>`으로 정해
  `CreateCoreWebView2EnvironmentWithOptions`에 넘기고(`native/windows/bun/webview.ts`, `view-profile.ts`), 환경과 컨트롤러
  옵션에 InPrivate나 프로필 이름을 지정하지 않는다. 그래서 모든 WebView 세션은 항상 persistent이고 경로는 호스트가
  정한 위치다. 앱 전용 디렉터리는 `path` 플러그인이 별도로 제공한다([ADR 0024](./0024-plugin-path-responsibility.md)).

## 결정

1. WebView 세션의 persistent 여부와 storage path를 조회하는 API를 추가하지 않는다.
2. persistent 여부는 호스트가 InPrivate를 쓰지 않으므로 항상 true이며, 이 값을 앱에 노출하지 않는다.
3. 대체 수단은 제공하지 않는다. WebView 프로필 폴더의 정확한 위치는 공개 계약이 아니며 앱은 이 경로에 의존하지 않는다.
4. 비영구 세션이나 앱이 고르는 프로필 위치를 지원하게 되면 그 기능의 결정에서 조회 API를 함께 다룬다.

## 근거

- 쓰는 곳이 없다. 값이 상수(persistent)이고, 경로는 앱이 알아야 할 이유가 있는 데이터(앱 데이터, 캐시, 로그)가 `path`
  플러그인 디렉터리로 이미 제공된다. `plugins`, `packages`, `examples`에는 WebView 프로필 폴더를 읽는 코드가 없다.
- Electron은 두 값을 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는 쪽을 따른다.
  Electron의 조회는 앱이 partition으로 세션 종류를 고르기 때문에 의미가 있는데, 이 호스트에는 그 선택이 없다.
- 프로필 경로를 노출하면 호스트의 폴더 배치(뷰 식별자 인코딩 포함)가 앱이 의존하는 계약이 되어 바꿀 수 없게 된다. 경로를
  받는 기능의 제한은 앱 명령이 맡는다는 방침([ADR 0024](./0024-plugin-path-responsibility.md))과도 맞지 않는다.
- InPrivate의 `ProfilePath`가 규정되어 있지 않아 Electron의 `null` 의미를 보장하는 계약을 만들려면 호스트가 따로 정해야
  하는데, 그 경우가 이 호스트에 없다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

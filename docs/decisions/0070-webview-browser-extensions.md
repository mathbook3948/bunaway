---
status: accepted
---

# 브라우저 extension 설치, 조회, 제거와 Chrome API subset은 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `42fdd220`.

## 배경

WebView에 Chrome 계열 브라우저 extension을 설치, 조회, 제거하고 그 이벤트를 받는 기능과, extension이 쓸 수 있는 Chrome API
범위를 정해야 했다.

아래 외부 동작은 Electron v45.0.0, Tauri 2.12.5(wry 0.57.1), WebView2 SDK 1.0.4314.35 기준으로 공식 문서와 해당 태그의
소스를 확인한 것이며 이 저장소의 테스트로 검증한 것은 아니다.

- Electron의 정식 API는 `session.extensions`의 `loadExtension`, `removeExtension`, `getExtension`, `getAllExtensions`와
  `extension-loaded`, `extension-unloaded`, `extension-ready` 이벤트다. `session`에 직접 붙은 같은 이름의 메서드는 Electron 36부터
  deprecated다. 문서는 Chrome extension API 전체를 지원하지 않고 DevTools extension 등을 위한 부분 집합만 지원하며, 지원 목록
  밖의 API는 임시 지원이라 제거될 수 있다고 밝힌다. Chrome Web Store 설치는 지원하지 않고 압축 해제된 폴더만 불러온다.
  앱을 다시 시작하면 기억하지 않아 매번 불러와야 한다.
- Tauri는 실행 중에 extension을 설치, 조회, 제거하는 공개 API가 없다. 대신 웹뷰 생성 때 쓰는 옵션이 있다.
  `WebviewBuilder::browser_extensions_enabled`(Windows에서 WebView2 환경의 `AreBrowserExtensionsEnabled`)와
  `extensions_path`, 설정 파일의 `browserExtensionsEnabled`(기본값 꺼짐)다. wry는 extension이 켜져 있고 `extensions_path`가 있을 때
  웹뷰를 만들면서 그 폴더의 하위 항목마다 `AddBrowserExtension`을 호출해 설치하고 결과는 쓰지 않는다. 조회, 제거, 활성화, 이벤트는 노출하지 않는다.
- WebView2는 환경 옵션 `AreBrowserExtensionsEnabled`(기본값 FALSE)를 켜야 한다. 끄면 `AddBrowserExtension`이
  `ERROR_NOT_SUPPORTED`로 실패하고 `GetBrowserExtensions`는 아무것도 반환하지 않는다. 프로필(`ICoreWebView2Profile7`)에는
  압축 해제된 폴더를 추가하는 `AddBrowserExtension`과 목록을 조회하는 `GetBrowserExtensions`가 있고, 제거와 활성화는 개별
  extension 객체의 `Remove`와 `Enable`이다. 추가한 extension은 프로필에 저장된다. 이미 실행 중인 환경과 이 옵션 값이 다르면
  환경 생성이 `HRESULT_FROM_WIN32(ERROR_INVALID_STATE)`로 실패한다. 환경 옵션은 환경 생성 때만 넘기며, 같은 제약이
  [ADR 0065](./0065-webview-content-settings.md)의 브라우저 인자에도 있다.
- Windows 호스트는 `CreateCoreWebView2EnvironmentWithOptions`에 환경 옵션을 넘기지 않으므로(`native/windows/bun/webview.ts`)
  extension은 꺼진 상태다.

## 결정

1. extension 설치, 조회, 제거와 그 이벤트 API를 제공하지 않는다.
2. extension이 쓸 수 있는 Chrome API subset은 정하지 않는다. extension을 지원하지 않으므로 이 범위는 정의 대상이 아니다.
3. 호스트는 WebView2 환경에서 extension을 켜지 않는다. 앱은 extension에 기대지 않고 자체 UI와 백엔드로 기능을 구현한다.
4. 사용처가 확인되면 별도 결정에서 다룬다. 그때 필요한 것은 환경 생성 옵션, 사용자 데이터 폴더 단위의 설정, 앱 origin과의
   관계 정의다.

## 근거

- 쓰는 곳이 없다. 이 프레임워크의 WebView는 앱이 배포한 자체 UI를 표시한다. 브라우저 extension은 임의의 페이지를 대상으로
  하는 기능이라 자체 UI에는 필요하지 않다.
- 보안 경계가 커진다. extension은 앱이 배포하지 않은 코드를 앱 페이지에서 실행할 수 있으므로, 그 코드가 호스트 브리지와
  앱의 origin 정책, CSP에 어떻게 닿는지 정의해야 한다. 이 정의는 이 결정의 범위 밖이다.
- 환경 옵션을 켜는 일은 코어의 환경 생성 규칙에 영향을 준다. 같은 사용자 데이터 폴더의 창과 옵션이 어긋나면 환경 생성이
  실패하므로 앱 정의 설정과 창 설정이 서로 묶인다. 코어는 작게 둔다.
- 두 프레임워크가 다르다. Electron은 부분 집합의 Chrome API로 불러오기, 제거, 조회와 이벤트를 제공하고, Tauri는 생성 때 켜기와
  폴더 일괄 설치만 선택적으로 제공한다. 이 결정은 둘 다와 다르게 아무것도 제공하지 않는다. 사용처가 없고 보안 경계 정의가
  선행되어야 하며, 지원 범위가 불완전한 기능을 계약으로 굳히지 않으므로 코어는 작게 두는 쪽을 따랐다. 같은 구역의 결정
  ([ADR 0065](./0065-webview-content-settings.md))과 같은 방침이다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 두 항목을 완료로 표시하고 이 결정을 참조한다.

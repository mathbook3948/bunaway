---
status: accepted
---

# 브라우저 extension 설치, 조회, 제거와 Chrome API subset은 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `42fdd220`.

## 배경

WebView에 Chrome 계열 브라우저 extension을 설치, 조회, 제거하고 그 이벤트를 받는 기능과, extension이 쓸 수 있는 Chrome API
범위를 정해야 했다.

아래 외부 동작은 해당 프로젝트의 공개 문서와 소스에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

- Electron은 `session`에 extension 불러오기와 제거, 목록 조회를 제공하고, 지원하는 Chrome API가 일부로 제한된다고
  문서에 밝힌다. Chrome Web Store 설치는 지원하지 않는다.
- Tauri는 설치, 조회, 제거를 하는 공개 API가 없다. wry의 Windows 빌더에 `with_browser_extensions_enabled`와
  `with_extensions_path`가 있어 환경 옵션으로 extension을 켜고 폴더를 지정할 수 있을 뿐이다(wry 0.57.1 기준).
- WebView2는 환경 옵션에서 extension을 켜야 하고(기본값은 꺼짐), 켠 환경의 프로필에서 압축 해제된 extension을 추가하고
  제거한다. 환경 옵션은 환경 생성 때만 넘기며, 같은 사용자 데이터 폴더를 쓰는 프로세스와 옵션이 다르면 환경 생성이
  실패한다([ADR 0065](./0065-webview-content-settings.md)의 브라우저 인자와 같은 제약).
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
- 보안 경계가 커진다. extension의 content script는 앱 페이지에 주입되어 `window.chrome.webview` 브리지를 호출할 수 있다.
  앱의 origin 정책과 CSP 밖에서 들어오는 코드가 생기고, 이를 허용하는 범위를 정의해야 한다.
- 환경 옵션을 켜는 일은 코어의 환경 생성 규칙에 영향을 준다. 같은 사용자 데이터 폴더의 창과 옵션이 어긋나면 환경 생성이
  실패하므로 앱 정의 설정과 창 설정이 서로 묶인다. 코어는 작게 둔다.
- Electron은 제한된 API로 제공하고 Tauri는 설치와 조회를 위한 API를 제공하지 않아 두 프레임워크가 다르다. 이 결정은
  Electron과 다르고 Tauri와 같다. 지원 범위가 불완전한 기능을 계약으로 굳히지 않으므로 Chrome API subset(결정 2)도 정하지
  않는다. 같은 구역의 결정([ADR 0065](./0065-webview-content-settings.md))과 같은 방침이다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 두 항목을 완료로 표시하고 이 결정을 참조한다.

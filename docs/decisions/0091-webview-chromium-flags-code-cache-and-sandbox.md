---
status: accepted
---

# Chromium feature flag, V8 code-cache, 렌더러 sandbox 설정을 제공하지 않는다

결정일: 2026-10-26. 검토 기준: main `c6b9ecc9`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.
확인하지 못한 사실은 단정하지 않는다.

앱이 Chromium 명령줄 스위치와 feature flag, V8 code-cache, 렌더러 sandbox 설정을 바꾸는 공개 설정을 둘지 정해야 했다.

- Electron은 `app.commandLine.appendSwitch`로 임의 스위치와 `--enable-features`, `--disable-features`를 앱이 `ready` 전에 넘길 수 있게 한다.
  V8 code cache는 Chromium이 관리하고 앱 설정은 없다. 렌더러 sandbox는 `webPreferences.sandbox`와 `app.enableSandbox()`로 조절한다.
- Tauri는 Windows에서 창 설정 `additional_browser_args`로 WebView2 환경 생성에 브라우저 인자를 넘길 수 있다. code cache와
  sandbox를 바꾸는 설정은 확인하지 못했다.
- WebView2의 `AdditionalBrowserArguments`는 환경 생성 때만 넘기며 바꾸는 setter가 없다. 같은 사용자 데이터 폴더의 브라우저 프로세스가
  이미 실행 중이고 옵션이 다르면 환경 생성이 `ERROR_INVALID_STATE`로 실패한다([ADR 0065](./0065-webview-content-settings.md),
  [ADR 0082](./0082-webview-preconnect-connections-and-net-log.md)). 지원되는 인자 목록은 보장되지 않고, 보안 기능을 끄는 인자도 받는다.
- 이 저장소의 호스트는 `CreateCoreWebView2EnvironmentWithOptions`에 환경 옵션을 넘기지 않고(`native/windows/bun/webview.ts`),
  `plugins`, `packages`, `native`에서 브라우저 인자나 `WEBVIEW2_` 환경 변수를 설정하는 코드는 찾지 못했다. 즉 지금 프레임워크가 쓰는 고정 인자는 없다.
- Bun 백엔드는 JavaScriptCore를 쓰므로 V8 code-cache에 해당하는 설정이 없다. WebView2의 JavaScript 코드 캐시는 브라우저 프로세스가 관리하며
  앱이 제어하는 설정은 확인하지 못했다. 캐시 삭제 API는 [ADR 0081](./0081-webview-browsing-data.md)이 제공하지 않기로 했다.
- WebView2 렌더러는 항상 sandbox 안에서 돌고 이를 끄는 설정을 확인하지 못했다. 백엔드(Bun) 격리는 별도 항목에서 다룬다.

## 결정

1. 임의 Chromium 스위치, feature flag, 브라우저 인자를 넘기는 공개 설정을 추가하지 않는다.
2. V8 code-cache 설정은 제공하지 않는다. Bun 백엔드에는 대응 설정이 없고 WebView2는 브라우저 프로세스가 관리한다(대체 불가).
3. 렌더러 sandbox 설정은 제공하지 않는다. WebView2 렌더러는 항상 sandbox 안에서 실행되며 앱이 끌 수 없다(항상 켜짐, 미지원).
4. 프레임워크가 넘기는 브라우저 인자는 지금 없고 이 결정으로 추가하지 않는다.
5. 재검토 조건: WebView2가 지원되는 설정 API를 추가할 때, 선택 Chromium 렌더러가 구현될 때, 개별 기능에 대한 요구가 확인될 때.
   개별 기능은 임의 인자가 아니라 이름 붙은 전용 옵션으로 결정하고, 환경 옵션 전달 경로, 같은 사용자 데이터 폴더의 환경 충돌, 보안 기능과의 관계를 먼저 정한다.

## 근거

- Electron과 Tauri 모두 임의 인자 통로가 있어 같은 방식이 가능하다. 그러나 이 통로는 sandbox, 사이트 격리, 웹 보안을 끌 수 있어
  모든 앱의 보안 경계에 닿고, 지원이 보장되지 않는 인자가 WebView2 업데이트로 동작이 바뀔 수 있다. 환경 생성 때만 적용되어 실행 중에 바꿀 수 없고
  인자가 다르면 환경 생성이 실패할 수 있어 앱이 일관되게 쓰기 어렵다. 코어는 작게 두는 쪽을 따른다.
- 쓰는 곳이 없다(`plugins`, `packages`, `examples`에서 이 설정을 요구하는 코드는 없다). 결정을 미뤄도 앱이 막히지 않는다.
- 호스트는 지금 환경 옵션을 넘기지 않으므로 이 결정은 현재 동작을 확인하는 것이며 코어 계약과 권한을 바꾸지 않는다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

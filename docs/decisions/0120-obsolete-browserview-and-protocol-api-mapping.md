---
status: accepted
---

# obsolete BrowserView와 구 protocol API는 현대 기능에 매핑하고 구 API 호환을 제공하지 않는다

결정일: 2026-10-28. 검토 기준: main `310be4a0`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다. 버전별 세부는 확인하지 않았다.

Electron API 중 Electron 스스로 현대 API로 옮기고 deprecated로 둔 것이 둘 있다. 이 저장소가 이를 어떤 기능에 매핑하는지, 구 API 호환을 제공하는지 정해야 했다.

- `BrowserView`: 창 안에 다른 WebView를 붙이는 API다. Electron은 `WebContentsView`와 `View` 트리로 대체하고 `BrowserView`를 deprecated로 둔다. Tauri는 창 하나에 WebView 하나가 기본이며, 창 안에 WebView를 더 붙이는 경로는 기본 API가 아닌 별도 기능으로만 다룬다.
- 구 protocol API: `protocol.registerFileProtocol`, `registerStringProtocol`, `registerBufferProtocol`, `registerHttpProtocol`, `registerStreamProtocol`과 `protocol.interceptFileProtocol`, `interceptStringProtocol`, `interceptBufferProtocol`, `interceptHttpProtocol`, `interceptStreamProtocol`은 응답 종류마다 함수가 따로 있고 콜백으로 응답을 돌려준다. Electron은 Fetch의 `Request`를 받아 `Response`를 돌려주는 `protocol.handle` 하나로 통합하고, 구 함수를 deprecated로 둔다. Tauri는 `register_uri_scheme_protocol`(비동기판 포함) 하나로 요청을 받아 응답을 만든다.
- 이 저장소는 앱 하나에 WebView 하나와 창 하나를 코어 모델로 정했다([ADR 0026](./0026-single-webview-single-window.md)). 다중 창은 코어 계약이 아니며, 필요성이 확인되면 별도 플러그인의 opt-in으로 다시 제안한다고 기록돼 있다.
- 패키지 자산은 Windows에서 `https://app.bunaway.local`로 로드하고 macOS와 iOS에서 `bunaway://` scheme handler가 읽는다([ADR 0060](./0060-localhost-asset-server.md)). 이는 호스트 내부 경로이며 앱이 쓰는 protocol 등록 API가 아니다. 사용자 정의 앱 protocol의 등록, 응답 종류, MIME, range, CORS, 세션 정책 연결은 TODO-windows의 사용자 정의 protocol 항목들(issue #158)이 맡는다.
- `docs/decisions`에는 `BrowserView`나 구 protocol 함수를 다룬 결정이 없다. WebView 자식 뷰와 `ImageView`, 뷰 단위 corner와 blur는 TODO-windows의 View tree 항목들이 따로 다룬다.

## 결정

1. `BrowserView`에 해당하는 API와 그 대체인 `WebContentsView`에 해당하는 API를 제공하지 않는다. 두 API가 만드는 "창 안의 추가 WebView"는 ADR 0026의 WebView 하나 모델과 맞지 않아 매핑 대상이 없다. 같은 창 안의 화면 전환은 웹 라우팅이 맡는다. 네이티브 자식 뷰는 View tree 항목의 결정을 따르며 이 결정이 계약을 만들지 않는다.
2. 구 protocol API(`register*Protocol`, `intercept*Protocol`)와 같은 이름 또는 응답 종류별 함수를 제공하지 않는다. 이 저장소가 앱 protocol 기능을 제공하게 되면 요청을 받아 응답을 돌려주는 현대형 하나만 제공한다(Electron `protocol.handle`, Tauri `register_uri_scheme_protocol`과 같은 모양). 응답 종류(파일, 문자열, 버퍼, HTTP, stream)는 응답 객체가 표현하며 종류마다 등록 함수를 늘리지 않는다.
3. 이미 등록된 scheme을 가로채는 `intercept*` 계열에 해당하는 기능은 이 결정으로 약속하지 않는다. HTTP 요청 가로채기는 [ADR 0083](./0083-webview-request-interception.md)이 제공하지 않기로 했다.
4. 이 결정은 protocol 기능의 제공 여부, 계약, 보안 경계를 정하지 않는다. 그것은 issue #158의 항목들이 정하고, 그 결정이 위 2번의 "현대형 하나, 구 API 호환 없음"을 따른다.
5. 개발 단계이므로 구 API 이름을 별칭으로 두거나 경고만 남기는 호환 계층을 두지 않는다.

## 근거

- Electron과 Tauri는 둘 다 현대형 하나(`protocol.handle`, `register_uri_scheme_protocol`)를 기준으로 삼고, Electron은 구 API를 이미 대체 대상으로 표시했다. 같은 판단이므로 그 방식을 따른다. 새 계약에서 deprecated API를 다시 만들면 곧 제거할 이름을 공개 계약에 들이는 일이 된다.
- `BrowserView`는 Electron이 대체 API를 둔 뒤 deprecated로 두었고 Tauri 기본 모델에는 없다. ADR 0026이 이미 다중 WebView를 채택하지 않았으므로 새 결정으로 코어 계약을 넓힐 이유가 없다. 코어는 작게 둔다.
- 쓰는 곳이 없다. `plugins`, `packages`, `examples`에 `BrowserView`, `WebContentsView`, 구 protocol 함수를 쓰는 코드는 없다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 결정 완료로 표시하고 이 결정을 참조한다. 사용자 정의 protocol 구현 항목은 열어 둔다.
- 앱 protocol 기능을 구현할 때 응답 모양을 이 결정의 2번에 맞춘다. 창 안 추가 WebView 요구가 확인되면 ADR 0026 8번에 따라 별도 플러그인 결정으로 다룬다.

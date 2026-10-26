---
status: accepted
---

# UI 안에 끼워 넣는 guest WebView(`<webview>` 태그)는 제공하지 않는다

결정일: 2026-10-26. 검토 기준: main `c6b9ecc9`.

## 배경

앱 UI 안에 별도 WebView를 끼워 넣는 guest WebView를 제공할지, 제공한다면 어떤 권한 경계를 둘지 정해야 했다.

아래 외부 동작은 Electron v45.0.0, Tauri 2.12.5 기준으로 공식 문서를 확인한 것이며 이 저장소의 테스트로 검증한 것은 아니다.

- Electron의 `<webview>` 태그는 앱 페이지 안에 별도 프로세스의 콘텐츠를 끼워 넣는다. `BrowserWindow`의 `webviewTag` 옵션으로 켜야 하고 기본값은 꺼짐이다.
  공식 문서는 이 태그의 구조가 자주 바뀌어 안정성이 낮다고 밝히며, 사용하지 말고 `<iframe>`, `WebContentsView`, 또는 임베드를 피하는 구조를 고려하라고 권고한다.
  보안 체크리스트도 `webviewTag`를 켜지 말라고 하고, 켜야 하면 `will-attach-webview`에서 `webPreferences`와 `src`를 검증하라고 한다.
- Tauri에는 UI 안에서 쓰는 guest WebView 태그가 없다. 한 창에 WebView를 더하는 기능은 Rust 쪽 다중 WebView API(실험 기능 플래그 뒤)이고, 페이지 안에 끼워 넣는 방식이 아니다.
- 이 저장소의 호스트는 창 하나에 WebView 하나만 둔다([ADR 0026](./0026-single-webview-single-window.md)). 같은 ADR은 "창은 하나지만 WebView 여러 개"(Electron `WebContentsView` 방식)를
  기각했고, 추가 WebView는 별도 ADR로 세션 발급과 회수 같은 확장점이 정해질 때만 다시 제안한다.
- 호스트가 발급하는 문서 세션은 최상위 문서 단위라 하위 프레임(`<iframe>` 등)은 SDK 세션을 가질 수 없고, 하위 프레임에서 시작한 요청은 출처와 관계없이 처리하지 않는다([ADR 0002](./0002-host-owned-call-context.md)).
- 정책 뷰의 `origins` 밖 `http`, `https` URL은 같은 WebView에서 열지 않고 `opener.openUrl`을 거쳐서만 시스템 기본 브라우저로 넘긴다([ADR 0026](./0026-single-webview-single-window.md)의 `window.open`과 링크 항목).

## 결정

1. `<webview>` 태그나 이와 같은 UI 내 guest WebView API는 제공하지 않는다.
2. 외부 콘텐츠 표시는 다음으로 처리한다. 앱이 직접 만든 내용은 같은 WebView 안의 라우팅, 모달 UI, `<iframe>`으로 표시한다. `<iframe>`은 하위 프레임이라
   호스트 세션과 SDK 호출을 받지 못하므로 호스트 브리지와 앱 권한을 상속하지 않는다. 임의의 외부 사이트는 `opener.openUrl`로 시스템 브라우저에서 연다.
3. 이 결정은 코어 계약, 권한, 정책 스키마, 이벤트, 네이티브 코드를 바꾸지 않는다. 호스트는 `<webview>` 태그를 위한 속성이나 프로세스 경계를 만들지 않는다.
4. 사용처가 확인되어 다시 제안할 때는 [ADR 0026](./0026-single-webview-single-window.md)의 추가 WebView 재제안 조건을 먼저 충족해야 하고, 그 ADR에서 다음을 정한다.
   guest가 호스트 브리지와 앱 권한을 상속하지 않는 경계, 탐색 가능한 origin 제한, 앱 WebView와 분리된 세션(저장소와 쿠키), 새 창과 권한 요청의 처리.

## 근거

- 쓰는 곳이 없다. 이 프레임워크의 WebView는 앱이 배포한 자체 UI를 표시하고, 외부 페이지를 보여 주는 요구는 시스템 브라우저와 `<iframe>`으로 충족된다.
- 권한 경계가 보장되지 않는다. guest는 앱 UI와 다른 프로세스에서 임의의 콘텐츠를 실행하므로, 호스트 브리지 노출 여부, 세션 발급과 회수, 탐색 제한을 새로 정의해야 한다.
  이는 모든 앱의 보안 검토 범위를 늘리는 변경이고, 기본 단일 WebView 앱의 계약을 늘리지 않는다는 ADR 0026의 조건과 부딪힌다.
- 두 프레임워크가 다르다. Electron은 태그를 제공하지만 기본으로 꺼 두고 보안상 쓰지 말라고 권고하며, Tauri는 태그가 없다. 이 결정은 Electron의 기본값(꺼짐)과 권고, Tauri의 구성을 따라
  코어는 작게 두는 쪽을 택했다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- 이 결정은 한 창의 다중 WebView(`docs/TODO-windows.md`의 WebView 생성과 bounds 항목), WebView reparent, 선택 Chromium 렌더러 항목을 닫지 않는다. 그 항목들은 각자의 결정을 따른다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

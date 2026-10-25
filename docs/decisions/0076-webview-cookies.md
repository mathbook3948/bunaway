---
status: accepted
---

# WebView cookie 조회, 설정, 삭제, 변경 이벤트와 flush를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `a419fe05`.

## 배경

WebView의 cookie를 앱 백엔드가 조회, 설정, 삭제하고 변경 이벤트와 flush를 받는 API를 제공할지 정해야 했다.
Electron은 세션의 `cookies` 객체로 조회, 설정, 삭제, `changed` 이벤트와 `flushStore`를 제공한다.
WebView2에는 `ICoreWebView2CookieManager`가 있어 조회(`GetCookies`), 설정(`AddOrUpdateCookie`), 삭제(`DeleteCookie` 등)는
구현할 수 있으나 변경 이벤트와 flush에 해당하는 API는 없다.

- WebView 안에서는 정책 뷰의 `origins`에 허용된 origin만 탐색하며(ADR 0026), 같은 origin의 페이지는 `document.cookie`로
  `HttpOnly`가 아닌 cookie를 읽고 쓸 수 있다. 서버가 보낸 `Set-Cookie`는 WebView가 그대로 처리한다.
- 백엔드는 WebView와 별개인 Bun 프로세스다. 선택 플러그인 `network`는 WebView cookie를 공유하지 않으며
  요청 header의 `Cookie`도 받지 않는다([network 계약](../site/src/content/docs/reference/plugins/network.mdx)).
  백엔드가 서버에 로그인해야 하면 토큰을 직접 받아 저장소 플러그인에 보관할 수 있다.
- cookie 조회를 백엔드에 열면 `HttpOnly` cookie(스크립트에서 보이지 않도록 서버가 막아 둔 세션 값)가 WebView 밖으로 나간다.
  설정과 삭제를 열면 백엔드가 WebView 안 사이트의 로그인 상태를 바꾼다. 둘 다 앱마다 허용 origin, 이름, 속성 범위를
  따로 정해야 하는 권한 표면이며 지금 이를 쓰는 앱은 확인되지 않았다.
- 변경 이벤트와 flush는 조회와 설정이 있어야 의미가 있다. WebView2에는 cookie 변경 알림과 flush API가 없어
  이를 제공하려면 호스트가 폴링 등으로 따로 만들어야 하고 flush는 구현할 수단이 없다.

## 결정

1. cookie 조회, 설정, 삭제, 변경 이벤트와 flush를 제공하지 않는다. 호스트는 WebView의 cookie 저장을 그대로 두고
   별도 계약을 얹지 않는다. 이 결정은 Windows 호스트(WebView2)의 계약을 정하며, macOS 호스트는 macOS TODO에서 따로 판단한다.
2. UI 코드가 필요하면 `document.cookie`를 쓴다. cookie가 재시작 뒤에도 남는지는 WebView2 저장소와 페이지의 host를 따르며(cookie는
   포트로 분리되지 않는다) 이 결정은 이를 보장하지 않는다. 백엔드가 UI의 로그인 결과를 필요로 하면 UI가 토큰 값을 앱 명령으로
   전달하고, 백엔드는 이를 저장소 플러그인에 보관한다.
3. WebView의 `HttpOnly` cookie 값을 백엔드가 읽어야 하는 앱이 확인되면 별도 결정에서 다룬다. 그때는 허용 origin 안의
   URL 하나와 cookie 이름을 지정하는 읽기 전용 조회를 먼저 검토하고, 설정과 삭제, 변경 이벤트는 그 뒤에 따로 판단한다.

## 근거

- 쓰는 곳이 확인되지 않은 권한 표면을 코어 계약에 더하지 않는다. 앱별 허용 범위 설정과 권한 검사를 함께 설계해야 하므로
  요구가 생긴 뒤에 정하는 편이 계약이 작다.
- 토큰 전달은 앱 명령과 저장소 플러그인으로 이미 가능하며, `HttpOnly` 값을 WebView 밖으로 내보내지 않아도 된다.
- Electron은 이 API를 메인 프로세스에만 두고 렌더러에는 앱이 IPC로 골라 노출한다. 이 저장소는 그런 앱별 노출 범위와
  권한 검사를 아직 정하지 않았으므로 같은 범위를 그대로 열지 않고, 요구가 확인될 때 좁은 형태로 다시 정한다.

## 결과

- 스키마, 이벤트, 권한과 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 `[x] 결정 완료`로 표시하고 이 결정을 참조한다.

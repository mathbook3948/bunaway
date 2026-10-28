---
status: accepted
---

# WebView 탐색 허용과 거부, redirect, 새 창 요청을 앱 코드가 판정하는 훅을 지금은 제공하지 않는다

결정일: 2026-10-28. 검토 기준: main `58ddd4ee`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

앱 코드가 WebView의 탐색, redirect, `window.open` 요청마다 허용 또는 거부를 결정하는 콜백 훅을 공개 계약으로 제공할지 정해야 했다. [ADR 0078](./0078-webview-navigation-events.md)은 탐색 알림 이벤트를 다루면서 탐색 전 허용과 거부, redirect와 popup 처리는 별도 항목으로 남겼다.

- Electron은 `webContents`의 `will-navigate`, `will-frame-navigate`, `will-redirect`로 탐색을 취소하게 하고, `setWindowOpenHandler`가 `window.open`과 `target="_blank"` 요청마다 허용 또는 거부를 돌려준다. 훅은 앱의 메인 프로세스 코드에서 돌고 판정은 앱 코드가 곧 정책이다. `will-redirect`는 redirect 단계마다 발생한다. 앱이 `loadURL`로 시작한 탐색에는 `will-navigate`가 발생하지 않는다. 외부 링크는 거부한 뒤 앱이 `shell.openExternal`로 여는 패턴이 흔하다([ADR 0002](./0002-host-owned-call-context.md)에도 같은 설명이 있다).
- Tauri는 탐색 전 허용 여부를 정하는 `on_navigation`을 앱의 Rust 코드가 쓰는 빌더 훅으로 제공한다. JS 공개 API가 아니며 콜백 인자에 프레임 정보도 없다(ADR 0078). 두 프레임워크 모두 앱 백엔드 코드가 탐색을 판정하는 훅을 제공하는 셈이다. 새 창 요청에 대한 Tauri의 처리기는 이 결정에서 확인하지 않았다.
- 이 저장소는 같은 목적을 선언형으로 해결한다.
  - 정책 뷰의 `origins`(`http(s)://호스트[:포트]`)가 허용 목록이다. Windows 호스트의 `NavigationStarting`과 `FrameNavigationStarting` 처리기는 허용 목록 밖 탐색을 취소하고, redirect도 단계마다 같은 `NavigationStarting`을 거친다(`native/windows/bun/webview.ts`). 따라서 허용 밖 주소를 거치는 redirect는 최종 URL이 허용 origin이어도 그 단계에서 취소된다. macOS 호스트는 `decidePolicyForNavigationAction`과 `decidePolicyForNavigationResponse`가 `macosOrigin`으로 판정하고 중간 단계는 자원 규칙이 막는다(`native/macos/bun/webview.ts`).
  - 앱 코드가 시작하는 탐색은 `windows.navigateWebView`가 같은 `origins` 검사를 적용하고 허용 밖은 `PERMISSION_DENIED`로 거부한다(`docs/site/src/content/docs/reference/host/windows.mdx`의 `navigateWebView` 절).
  - 새 창 요청은 창을 만들지 않는다. 현재 Windows 호스트는 `NewWindowRequested`를 origin과 무관하게 처리 완료로 표시해 창을 만들지 않고 `new-window-blocked` 로그만 남긴다(`native/windows/bun/webview.ts`). macOS 호스트는 탐색 판정 콜백이 `targetFrame` 없는 요청을 받으면 origin과 무관하게 취소하고 같은 로그를 남긴다(`native/macos/bun/webview.ts`). 스크립트의 `window.open`이 이 콜백을 거치는지와 로그가 남는지는 코드와 시험으로 확인하지 않았다.
  - [ADR 0026](./0026-single-webview-single-window.md) 결정 6이 이 상태를 바꿀 목표 규칙을 정했다. 정책 뷰 `origins` 안 URL은 같은 WebView에서 열고, 밖의 `http(s)` URL은 뷰 `commands`의 `plugin.opener.openUrl`과 host 권한 `opener.openUrl`이 모두 있을 때만 opener 플러그인으로 시스템 브라우저에 넘기며, 나머지는 차단 진단을 남긴다. 시작 프레임, 사용자 동작, redirect 판정 URL 같은 세부는 "링크와 `window.open`" 절이 구현 단계에서 확정하기로 한 기본값이고, opener 대리 호출과 같은 WebView 열기는 아직 어느 호스트에도 구현되어 있지 않다.
- ADR 0026은 "앱 코드가 opener 전에 거부할 수 있게 할지"에 기본값을 두지 않고 정책의 작업 허용만 쓰기로 했다.

## 결정

1. 탐색, redirect, 새 창 요청마다 앱 코드를 왕복해 허용 또는 거부를 정하는 훅(`will-navigate`, `will-redirect`, `setWindowOpenHandler`에 해당하는 콜백, 이벤트 응답, 호출 가능한 판정 작업)을 지금은 공개 계약으로 추가하지 않는다. 스키마, 이벤트, 권한, 옵션과 네이티브 코드 변경은 없다.
2. Electron 훅의 용도는 아래 선언과 명령으로 대응한다. 계획은 ADR 0026의 목표 규칙이며 아직 구현되지 않았다.

   | Electron | 이 저장소 |
   | --- | --- |
   | `will-navigate`(페이지가 시작한 최상위 탐색 허용 목록) | 정책 뷰의 `origins`. 호스트 탐색 처리기가 허용 밖을 취소한다 |
   | `will-frame-navigate`(하위 프레임 탐색 제한) | 같은 `origins` 검사를 프레임 탐색에도 적용한다 |
   | `will-redirect`(redirect 단계별 제한) | redirect 단계마다 `origins`로 판정하고 허용 밖 단계는 취소한다 |
   | 앱 코드의 `loadURL` 호출 검사 | `windows.navigateWebView`의 `origins` 검사. 앱 백엔드는 호출 전에 직접 판단할 수 있다 |
   | `setWindowOpenHandler`로 새 창 거부 | 현재 구현: 새 창 요청을 모두 취소한다. 계획: 허용 origin 안 URL은 같은 WebView에서 연다(ADR 0026) |
   | 거부 뒤 `shell.openExternal`로 외부 링크 열기 | 계획: 뷰 `commands`와 host 권한이 모두 있을 때의 `plugin.opener.openUrl` 대리 호출. 앱 백엔드는 `opener.openUrl`을 직접 호출할 수 있다 |
   | `will-navigate`에서 `target` 없는 외부 `<a href>`를 가로채 `openExternal`로 열기 | 허용 밖 탐색은 취소만 되고 opener로 넘어가지 않는다. 외부 링크 열기는 `target`이 있는 링크의 대리 호출 계획이 맡는다 |
   | `mailto:`, `tel:` 링크 처리 | 차단한다(ADR 0026). `opener.openUrl`은 `http(s)`만 받아 `INVALID_ARGUMENT`로 거부하므로 Electron의 `openExternal("mailto:...")`에 대응하는 수단은 현재 없다 |
   | 새 `BrowserWindow`로 팝업 허용(`action: "allow"`) | 제공하지 않는다. 창 하나에 WebView 하나이고 필요한 별도 창은 `windows.create`로 앱이 만든다(ADR 0026) |
   | 팝업 OAuth처럼 `opener`에 의존하는 흐름 | 지원하지 않고 차단 진단을 남긴다(ADR 0026). 시스템 브라우저 인증과 앱 protocol 복귀를 쓴다 |

3. URL 경로나 쿼리로 앱이 동적으로 판정해야 하는 용도 가운데 앱 백엔드가 시작하는 탐색은 `navigateWebView` 호출 전에 백엔드가 직접 판단하는 것으로 닫는다. 페이지 안에서 시작하는 탐색의 동적 판정은 이 결정이 닫지 않는다. 그런 용도가 확인되면 먼저 정책 뷰의 선언형 규칙 확장(예: 경로 접두사, scheme 허용)을 검토하고 콜백 훅은 마지막으로 둔다.
4. 훅을 다시 검토하는 조건은 다음 모두가 확인될 때다. 선언형 확장으로 닫히지 않는 용도가 실제 앱에서 확인된다. 판정이 요청 시점의 문서 상태에 의존해 사전에 선언할 수 없다. 이 경우 별도 설계에서 판정 기한과 기본값(거부), 세션 철회와의 경합, 반복 호출 상한을 먼저 정한다.
5. 이 결정이 "훅 제공"으로 바뀌면 코어 계약 변경이므로 이 항목이 아니라 별도 설계 결정으로 다룬다.
6. 이 결정은 Windows와 macOS 호스트에 같이 적용한다.

## 근거

- 두 프레임워크가 같은 방향이다. Electron은 메인 프로세스 훅을, Tauri는 Rust 빌더 훅을 앱 백엔드에 준다. 그럼에도 지금 제공하지 않는 것은 쓰는 곳이 확인되지 않았기 때문이다. 쓰는 곳이 없는 훅으로 코어 계약을 넓히지 않고 보류한다. 훅이 맡을 용도 가운데 지금 닫힌 것은 선언된 `origins`가 맡는 허용 origin 제한, 하위 프레임과 redirect 단계 제한, 호스트 고정 동작인 새 창 차단, 백엔드가 직접 호출하는 `opener.openUrl`이다.
- 훅은 탐색마다 앱 코드를 왕복해야 하고 탐색 중 동기 판정이 필요하다. 호스트의 UI 스레드를 앱 코드 응답에 묶거나 비동기로 바꾸면 응답 전 요청의 처리 방식, 판정 기한, 기한 초과 때의 기본값(거부)이 새로 필요하다. 세션 철회와 문서 교체 중에 도착하는 판정의 경합도 새로 정의해야 한다. 허용 목록 검사 뒤에 거부만 더하는 형태로 만들면 기존 허용 목록의 보증은 유지할 수 있으나 위 비용은 남는다.
- ADR 0026 구현 뒤에 닫힐 용도: 새 창 요청(`target="_blank"` 링크와 `window.open`)의 같은 WebView 열기와 외부 URL의 opener 대리 호출(결정 6). 그 전까지 이 요청은 출처와 무관하게 차단만 된다.

## 결과

- 스키마, 이벤트, 권한, 옵션과 네이티브 코드 변경은 없다. 사용자 문서(`docs/site`)에 새 공개 API는 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.
- 시험이 확인하는 범위: `tests/lifecycle/windows-host.ts`와 `tests/lifecycle/macos-host.ts`는 허용 목록 밖 탐색 뒤에 `navigation-blocked` 로그가 1건 이상 남는지 확인한다. `tests/lifecycle/windows-webview-controls.ts`와 `tests/fixtures/macos-webview-controls/app.ts`는 `navigateWebView`가 허용 밖 origin, file, 자격 증명, javascript URL을 `PERMISSION_DENIED`로 거부하는지 확인한다. 이 결정은 새 시험을 추가하지 않는다. 새 창 요청의 취소와 `new-window-blocked` 로그, redirect 단계별 판정은 시험으로 확인하지 않았고 위 코드의 서술에 따른다.
- 후속: 차단 진단은 호스트 로그로만 남고 앱에 이벤트로 전달되지 않는다. 앱이 차단 사실을 알아야 하는 용도가 확인되면 훅이 아니라 읽기 전용 알림으로 별도 결정한다.

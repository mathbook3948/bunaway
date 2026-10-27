---
status: accepted
---

# WebView의 file: URL 로컬 파일 로드를 제공하지 않는다

결정일: 2026-10-27. 검토 기준: main `c2ce1e44`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

앱 창이 `file:` URL을 탐색 대상으로 로드하는 기능(로컬 HTML 파일이나 임의 로컬 파일 표시)을 제공할지 정해야 했다.

- Electron은 `BrowserWindow.loadFile`과 `loadURL("file://...")`로 로컬 페이지를 로드하게 안내한다. 보안 가이드는 `file://` 대신 `protocol.handle`로 만든 사용자 정의 protocol을 권고한다([ADR 0060](./0060-localhost-asset-server.md)에 같은 내용이 있다).
- Tauri는 `file:` URL 탐색을 기본 경로로 쓰지 않는다. 앱 자산은 번들 자산 origin(사용자 정의 protocol)으로 로드하고, 임의 로컬 파일은 asset protocol로 파일 경로를 표시용 URL로 바꿔 쓴다. asset protocol은 허용 범위(scope) 설정이 필요하다.
- 이 저장소의 탐색 정책은 정책 파일의 허용 origin 목록과 비교한다. 정책 스키마(`packages/protocol/src/schema.ts`)는 origin을 `http(s)://호스트[:포트]` 형태로만 받는다. `policy.json`의 `http:` origin은 설정 읽기 단계에서 거부한다(`packages/cli/src/config.ts`).
- Windows 호스트의 `originOf`(`native/windows/bun/webview.ts`)는 `https:`와 `http:` 외의 scheme에 빈 문자열을 돌려준다. 빈 문자열은 허용 목록에 있을 수 없으므로 `NavigationStarting`과 프레임 탐색의 `navigation` 처리기가 `file:` URL 탐색을 취소하고, 공개 `navigateWebView`가 호출하는 `navigateTo`도 `PERMISSION_DENIED`로 거부한다. 같은 처리기가 리디렉션에도 적용되므로 허용 origin에서 `file:`로 리디렉션하는 경로도 막힌다.
- macOS 호스트의 공개 `navigateWebView`가 호출하는 `navigate`(`native/macos/bun/webview-controls.ts`)는 scheme이 `http:`나 `https:`가 아니면 WKWebView에 넘기기 전에 `PERMISSION_DENIED`로 거부한다. 페이지 안에서 시작되는 탐색은 `decidePolicyForNavigationAction`(`native/macos/bun/webview.ts`)이 `macosOrigin`(`native/macos/bun/urls.ts`)으로 판정하며, `file:` URL은 빈 origin이 되어 취소된다.
- 로컬 UI는 `file:`이 아니라 `https://app.bunaway.local`(Windows)과 `bunaway://`(macOS, iOS)의 번들 자산으로 제공한다(ADR 0060). `native/windows/bun/desktop.ts`의 `file:` 처리는 실행 인자로 받은 파일 URL을 열 파일 경로로 바꾸는 코드이며 WebView 탐색과 관계없다.

## 결정

1. 앱 창이 `file:` URL을 탐색 대상으로 로드하는 기능, 옵션, 권한을 추가하지 않는다. 현행 거부 동작을 유지한다.
2. 로컬 UI는 번들 자산 경로로 제공한다. 외부 페이지가 필요하면 정책의 허용 origin 안에서 탐색한다.
3. 임의 로컬 파일 표시가 필요한 앱은 백엔드가 `storage`로 읽어 UI에 전달한다. 파일 경로를 표시용 URL로 바꾸는 공개 기능은 사용자 정의 protocol과 함께 [#158](https://github.com/mathbook3948/bunaway/issues/158)(`docs/TODO-windows.md`의 "로컬 파일 경로를 WebView 표시용 URL로 변환하는 공개 기능" 항목)에서 다룬다.
4. 위 대체로 만들 수 없는 용도가 확인되면 별도 결정에서 경로 범위, origin 격리, CSP 모델을 함께 정한다.

## 근거

- Electron은 제공하지만 보안 가이드는 `file://` 대신 사용자 정의 protocol을 권고하고, Tauri는 기본 경로로 쓰지 않는다. 두 프레임워크가 권고하는 방향이 같으므로 코어에 `file:` 로드를 넣지 않는다.
- `file:` origin은 same-origin 규칙, 쿠키와 저장소, `fetch`와 CSP 동작이 `http(s)` origin과 다르고 디렉터리 단위 접근이 섞인다. 모든 앱의 탐색 정책과 CSP 모델이 달라지는 보안 경계이므로 쓰는 곳이 확인되기 전에는 늘리지 않는다. `file:` 로드를 넣으면 호스트가 열 수 있는 경로 범위를 소유해야 해서, 경로 제한은 앱 명령의 책임이고 플러그인은 기능만 맡는다는 [ADR 0024](./0024-plugin-path-responsibility.md)의 방침과 맞지 않는다.
- 번들 자산과 허용 origin 탐색으로 로컬 UI를, `storage` 읽기로 로컬 파일 내용을 UI에 전달할 수 있다. `storage` 읽기는 호출당 크기 상한이 있어 큰 이미지나 영상 같은 미디어의 스트리밍 표시는 #158의 표시용 URL 변환이 나올 때까지 제공되지 않는다.

## 결과

- 스키마, 이벤트, 권한, 옵션과 네이티브 코드 변경은 없다.
- 시험이 확인하는 범위: Windows 호스트에서 도는 `tests/lifecycle/windows-webview-controls.ts`는 공개 `windows.navigateWebView`에 `file:///C:/Windows/win.ini`를 넘기면 `PERMISSION_DENIED`로 거부되고 문서 세대(`documentGeneration`)가 바뀌지 않는 것을 실제 UI Worker에서 확인한다. macOS는 실제 compiled WKWebView에서 도는 `tests/lifecycle/macos-webview-controls.ts`(`tests/fixtures/macos-webview-controls/app.ts`)가 공개 `navigateWebView`에 `file:///etc/passwd`를 넘기면 `PERMISSION_DENIED`로 거부되고 WebView 상태가 그대로인 것을 확인하고, Objective-C 호출을 대체한 Linux 계약 시험 `tests/lifecycle/macos-webview-controls.test.ts`는 `navigate`가 `file:///etc/passwd`를 `PERMISSION_DENIED`로 거부하고 WKWebView 로드를 호출하지 않는 것을 확인한다. `tests/lifecycle/macos-bun.test.ts`는 `macosOrigin`이 `file:` URL에 빈 문자열을 돌려주는 것을 확인한다. 같은 Windows 호스트에서 도는 `tests/lifecycle/windows-host.ts`는 허용 목록 밖 탐색이 취소되어 `navigation-blocked` 로그가 남고, 프레임 탐색은 `https://example.org/`가 취소되는 것을 확인한다. 시험이 없는 것은 두 플랫폼 모두 탐색 처리기(Windows는 `NavigationStarting`, macOS는 `decidePolicyForNavigationAction`)를 거쳐 오는 `file:` 탐색의 취소(페이지 내부 이동, 리디렉션, 프레임 탐색), Windows `originOf`에 `file:` URL을 넣는 단위 시험, 정책 스키마의 `file:` origin 거부다. macOS 호스트 시험(`tests/lifecycle/macos-host.ts`)은 `navigation-blocked` 로그 개수만 확인한다. 이 경로들의 거부는 위 코드의 판정에 따른다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

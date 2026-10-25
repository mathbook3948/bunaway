---
status: accepted
---

# 세션 preload, service worker, shared worker 관리 API는 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `01de66d6`.

## 배경

세션 단위 preload 스크립트의 등록, 조회, 해제와 service worker의 등록, 실행 상태, console 이벤트, service worker와 shared worker의 조회, 시작, IPC 지원 범위를 정해야 했다.

아래 외부 동작은 Electron v45.0.0, Tauri 2.12.5(wry 0.57.1), WebView2 SDK 1.0.4314.35 기준으로 공식 문서와 해당 태그의 소스를 확인한 것이며 이 저장소의 테스트로 검증한 것은 아니다.

- Electron은 `ses.registerPreloadScript`(짝으로 `unregisterPreloadScript`, `getPreloadScripts`)로 세션 단위 preload를 등록한다. 등록 대상 `type`은 `frame`과 `service-worker`이며, `frame`은 `webPreferences.preload`보다 먼저 실행된다. 이 API는 Electron 35에서 도입됐고 기존 `setPreloads`와 `getPreloads`는 그때부터 deprecated다.
- Electron의 `ses.serviceWorkers`는 실행 중인 service worker를 `getAllRunning`과 `getInfoFromVersionID`로 조회하고, `console-message`와 `running-status-changed`(실험적, starting, running, stopping, stopped) 이벤트를 제공한다. `running-status-changed`와 `getInfoFromVersionID`는 Electron 35부터이고, 실험적인 `getWorkerFromVersionID`, `startWorkerForScope`와 service worker와 주고받는 `ServiceWorkerMain` IPC도 있다. shared worker 조회 API는 없다.
- Tauri(wry)는 세션 단위 preload 등록, service worker 관리, shared worker 목록 API가 없다. 대신 웹뷰를 만들 때 지정하는 문서 단위 초기화 스크립트(`initialization_script`, `initialization_script_for_all_frames`)가 있고 worker는 대상이 아니다. service worker와 관련된 설정은 응답 헤더 `Service-Worker-Allowed`뿐이다.
- WebView2는 `ICoreWebView2Profile9`의 `ServiceWorkerManager`로 service worker 등록 목록 조회와 `ServiceWorkerRegistered` 이벤트, 등록의 `ServiceWorkerActivated`, `Unregistering`, worker의 `Destroying`과 웹 메시지 송수신을 제공하고, `SharedWorkerManager`로 shared worker 목록과 생성 이벤트를 제공한다. 호스트가 worker를 등록하거나 시작하는 API, Electron과 같은 실행 상태 값, service worker console 메시지 이벤트는 없다. service worker 안에서 `chrome.webview`를 노출하는 `AreWebViewScriptApisEnabledForServiceWorkers`는 있으나 임의 스크립트를 주입하는 API는 아니다.
- 이 저장소의 Windows 호스트는 WebView2 문서 초기화 스크립트(`AddScriptToExecuteOnDocumentCreated`)를 쓰지 않는다([ADR 0065](./0065-webview-content-settings.md)). 앱 자산은 `app.bunaway.local` origin으로 제공한다. 개발 실행은 가상 호스트에 폴더를 매핑하고, 내장 실행은 웹 리소스 요청 필터가 자산을 내려준다(`native/windows/bun/webview.ts`). 이 필터는 worker가 보낸 요청도 받지만 자산 응답용일 뿐 worker를 조회하거나 제어하는 기능이 아니다. 앱의 신뢰된 코드는 백엔드에서 실행한다. WebView는 Node/Bun에 직접 접근하지 않고([ADR 0048](./0048-frontend-node-access-and-sync-ipc.md)) 모든 호출은 백엔드 명령을 거친다.
- 문서 초기화 스크립트와 CSS 삽입, isolated world와 preload의 사용 범위(frame별 적용, 자원 정리 포함)와 context bridge와 preload의 역할 대체 범위는 `docs/TODO-windows.md`의 별도 항목이 다룬다.

## 결정

1. 세션 preload 등록, 조회, 해제 API를 제공하지 않는다. 문서 로드 시점의 주입이 필요해지면 문서 초기화 스크립트 항목에서 정의한다.
2. service worker의 등록, 실행 상태, console 이벤트 API를 제공하지 않는다.
3. service worker와 shared worker의 조회, 시작, 그리고 호스트와의 IPC를 제공하지 않는다. 앱 페이지가 웹 표준 API로 만든 worker는 WebView 안에서 그대로 동작하며 호스트는 개입하지 않는다.
4. 사용처가 확인되면 별도 결정에서 다룬다. 이 결정을 다시 열 때 정할 것은 worker 단위 origin과 권한 정의, 호스트 IPC 경계에서 worker 출처를 구분하는 규칙, 세션 폐기 때 worker 정리다.

## 근거

- 이 저장소에는 service worker나 shared worker를 관리하는 호출자가 없다. 앱 UI는 앱이 배포한 자산이고 신뢰된 코드는 백엔드가 실행하므로, 호스트가 worker 상태를 조회하거나 제어해야 하는 기능 요구가 지금은 없다.
- 세션 preload는 문서 초기화 스크립트와 역할이 겹친다. 문서 초기화 항목이 끝나지 않았으므로 먼저 같은 기능을 두 갈래로 정의하지 않는다. 적용 시점, frame별 범위, 자원 정리 규칙은 그 항목에서 한 번만 정한다. 이 근거는 preload에만 해당하며 service worker와 shared worker는 아래 두 근거로 정한다.
- worker와의 IPC는 보안 경계를 넓힌다. 호스트 브리지는 앱 페이지의 origin과 frame을 기준으로 호출을 허용한다. worker는 별도 컨텍스트라 그 출처를 구분하는 규칙이 선행되어야 하며 이 결정의 범위 밖이다.
- 두 프레임워크가 다르다. Electron은 세션 preload, service worker 조회와 이벤트, service worker IPC를 제공하고, Tauri는 제공하지 않는다. 이 결정은 Tauri와 같은 쪽이다. WebView2가 worker 조회와 이벤트의 기반 API를 제공하므로 나중에 구현할 수는 있지만, Electron의 실행 상태 값과 console 이벤트는 WebView2로 대응할 수 없어 두 플랫폼의 계약을 같게 맞출 수 없다. 사용처가 없고 기능마다 보안 경계 정의가 선행되어야 하므로 코어는 작게 두는 쪽을 따랐다. 같은 구역의 결정([ADR 0065](./0065-webview-content-settings.md), [ADR 0070](./0070-webview-browser-extensions.md))과 같은 방침이다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 세 항목을 완료로 표시하고 이 결정을 참조한다.

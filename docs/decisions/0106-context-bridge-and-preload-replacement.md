---
status: accepted
---

# context bridge와 preload는 SDK 클라이언트와 명령 정책으로 대체하고 같은 이름의 기능은 제공하지 않는다

결정일: 2026-10-29. 검토 기준: main `6bee970a`.

## 배경

Electron에서 넘어오는 앱이 preload 스크립트와 `contextBridge`로 하던 일을 이 저장소에서 어떻게 해야 하는지, 무엇은 대신하지 않는지 한 문서로 정해야 했다.

- Electron의 preload는 창마다 `webPreferences.preload`로 지정하는 스크립트이며 페이지 스크립트보다 먼저 실행된다. `contextIsolation`은 기본값이 `true`라서 preload는 페이지와 분리된 JavaScript 컨텍스트에서 실행되고, `contextBridge.exposeInMainWorld`로 고른 API만 페이지의 `window`에 노출한다. 보안 지침은 `ipcRenderer` 같은 객체를 통째로 노출하지 말고 기능별로 좁은 함수만 노출하라고 한다.
- Tauri에는 preload와 context bridge 개념이 없다. 프런트엔드는 `invoke`(Promise)와 이벤트로만 Rust 명령에 닿고, 원격 출처의 요청과 플러그인 명령은 capability 검사를 받는다. 문서 로드 시점에 코드를 넣는 수단은 웹뷰를 만들 때 지정하는 `initialization_script`이며 앱이 직접 쓰는 별도 기능이다.
- 위 Electron(v45)과 Tauri(2.12.5) 서술은 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.
- 이 저장소의 WebView는 네이티브가 관찰한 origin과 frame으로 명령 권한을 검사하는 웹 메시지 브리지 하나로만 백엔드에 닿는다([ADR 0048](./0048-frontend-node-access-and-sync-ipc.md)). 앱이 임의 함수를 `window`에 노출하는 API는 없다. `@bunaway/client-sdk`는 이 브리지 위에서 동작하는 클라이언트이고, 명령과 이벤트의 입력, 출력 타입은 앱 정의에서 `CommandsOf`, `EventsOf`로 만든다(`packages/plugin-api/src/index.ts`). 클라이언트는 `isBunaway()`로 브리지 유무만 확인할 수 있으며 그 결과는 UI 힌트일 뿐 권한 근거가 아니다.
- [ADR 0086](./0086-webview-workers-and-session-preload.md)은 세션 preload 등록 API를 제공하지 않기로 하면서 context bridge와 preload의 역할 대체 범위는 별도 항목이 다루도록 남겼다. 문서 초기화 script와 isolated world, preload의 사용 범위는 `docs/TODO-windows.md`의 [#158](https://github.com/mathbook3948/bunaway/issues/158) 항목이 다룬다.

## 결정

1. 렌더러에 안전한 API를 노출하는 용도(`exposeInMainWorld`)는 앱 정의의 명령과 이벤트 계약, 그리고 SDK 클라이언트로 대신한다. Electron에서 preload에 두던 "main 프로세스에 요청하는 좁은 함수"는 백엔드 명령으로 옮기고, 프런트엔드는 클라이언트로 그 명령을 호출한다. 호출 가능 여부는 정책의 `host.permissions`와 `commands`가 정한다.
2. 앱이 임의 함수나 객체를 페이지의 `window`에 노출하는 API(`contextBridge` 대체)를 제공하지 않는다. 노출 이름 규칙도 현재 두지 않는다. 노출 지점은 웹 메시지 브리지 하나다.
3. 브리지(`window.chrome.webview`)가 설치된 frame에서는 호출마다 네이티브가 origin과 frame 권한 검사, 스키마 검증을 거친다. Electron의 `contextIsolation`이 막으려는 "페이지 스크립트가 특권 객체를 직접 쥐는 상황"은 이 검사로 대신하므로, 이 결정에서는 앱이 페이지 전역에 특권 객체를 노출하지 않는다(결정 2, ADR 0048). 분리된 컨텍스트(isolated world)의 제공 여부는 #158 항목이 정하며 이 결정은 정하지 않는다.
4. 창마다 지정하는 preload 파일(`webPreferences.preload` 대체)은 현재 제공하지 않는다. preload에서 하던 일은 용도에 따라 아래로 옮긴다.
   - main 프로세스에 요청하는 함수: 백엔드 명령과 SDK 클라이언트(결정 1).
   - 시작 시점에 필요한 값: 앱이 시작 명령의 결과를 기다린다(ADR 0048 결정 2).
   - 문서가 로드되기 전 시점에 페이지 전역을 바꾸거나 값을 주입하는 코드: 앱이 쓸 수 있는 수단이 아직 없다(호스트는 브리지 자체를 문서 시작 시점에 설치한다). #158의 문서 초기화 script 항목이 정의할 때까지 지원하지 않으며 이 결정은 그 항목의 범위를 제한하지 않는다.
5. 코드, 공개 계약, 스키마, 권한, 이벤트 변경은 없다.

## 다시 열 조건

사용처가 확인됐을 때 다음을 정한다.

- 주입 시점(문서 생성 시점, DOM 준비 시점)과 주입 단위(창, 세션).
- frame별 범위(최상위 frame만, 하위 frame 포함)와 하위 frame에서의 권한.
- 문서 초기화 script가 브리지 쪽에 이름을 노출하게 되면 그 이름 규칙과 충돌 처리.
- 주입된 코드가 페이지 전역과 분리돼야 하는지(isolated world 여부)는 #158 항목에서 정한다.

## 근거

- Tauri는 preload와 context bridge 없이 `invoke`와 이벤트만 두고, Electron은 `contextBridge`로 좁은 함수만 노출하라고 권한다. 두 방식의 목적(프런트엔드가 닿는 표면을 좁게 유지)은 같고, 이 저장소는 표면을 브리지 하나와 타입이 있는 명령으로 고정해 같은 목적을 달성한다. 두 프레임워크가 다른 부분(preload 스크립트 존재)은 코어를 작게 두고 기능을 플러그인과 앱 명령에 맡기는 쪽을 따라 Tauri와 같은 쪽을 택했다.
- 노출 API를 앱마다 정의하게 하면 앱마다 새 신뢰 경계가 생기고, 플러그인과 SDK가 모든 앱에서 같은 경계를 전제로 쓰이지 못한다([ADR 0048](./0048-frontend-node-access-and-sync-ipc.md)의 같은 근거).
- 쓰는 곳이 없다. 현재 앱과 플러그인 어디에도 문서 로드 전 주입이나 페이지 전역 노출이 필요한 용도가 확인되지 않았다.
- 문서 초기화 항목이 끝나지 않았으므로 같은 기능을 두 갈래로 정의하지 않는다([ADR 0086](./0086-webview-workers-and-session-preload.md)의 같은 근거).

## 결과

- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.
- 앱 개발자는 Electron preload의 용도별 이전 위치를 위 결정 4에서 찾을 수 있다.
- 문서 로드 전 주입이 필요한 앱은 #158 항목이 끝날 때까지 지원되지 않는다.

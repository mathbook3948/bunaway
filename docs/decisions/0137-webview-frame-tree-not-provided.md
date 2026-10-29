---
status: accepted
---

# WebView frame tree 조회, frame URL과 origin 조회, frame별 작업은 제공하지 않는다

결정일: 2026-10-29. 검토 기준: main `32693a1a`.

## 배경

앱이 WebView 안의 iframe 구조를 열거하거나, 각 frame의 URL과 origin을 조회하거나, frame 하나를 대상으로 작업하는 API를 제공할지 정해야 했다.

- Electron은 `webContents.mainFrame`과 `WebFrameMain`(`frame.frames`, `frame.framesInSubtree`, `frame.url`, `frame.origin`, `frame.parent`, `frame.top`)으로 frame tree를 열거한다. `frame.executeJavaScript`, `frame.send`, `frame.ipc`로 frame 하나를 대상으로 실행과 메시지 전달도 한다. frame은 탐색이나 제거로 사라질 수 있어 `isDestroyed()` 확인이 필요하다.
- Tauri는 웹뷰 하나를 단위로 다루며 frame을 열거하거나 지정하는 API가 없다. 웹뷰 단위로 `eval`과 문서 초기화 스크립트(`initialization_script`, `initialization_script_for_all_frames`)를 제공하고, 하위 frame에 적용할지는 초기화 스크립트의 옵션으로만 고른다. 원격 출처의 명령 호출은 capability가 URL 패턴으로 검사한다.
- 위 Electron(v45)과 Tauri(2.12.5) 서술은 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.
- 이 저장소의 WebView는 호출이 도착한 frame의 origin과 frame 권한을 네이티브가 관찰해 호출마다 검사하는 웹 메시지 브리지 하나로만 백엔드에 닿는다([ADR 0048](./0048-frontend-node-access-and-sync-ipc.md), [ADR 0106](./0106-context-bridge-and-preload-replacement.md) 결정 3). 앱이 frame을 열거하거나 지정하는 공개 계약은 없다.
- [ADR 0086](./0086-webview-workers-and-session-preload.md)과 ADR 0106은 frame별 적용 범위를 JavaScript 실행, 문서 초기화 script, isolated world를 다루는 [#158](https://github.com/mathbook3948/bunaway/issues/158) 항목으로 넘겼다.

## 결정

1. WebView의 frame tree 열거, frame의 URL과 origin 조회, frame 하나를 대상으로 하는 작업(JavaScript 실행, 메시지 전달, 초기화 script 적용)을 제공하지 않는다. 같은 이름과 같은 역할의 `WebFrameMain` 대응 API를 만들지 않는다.
2. 신뢰 경계는 지금처럼 브리지가 호출마다 도착 frame의 origin과 frame 권한으로 검사하는 방식으로 유지한다. 앱 백엔드가 frame 목록이나 frame 식별자를 알 필요가 없도록 한다.
3. 페이지 안의 iframe 접근은 페이지 자신의 웹 표준 API(`window.frames`, `postMessage`)로 처리한다. 같은 origin의 frame끼리는 페이지 스크립트가 직접 다루고, 다른 origin의 frame과는 `postMessage`로 통신한다. 백엔드가 필요한 일은 브리지를 통한 명령 호출로 한다.
4. 이 결정은 JavaScript 실행 계약, 문서 초기화 script와 CSS 삽입, isolated world와 preload(`docs/TODO-windows.md` 694행부터 696행)를 정하지 않는다. 이 항목들은 #158에 그대로 남는다.
5. 코드, 공개 계약, 스키마, 권한, 이벤트, 네이티브 코드 변경은 없다. 모든 앱의 보안 경계도 바꾸지 않는다.

## 다시 열 조건

다음이 확인되면 다시 정한다.

- frame별 작업이 필요한 사용처가 앱이나 플러그인에서 확인됐을 때.
- #158의 JavaScript 실행 계약이 확정돼 frame을 지정할 대상이 생겼을 때.
- 하위 frame에서의 권한 모델(최상위 frame만 허용할지, 하위 frame 포함 여부, 탐색 뒤 frame 식별자의 수명)이 정해졌을 때. ADR 0106의 "frame별 범위" 항목과 함께 정한다.

## 근거

- Electron은 frame tree를 열거하고 frame별 작업을 제공하지만 Tauri는 웹뷰 하나만 다룬다. 두 프레임워크가 다른 부분은 코어를 작게 두고 기능을 플러그인과 앱 명령에 맡기는 쪽을 따라 Tauri와 같은 쪽을 택했다.
- 이 저장소는 신뢰 판단을 frame 열거가 아니라 호출 시점의 origin과 frame 검사로 풀었으므로 앱이 frame 목록을 알아야 할 이유가 없다. 목록을 열어 주면 frame 식별자의 수명(탐색, 제거, 교체)과 하위 frame 권한이라는 새 계약이 모든 앱에 생긴다.
- frame 열거는 frame 하나에 작업을 보낼 수 있을 때 의미가 있다. 그 작업(JavaScript 실행)의 계약은 #158에서 아직 정해지지 않았고, 먼저 열거만 정의하면 이후 계약을 제한한다([ADR 0086](./0086-webview-workers-and-session-preload.md)과 같은 근거).
- 쓰는 곳이 없다. 현재 앱과 플러그인 어디에도 frame 구조나 frame별 작업이 필요한 용도가 확인되지 않았다.

## 결과

- `docs/TODO-windows.md`의 해당 항목을 결정 완료로 표시하고 이 결정을 참조한다. 694행부터 696행은 그대로 둔다.
- ADR 0106의 다시 열 조건 "frame별 범위"에 이 결정을 연결한다.
- Electron에서 `WebFrameMain`으로 frame을 다루던 앱은 위 결정 3의 웹 표준 API와 백엔드 명령으로 옮긴다. frame 하나를 대상으로 백엔드가 직접 코드를 실행하는 용도는 #158이 끝날 때까지 지원되지 않는다.

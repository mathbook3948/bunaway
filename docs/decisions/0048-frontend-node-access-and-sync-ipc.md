---
status: accepted
---

# WebView에 Node/Bun 직접 접근과 동기 IPC를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `f295a967`.

## 배경

Electron의 `nodeIntegration`처럼 WebView 안의 스크립트가 Node/Bun API를 직접 쓰게 하는 옵션과, `ipcRenderer.sendSync`처럼 호출이
끝날 때까지 렌더러를 멈추는 동기 IPC를 제공할지 정해야 했다.

- Electron의 `nodeIntegration`은 기본값이 `false`이고 `contextIsolation`은 기본값이 `true`다. 켜면 페이지 스크립트가
  Node API를 그대로 쓰므로 XSS 한 건이 곧 사용자 계정 권한의 코드 실행이 된다. 공식 보안 지침도 원격 콘텐츠를 여는 창에서
  켜지 말라고 한다. `ipcRenderer.sendSync`는 응답이 올 때까지 렌더러를 멈추며, 문서도 비동기 `invoke`를 권장한다.
- Tauri는 WebView에 Node 같은 런타임을 주지 않는다. 프런트엔드는 `invoke`(Promise)와 이벤트로만 Rust 명령에 닿고,
  명령은 capability로 허용한 것만 호출된다. 동기 호출 경로는 없다.
- 이 저장소의 WebView는 네이티브가 관찰한 origin과 frame으로 명령 권한을 검사하는 웹 메시지 브리지로만 백엔드에 닿는다.
  Windows 호스트는 WebView2 host object를 노출하지 않고(`AddHostObjectToScript` 미사용) 웹 메시지(`PostWebMessageAsJson`)만 쓴다.
  요청은 JSON이며 Promise로 완료된다. [PRD](../PRD.md) 1절은 프런트엔드가 등록된 명령과 이벤트만 사용하고 Bun, Node.js,
  파일 시스템, 임의 네이티브 함수에 직접 접근하지 않는다고 정하며, 5절은 WebView가 공격받을 수 있다고 가정하고 기본 거부
  권한 모델을 정한다.

## 결정

1. WebView에서 Node/Bun을 직접 쓰게 하는 옵션(`nodeIntegration` 대체)을 제공하지 않는다. 신뢰 코드는 백엔드에서 실행하고,
   프런트엔드는 등록한 명령으로 호출한다. Node/Bun이 필요한 기능은 앱 명령이나 플러그인으로 만든다.
2. 동기 IPC를 제공하지 않는다. 모든 명령 호출은 Promise로 완료되고 deadline과 취소를 따른다. 페이지 로드 시점에 값이 필요하면
   앱이 시작 명령의 결과를 기다리거나, 백엔드가 문서 초기화 시점에 값을 주입하는 별도 기능(문서 초기화 script 항목)으로 다룬다.
3. 두 항목 모두 옵션이나 권한으로도 열지 않는다. 앱마다 켜고 끌 수 있는 스위치는 위 보안 가정을 앱마다 다시 증명하게 만들고,
   플러그인과 SDK가 모든 앱에서 같은 경계를 전제로 쓰이지 못하게 한다.
4. 선택 Chromium 렌더러(CEF 등)를 연결하는 경우에도 같은 경계를 유지한다. 렌더러 능력으로 Node 접근을 드러내지 않는다.

## 근거

- Tauri는 처음부터 제공하지 않고, Electron은 기본값을 꺼 두며 보안 지침이 쓰지 말라고 한다. 같은 방향이므로 제공하지 않는
  쪽을 따른다.
- 직접 접근은 브리지의 origin, frame, 명령 권한 검사와 스키마 검증을 모두 우회한다. 이 저장소의 권한 모델은 그 경계 위에 있다.
- 동기 호출은 UI 스레드를 멈춘다. 백엔드가 별도 프로세스(Windows)나 Worker(macOS)이고 명령에 deadline이 있으므로, 동기로
  기다리면 백엔드 지연이 곧 창 멈춤이 된다. 요청마다 deadline과 취소를 두는 프로토콜 설계와도 맞지 않는다.
- 쓰는 곳이 없다. 현재 명령과 플러그인 어디에도 동기 응답이 필요한 용도가 확인되지 않았다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 두 항목과 `docs/TODO-macos.md`의 같은 항목을 완료로 표시하고 이 결정을 참조한다.
- 용도가 확인되면 별도 결정에서 다룬다. 이때는 동기 호출이 아니라 문서 초기화 시점 값 주입 같은 비동기 설계를 먼저 검토한다.

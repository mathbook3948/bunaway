---
status: accepted
---

# UI와 백엔드 사이에 MessagePort와 transferable 자원을 제공하지 않는다

결정일: 2026-10-27. 검토 기준: main `d3d2bbaa`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

UI(WebView)와 앱 백엔드 사이에 `MessagePort`, `MessageChannel`, transfer list로 넘기는 자원(ArrayBuffer 소유권 이전, `ReadableStream` 등)에 해당하는 공개 기능을 제공할지 정해야 했다.

- Electron은 `MessageChannelMain`으로 만든 포트를 `webContents.postMessage(channel, message, [port])`로 렌더러에 넘기고, 렌더러는 `ipcRenderer.postMessage`로 포트를 메인에 넘긴다. utility process와도 포트를 주고받는다. `ipcMain.handle`에는 호출자 검사가 내장되어 있지 않고 앱 코드가 `senderFrame` 등으로 검사한다. 포트로 넘어간 메시지는 그 handler를 지나지 않으므로 앱이 포트 메시지마다 따로 검사해야 한다.
- Tauri 2는 JSON 직렬화 가능한 `invoke` 명령과 이벤트, 순서가 있는 단방향 스트림인 `Channel`을 제공한다. MessagePort나 transferable 자원을 Rust와 WebView 사이에 넘기는 API는 찾지 못했다. 큰 바이너리는 `Response`로 raw 바이트를 돌려주거나 custom protocol로 푼다.
- 이 저장소의 UI와 백엔드 경계는 프로토콜 프레임(JSON 명령, 응답, 이벤트)이다. WebView 브리지는 프레임 하나를 `postMessage`로 보내고(구조적 복제 값, Android text bridge에서는 JSON 텍스트), SDK는 보내기 전에 `parseMessage`로 프레임 형식을 확인한다(`packages/client-sdk/src/webview.ts`). 이 SDK 검사는 페이지 안에서 실행되므로 보안 경계가 아니다. 보안 경계의 검증은 호스트가 한다. Windows 호스트는 최상위 문서의 메시지를 받아 렌더러에서 얻은 source로 검사하고(`native/windows/bun/webview.ts`), Android는 쓰기 스레드에서 JSON, 크기, 스키마, 방향과 hello를 검사한다(`native/android/README.md`). 호스트는 프레임을 관찰한 뷰, 세션, origin, frame에 묶어 호출 컨텍스트를 발급하고([ADR 0002](./0002-host-owned-call-context.md)), 명령은 deadline과 취소를 가진다([ADR 0048](./0048-frontend-node-access-and-sync-ipc.md)).
- 저장소에는 이미 내부 MessagePort 사용이 있다. `core-and-runtime.mdx`의 `Channel.poll()`은 호스트와 runtime Worker 사이 전송이고 iOS Worker도 같은 방식이다. Android fallback은 문서 전용 MessagePort를 연결하되 그 포트로 들어온 입력을 호스트가 같은 프레임 검증(JSON, 크기, 스키마, 방향, hello)을 거쳐 처리한다. 이들은 호스트가 소유한 전송 수단이며 앱 코드에 포트를 노출하지 않는다. 이 결정은 이들을 바꾸지 않는다.

## 결정

1. UI와 백엔드 사이에 MessagePort, MessageChannel, transfer list로 자원을 넘기는 공개 API를 추가하지 않는다. 프로토콜 프레임 형식, 브리지, SDK, 권한 정책은 바꾸지 않는다.
2. 아래 대체 경로를 안내한다.

| 하려는 일 | 경로 |
| --- | --- |
| 요청과 응답 | 등록한 명령을 UI가 `invoke`로 호출한다. |
| 백엔드에서 UI로 알림 | `context.events.emit`(broadcast 또는 view ID 지정) |
| 백엔드가 UI의 응답을 원할 때 | 이벤트로 알리고 UI가 명령을 호출한다([ADR 0063](./0063-backend-to-ui-request.md)). |
| 연속 결과, 대용량 데이터, binary payload | [#81](https://github.com/mathbook3948/bunaway/issues/81)의 stream과 binary 계약에서 다룬다. 그 전에는 JSON 명령과 이벤트로 청크를 나누고 바이너리는 base64 같은 텍스트 인코딩으로 싣는다(크기 증가와 호출당 크기 한도가 따른다). |
| UI의 파일 내용을 백엔드로 | 페이지가 `File`을 `arrayBuffer()`나 `stream()`으로 읽어 위 방식으로 명령에 싣는다. 드롭된 `File`과 OS 경로를 잇는 API는 없다([ADR 0089](./0089-webview-file-drop-and-drag-out.md)). |
| UI 안의 Worker 사이 포트 | 페이지의 표준 Web API(`MessageChannel`)를 그대로 쓴다. 호스트가 관여하지 않는다. |

3. UI 쪽 표준 `MessageChannel`, `SharedWorker`, `Worker`는 WebView 안에서 동작하며 이 결정과 무관하다([ADR 0086](./0086-webview-workers-and-session-preload.md)).
4. native resource handle의 생성, 참조, 해제 계약은 별개 항목이며 이 결정에 포함하지 않는다.
5. 포트가 꼭 필요한 사용처가 확인되면 #81의 stream 계약을 먼저 본 뒤 별도 결정에서 다시 판단한다. 이때 호스트의 프레임 검증, 호출 컨텍스트, 권한 정책, 문서 교체와 종료 시 수명 정리를 포트에 어떻게 적용할지를 계약으로 먼저 정한다.

## 근거

- Electron은 포트를 제공하고 Tauri는 제공하지 않는다. 둘이 다르므로 코어를 작게 두는 쪽을 따른다.
- 포트가 열리면 이후 메시지는 호스트의 프레임 검증, 호스트가 발급하는 호출 컨텍스트, 권한 정책, deadline과 취소를 거치지 않는 두 번째 경로가 된다. 포트를 받은 쪽이 문서 교체나 세션 종료 뒤에도 메시지를 보낼 수 있어 수명 정리도 별도로 설계해야 한다.
- 명령, 이벤트, 앞으로의 stream 계약이 같은 요구를 기존 검증 경계 안에서 해결한다. 이 저장소에서 포트를 요구하는 사용처는 없다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 결정 완료로 표시하고 이 결정을 참조한다.

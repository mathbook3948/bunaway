---
status: accepted
---

# 백엔드가 UI에 요청하고 결과를 받는 API를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `b41b82b9`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

앱 백엔드가 WebView의 UI 코드를 호출하고 그 반환값을 Promise로 받는 요청/응답 API를 제공할지 정해야 했다.

- Electron의 `webContents.send`는 렌더러로 보내는 단방향 메시지다. 응답을 받는 `ipcRenderer.invoke`와 `ipcMain.handle`은
  렌더러가 메인을 호출하는 방향뿐이다. 메인이 렌더러의 값을 얻는 방법은 `webContents.executeJavaScript`(결과 Promise)와,
  렌더러가 별도 채널로 답을 보내는 방식이다.
- Tauri 2의 `emit`, `emit_to`는 단방향 이벤트이고 창 쪽에서 `listen`으로 받는다. `Webview::eval`은 스크립트를 실행할 뿐 결과를
  돌려주지 않는다. Tauri 2.11부터 `eval_with_callback`이 평가 결과를 JSON 문자열로 Rust 콜백에 넘기지만, 이는 임의 스크립트의
  평가 결과이고 JS 핸들러를 호출하는 요청/응답이 아니다. 핸들러 호출형 IPC는 찾지 못했다. 응답이 필요하면 UI가 `invoke`로 명령을 다시 호출한다.
- 이 저장소의 `context.events.emit`은 broadcast 또는 정확한 view ID로 보내는 단방향 알림이며 UI 콜백의 완료나 반환값을 기다리지
  않는다([events.emit](../site/src/content/docs/reference/backend/events.mdx)). UI에서 백엔드로는 등록한 명령을 Promise로 호출한다.
- 백엔드가 UI 스레드와 분리되어 있어 UI 응답을 기다리는 호출은 UI의 로드, 숨김, 탐색, 종료 상태에 백엔드 작업이 묶인다.
  명령은 deadline과 취소를 가지며([ADR 0048](./0048-frontend-node-access-and-sync-ipc.md)),
  기한이 끝나거나 취소된 요청의 늦은 응답은 폐기된다([invoke](../site/src/content/docs/reference/client/invoke.mdx)).
- UI 코드를 백엔드가 임의로 실행하는 경로(`executeJavaScript` 대응)는 별도 항목(신뢰된 앱 백엔드의 JavaScript 실행)으로 남아 있다.
  이 결정은 그 항목을 대신하지 않는다.

## 결정

1. 백엔드가 UI의 핸들러를 호출해 반환값을 받는 요청/응답 API를 추가하지 않는다.
2. 백엔드가 UI의 입력이나 결정이 필요하면 이벤트로 요청을 알리고 UI가 백엔드에 등록된 명령을 호출해 결과를 돌려준다. 요청 ID로 짝을 맞추는
   일은 앱 코드가 정한다. 백엔드에서 필요한 값은 가능하면 UI가 먼저 명령으로 보내거나, 백엔드가 읽기 명령으로 가져가는
   방향으로 설계한다.
3. 이 결정은 채널 또는 stream 전송, binary payload, 문서 초기화 script 같은 별도 항목을 닫지 않는다.
4. 쓰는 곳이 확인되면 별도 결정에서 다룬다. 이때 대상 view 선택, 수신자 부재, deadline, 취소, 문서 교체 시 늦은 응답의 폐기를
   계약으로 먼저 정한다.

## 근거

- Electron과 Tauri 모두 렌더러의 핸들러를 호출해 반환값을 받는 요청/응답 IPC를 제공하지 않고, 이벤트와 반대 방향 명령의
  조합으로 푼다. 같은 방향이므로 제공하지 않는 쪽을 따른다. `executeJavaScript`와 Tauri의 `eval_with_callback`은 임의 스크립트 실행이라 별개 항목이다.
- 요청/응답은 수신자가 없거나(창을 만들기 전, 숨김, 탐색 중) 응답하지 않는 UI를 백엔드가 기다리게 만들고, 그 시간 제한과 취소 규칙을
  모든 플러그인과 앱이 같이 지켜야 한다. 이벤트와 명령으로 풀면 각 방향이 기존 deadline, 권한, 스키마 검증을 그대로 쓴다.
- 쓰는 곳이 없다. `plugins`, `packages`, `examples`에서 UI의 반환값을 기다리는 호출을 찾았으나 없었다(검토 기준 커밋에서 이벤트 발행과 `executeJavaScript` 계열 이름을 검색).

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

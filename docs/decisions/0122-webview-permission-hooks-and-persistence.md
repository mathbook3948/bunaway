---
status: accepted
---

# WebView 권한 check와 request 훅, 권한 결정 영속화를 제공하지 않는다

결정일: 2026-10-28. 검토 기준: main `58ddd4ee`.

## 배경

WebView 안 페이지는 카메라, 마이크, 위치, 알림, 클립보드 읽기 같은 권한을 요청한다. 임베더는 이 요청과 권한 조회에 끼어들어
origin과 frame별로 허용하거나 거부할 수 있고, 그 결정을 저장하고 조회하고 지울 수도 있다. bunaway가 이런 훅과 영속화를 코어와
플러그인의 공개 계약으로 제공할지 정해야 했다.

- Electron은 세션의 `setPermissionRequestHandler`로 요청마다 앱이 허용 여부를 콜백으로 돌려주고,
  `setPermissionCheckHandler`로 페이지의 권한 조회(`navigator.permissions` 등)에 답한다. 핸들러는 요청 origin과 frame 정보를
  받는다. Electron 보안 문서는 핸들러가 없으면 권한 요청이 자동으로 승인된다고 설명하므로, 앱이 핸들러로 직접 막아야 한다. 결정의 영속화나 초기화는 이 두 핸들러 자체에는 없다.
- Tauri는 시스템 WebView를 쓰며, 권한 요청을 앱이 처리하는 공개 API를 주지 않는다. 각 플랫폼 WebView의 기본 동작에 맡기며,
  필요한 앱은 Rust 명령이나 플러그인에서 직접 접근한다.
- WebView2는 `ICoreWebView2::add_PermissionRequested`로 요청마다 앱이 상태를 정하게 하고
  `ICoreWebView2PermissionRequestedEventArgs3::put_SavesInProfile`로 결정을 프로필에 저장할지 정한다.
  권한 종류는 [ADR 0107](./0107-webview-device-chooser-apis.md)에 정리한 목록과 같다. 공개 문서 기준 서술이며 기준 SDK 버전별
  차이는 확인하지 못했다.
- 이 저장소의 Windows 호스트는 모든 WebView2 권한 요청을 `Deny`로 설정하고 `SavesInProfile`을 꺼 결정을 저장하지 않으며
  `permission-request-denied`를 기록한다(`native/windows/bun/webview.ts`). 권한 종류, origin, frame으로 구분하지 않는다. 페이지 fullscreen은 이 핸들러를 거치지 않고 `ContainsFullScreenElementChanged`로 창에 연결된다.
  macOS 호스트는 `requestMediaCapturePermissionForOrigin` 델리게이트로 카메라와 마이크 미디어 캡처 요청만 같은 로그 이름으로 거부하며, 위치나 알림 같은 다른 권한을 처리하는 델리게이트는 없다. 아래 거부 기본값은 Windows 호스트 기준이다.
- WebView 명령 호출은 네이티브가 관찰한 origin과 frame으로 권한을 검사하는 웹 메시지 브리지로만 백엔드에 닿는다
  ([ADR 0048](./0048-frontend-node-access-and-sync-ipc.md)).
- 위 Electron, Tauri, WebView2 서술은 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

## 결정

1. 권한 check 훅, request 훅, origin과 frame별 허용과 거부를 코어와 플러그인의 공개 연산, 이벤트, 설정으로 제공하지 않는다.
2. 권한 결정의 영속화, 조회, 초기화를 제공하지 않는다. 호스트가 결정을 저장하지 않으므로 저장소에 조회하거나 지울 상태가 없다.
3. 호스트의 기존 동작을 기준선으로 유지한다. Windows 호스트는 WebView2 권한 요청을 모두 거부하고 결정을 프로필에 저장하지 않는다. 이 거부 기본값은
   모든 앱의 보안 경계이며 이 결정에서 바꾸지 않는다.
4. 페이지 권한이 필요한 앱은 백엔드 코드나 앱이 직접 만든 플러그인에서 장치, 위치, 알림, 클립보드에 접근하고, 프런트엔드는
   등록한 명령과 이벤트로 결과를 받는다. 저장소는 이를 위한 새 연산을 만들지 않는다. 앱이 제공하는 접근 경로는 명령 권한 안에 둔다.
5. 새 공개 연산, 이벤트, 권한 이름, 설정, `UNSUPPORTED` 항목을 만들지 않는다. 훅을 제공하는 방향으로 바꾸려면 코어 계약과 모든
   앱의 보안 경계가 바뀌므로 별도 설계 결정으로 다룬다.
6. `docs/TODO-windows.md`의 geolocation, notification, clipboard 항목은 Windows 호스트가 권한 요청을 모두 거부하는 한
   페이지 권한으로 연결하지 않는다는 결론이 된다. file system access의 파일 선택 범위는 권한 요청이 아니고,
   display capture, fullscreen, pointer lock, wake lock은 공개 문서 기준 WebView2 권한 종류에 없으며 fullscreen은 별도 경로로
   처리된다. 이 항목들은 이 결정이 결론을 내리지 않는다. 이 결정은 그 행의
   체크박스를 바꾸지 않는다. 각 행은 개별 API의 결정이나 앱 경로를 확인한 뒤 닫는다.
7. 카메라와 마이크의 OS 권한, MIDI와 센서와 protected media, WebAuthn, WebRTC는 이 결정에서 다루지 않는다.

## 근거

- Electron과 Tauri가 다르다. Electron의 핸들러 계약은 Chromium 세션에 기대고, Tauri는 훅을 공개하지 않는다. 쓰는 곳이 확인되지
  않은 상태에서 코어를 작게 두는 쪽을 따라 Tauri 쪽으로 정했다.
- Windows 호스트는 종류와 origin 구분 없이 거부하므로, 훅을 열면 모든 앱의 기본 보안 경계가 바뀌고 요청 origin과 frame을 신뢰하는
  규칙, 결정 저장소, 수명 규칙을 코어가 유지해야 한다. 페이지 스크립트가 공격받을 수 있다는 가정에서 허용 판단을 페이지 요청에
  두면 명령 권한 검사를 거치지 않는 경로가 생길 수 있다. 권한이 필요한 접근은 신뢰 코드가 맡는 편이 이 저장소의 권한 모델과 맞다.
- 호스트가 결정을 저장하지 않으므로 영속화 계약은 먼저 저장 정책과 사용자 확인 UI를 정해야 하며, 이는 훅 결정에 종속된다.
- 호스트 코드와 권한 경계를 바꾸지 않는다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 권한 check와 request 훅 항목, 권한 결정 영속화 항목을 결정 완료로 바꾸고 이 결정을 참조한다.
- 용도가 확인되거나 선택 Chromium 렌더러가 생기면 별도 결정에서 훅을 다시 검토한다.

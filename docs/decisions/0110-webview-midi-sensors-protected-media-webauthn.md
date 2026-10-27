---
status: accepted
---

# WebView의 MIDI, 센서, 보호 미디어 권한과 WebAuthn 선택을 제공하지 않는다

결정일: 2026-10-27.

## 배경

WebView 안 페이지는 Web MIDI, Generic Sensor(가속도계, 자이로, 방향 등), 암호화 미디어 확장(EME, DRM 재생),
WebAuthn(passkey, 보안 키)을 쓸 수 있다. 이 중 일부는 임베더의 권한 요청을 거칠 수 있고, WebAuthn은 authenticator와
계정을 고르는 브라우저 또는 OS 대화상자를 거칠 수 있다. 임베더가 이 요청을 대신 허용하거나 거부하고 선택을 처리하는
연산을 줄 수 있다. 어느 API가 어느 경로를 거치는지는 아래에 확인한 것과 확인하지 못한 것을 나눠 적는다.
bunaway가 이런 연산을 제공할지 정해야 했다.

- Electron은 Chromium을 내장하므로 세션의 `setPermissionRequestHandler`와 `setPermissionCheckHandler`에서 권한 종류별로
  허용 여부를 정한다. 공개 문서의 권한 이름에 `midi`, `midiSysex`, `mediaKeySystem`이 있다. 센서 권한 이름과 WebAuthn의
  Windows 동작(어떤 대화상자가 뜨는지, 앱이 가로챌 수 있는지)은 이번에 확인하지 못했다.
- Tauri는 시스템 WebView를 쓴다. 이 권한 요청과 WebAuthn 선택을 앱이 처리하는 공개 API가 있는지는 이번에 확인하지 못했다.
- WebView2의 `ICoreWebView2PermissionRequestedEventArgs`가 구분하는 권한 종류(`COREWEBVIEW2_PERMISSION_KIND`, 기준 SDK 버전은
  확인하지 못했고 공개 문서에 나온 목록 기준)는 마이크, 카메라, 위치, 알림, 기타 센서, 클립보드 읽기, 여러 자동 다운로드,
  파일 읽기와 쓰기, 자동 재생, 로컬 글꼴, MIDI 시스템 전용 메시지, 창 관리다. 센서와 MIDI 시스템 전용 메시지는 종류가 있고,
  보호 미디어(EME)와 WebAuthn은 목록에 없다. 시스템 전용 메시지를 쓰지 않는 기본 MIDI 접근이 이 이벤트를 거치는지는
  확인하지 못했다.
- WebAuthn에서 Windows에 실제로 어떤 authenticator와 계정 선택 UI가 뜨는지, 앱이 거기에 끼어들 수 있는지는 확인하지
  못했다.
- 위 Electron, Tauri, WebView2 서술은 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다. 이 API들이 WebView2
  런타임에서 실제로 동작하는지는 이 결정에서 측정하지 않았고 CI에서도 측정하지 않았다. 저장소 서술은 코드를 근거로 한다.
- 이 저장소의 Windows 호스트는 WebView2 권한 요청 이벤트에 모두 거부로 응답하고 지속 저장 결정을 끈다
  (`native/windows/bun/webview.ts`의 `permission-request-denied` 경로). 저장소에는 권한 종류별 처리나 WebAuthn 처리가 없다.
  WebView 명령 호출은 네이티브가 관찰한 origin과 frame으로 권한을 검사하는 웹 메시지 브리지로만 백엔드에 닿는다
  ([ADR 0048](./0048-frontend-node-access-and-sync-ipc.md)).

## 결정

1. MIDI, 센서, 보호 미디어의 권한 요청을 앱이 허용하거나 거부하는 연산, 그리고 WebAuthn authenticator와 계정 선택을 앱이
   처리하는 연산을 코어와 플러그인의 공개 연산, 이벤트, 설정으로 제공하지 않는다. 이 용도의 권한 훅도 두지 않는다. 권한 훅
   일반과 영속화는 별도 항목에서 정한다.
2. 호스트의 기존 동작을 바꾸지 않는다. 권한 요청 거부 경로는 그대로 두며, 권한 종류별 허용 경로를 만들지 않는다. 위
   API들이 그 경로를 거쳐 막히는지, 거치지 않고 WebView2 기본 동작으로 동작하는지는 확인하지 않았다. bunaway는 이
   API들이 WebView에서 쓸 수 있다거나 막힌다고 약속하지 않으며 앱은 이 API에 의존하지 않는다.
3. WebAuthn의 authenticator와 계정 선택을 bunaway는 중개하지 않는다. 앱 로그인에 passkey나 보안 키가
   필요한 앱은 백엔드나 앱이 직접 만든 플러그인에서 인증을 처리하고, 프런트엔드는 등록한 명령으로 결과를 받는다. 저장소는
   이를 위한 연산을 제공하지 않으며 이 방식이 앱 요구를 채우는지도 검증하지 않았다.
4. 이 항목들을 위한 `UNSUPPORTED` 표시나 선택 렌더러 요구 사항을 새로 만들지 않는다. 제공하는 공개 연산이 없으므로 표시할
   대상이 없다. 선택 Chromium 렌더러를 연결하는 결정이 나면 권한 훅과 함께 다시 검토한다.
5. 이 결정은 권한 훅 일반, 카메라와 마이크의 OS 권한, Bluetooth와 USB와 Serial과 HID 장치 선택
   ([ADR 0107](./0107-webview-device-chooser-apis.md)), WebRTC를 다루지 않는다. 각각 별도 항목에서 정한다.

## 근거

- 직접 근거는 저장소 코드다. 호스트는 권한 요청 이벤트에 일괄 거부로 응답하고, 이 결정은 그 동작과 코어 최소화 방침을
  문서로 확정할 뿐 새 동작을 약속하지 않는다. 공개 문서 기준으로 WebView2의 권한 종류 목록에는 보호 미디어와 WebAuthn이 없다.
  Electron의 권한 핸들러는 Chromium 임베딩에 기대는 것으로 보여 WebView2 위에서 같은 계약을 지킬 수 있는지 확인하지
  못했다. Tauri 선례는 확인하지 못했으므로 선례를 따랐다고 주장하지 않는다.
- 권한 판단은 신뢰 코드가 맡는 편이 이 저장소의 권한 모델과 맞다. 페이지 스크립트가 공격받을 수 있다는 가정에서, 이 권한만
  따로 앱 쪽 훅으로 풀면 명령 권한 검사를 거치지 않는 허용 경로가 생길 수 있다. 권한 요청 이벤트가 오는 요청에 한해서는 현재의
  일괄 거부가 가장 보수적인 동작이다.
- 코어에 권한 종류별 계약을 넣으면 종류마다 이벤트와 수명 규칙을 코어가 유지해야 한다. 쓰는 곳이 확인되지 않아 코어를
  작게 둔다.
- 호스트 코드와 권한 경계를 바꾸지 않는다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 MIDI와 센서와 보호 미디어 항목, WebAuthn 항목, WebView2가 제공하지 않는 장치 API 항목을 결정
  완료로 바꾸고 이 결정과 ADR 0107을 참조한다.
- 이 API들이 WebView2에서 실제로 동작하는지는 측정하지 않았다. 필요하면 Web API 실측 작업에서 확인한다.
- 용도가 확인되거나 선택 Chromium 렌더러가 생기면 별도 결정에서 다룬다.

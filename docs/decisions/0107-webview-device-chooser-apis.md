---
status: accepted
---

# WebView의 Bluetooth, USB, Serial, HID 장치 선택 API를 제공하지 않는다

결정일: 2026-10-27. 검토 기준: main `c2ce1e44`.

## 배경

WebView 안 페이지는 Web Bluetooth, WebUSB, Web Serial, WebHID로 장치에 접근할 수 있다. 이 API들은 사용자가 장치 선택기에서
장치를 고르는 단계를 거치며, 임베더가 그 선택을 대신 처리하거나 장치 추가, 제거, 권한 revoke를 알려 받는 훅을 줄 수 있다.
bunaway가 이런 장치 선택 API를 제공할지 정해야 했다.

- Electron은 Chromium을 내장하므로 장치 선택을 앱이 처리하는 API를 준다. 세션의 `select-bluetooth-device`,
  `select-usb-device`, `select-hid-device`, `select-serial-port` 이벤트에서 장치를 골라 돌려주고,
  `usb-device-added`, `usb-device-removed`, `hid-device-added`, `hid-device-removed`, `hid-device-revoked`,
  `serial-port-added`, `serial-port-removed`, `serial-port-revoked` 이벤트로 장치 변화를 알린다. 장치 접근 허용 여부는
  `setDevicePermissionHandler`와 `setPermissionCheckHandler`로 정하고, Bluetooth pairing은 `setBluetoothPairingHandler`로 처리한다.
  처리하지 않으면 선택기가 뜨지 않는다.
- Tauri는 시스템 WebView를 쓰며, 이 네 장치 종류에 대한 공개 API가 없다. 장치 선택은 각 플랫폼 WebView의 기본 동작에 맡기고
  앱이 가로채는 경로를 두지 않는다. 장치가 필요한 앱은 Rust 명령이나 플러그인에서 직접 접근한다.
- WebView2의 `ICoreWebView2PermissionRequestedEventArgs`가 구분하는 권한 종류(`COREWEBVIEW2_PERMISSION_KIND`, 기준 SDK 버전은 확인하지 못했고 공개 문서에 나온 목록 기준)는 마이크,
  카메라, 위치, 알림, 기타 센서, 클립보드 읽기, 여러 자동 다운로드, 파일 읽기와 쓰기, 자동 재생, 로컬 글꼴, MIDI 시스템 전용
  메시지, 창 관리다. Bluetooth, USB, Serial, HID 종류는 목록에 없고, 장치 선택기를 앱이 대신 처리하는 이벤트도 없다.
- 위 Electron과 Tauri, WebView2 서술은 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다. 네 API가 WebView2
  런타임에서 실제로 노출되는지, 선택기가 뜨는지는 이 결정에서 확인하지 않았다. 저장소 서술은 코드를 근거로 한다.
- 이 저장소의 Windows 호스트는 WebView2 권한 요청을 모두 거부하고 지속 저장 결정을 끈다
  (`native/windows/bun/webview.ts`의 `permission-request-denied` 경로). WebView 명령 호출은 네이티브가 관찰한 origin과 frame으로
  권한을 검사하는 웹 메시지 브리지로만 백엔드에 닿는다([ADR 0048](./0048-frontend-node-access-and-sync-ipc.md)).

## 결정

1. Bluetooth 장치 선택과 pairing, USB, Serial, HID의 장치 선택, 추가, 제거, 권한 revoke 이벤트를 코어와 플러그인의 공개
   연산, 이벤트, 설정으로 제공하지 않는다. 이 네 API 전용 권한 훅도 두지 않는다. 권한 훅 일반은 별도 항목에서 정한다.
2. 호스트의 기존 동작을 바꾸지 않는다. WebView2 권한 요청 거부 경로는 그대로 두고, 장치 선택기를 대신 처리하는 경로를 만들지
   않는다. 이 네 API가 그 거부 경로를 거치는지는 확인하지 않았다. 페이지 안 동작은 WebView2 런타임이 정하는 대로 두며,
   bunaway는 이 API들이 WebView에서 쓸 수 있다거나 막힌다고 약속하지 않는다. 앱은 이 API에 의존하지 않는다.
3. 장치가 필요한 앱은 백엔드나 플러그인에서 장치에 접근하고, 프런트엔드는 등록한 명령과 이벤트로 결과를 받는다. 이 방식은
   장치 접근을 앱이 명령 권한으로 통제하는 기존 경계 안에 둔다.
4. 이 API들을 위한 `UNSUPPORTED` 항목이나 선택 렌더러 요구 사항을 새로 만들지 않는다. 제공하는 공개 연산이 없으므로 표시할
   대상이 없고, 선택 렌더러가 없어도 위 대체 경로로 앱 요구를 채울 수 있다. 선택 Chromium 렌더러를 연결하는 결정이 나면 그때
   장치 선택 훅을 다시 검토한다.
5. 이 결정은 권한 훅 일반, 카메라와 마이크의 OS 권한, MIDI와 센서와 protected media, WebAuthn, WebRTC를 다루지 않는다.
   각각 별도 항목에서 정한다.

## 근거

- Tauri는 이 API를 만들지 않고 플랫폼 WebView 기본 동작에 맡기며, WebView2는 선택기를 앱이 대신 처리하는 이벤트와 해당 권한
  종류를 주지 않는다. Electron의 방식은 Chromium 임베딩에 기대므로 WebView2 위에서는 같은 계약을 지킬 수 없다. 지킬 수 없는
  계약을 공개하지 않고 Tauri 쪽을 따른다.
- 장치 접근은 페이지가 직접 하게 두기보다 신뢰 코드(백엔드)가 맡는 편이 이 저장소의 권한 모델과 맞다. 페이지 스크립트가
  공격받을 수 있다는 가정에서, 장치 접근 허용 판단을 페이지 쪽 훅에 두면 명령 권한 검사를 거치지 않는 경로가 생긴다.
- 코어에 네 가지 장치 종류의 선택, 추가, 제거, revoke 계약을 넣으면 종류마다 이벤트와 수명 규칙을 코어가 유지해야 한다.
  쓰는 곳이 없고 대체 경로가 있어 코어를 작게 둔다.
- 호스트 코드와 권한 경계를 바꾸지 않는다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 Bluetooth, USB, Serial, HID 네 항목과 WebView2가 제공하지 않는 장치 API 항목을 결정 완료로 바꾸고
  이 결정을 참조한다.
- 용도가 확인되거나 선택 Chromium 렌더러가 생기면 별도 결정에서 다룬다. 이때는 장치 종류별 선택 훅보다 권한 훅 일반과
  백엔드 대체 경로를 먼저 검토한다.

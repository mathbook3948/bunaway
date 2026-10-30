---
status: accepted
---

# WebView의 getDisplayMedia source 선택, 화면 공유, 시스템 audio capture, frame별 PDF, 비디오 frame 복사를 제공하지 않는다

결정일: 2026-10-27. 검토 기준: main `5832b295`.

## 배경

아래 Electron, Tauri, WebView2 서술은 공개 문서와 API 목록에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다. 저장소 서술은 코드를 근거로 한다.

WebView 안 페이지가 `navigator.mediaDevices.getDisplayMedia`로 화면이나 창을 공유할 때 앱이 공유할 source를 골라 주는 흐름, 화면과 시스템 audio를 연속 스트림으로 받는 기능,
frame별 PDF, 비디오의 "다른 이름으로 저장"과 "비디오 frame 복사"에 해당하는 기능을 제공할지 정해야 했다.

- Electron은 `session.setDisplayMediaRequestHandler`로 `getDisplayMedia` 요청마다 앱이 `desktopCapturer.getSources`가 돌려준 source나 frame을 골라 응답하게 한다.
  응답에는 시스템 audio를 뜻하는 `loopback`, `loopbackWithMute`가 있다. `useSystemPicker` 옵션도 있으나 어느 플랫폼에서 동작하는지는 확인하지 못했다.
  핸들러가 없을 때의 동작은 확인하지 못했다.
  `webContents.printToPDF`는 `webContents` 단위이며 frame을 지정하는 옵션이 있는지는 확인하지 못했다. 비디오 저장과 frame 복사는 Electron이 기본 컨텍스트 메뉴를 주지 않으므로
  앱이 `context-menu` 이벤트의 매개변수(`mediaType`, `srcURL`)와 `downloadURL`, 클립보드 API로 직접 만든다.
- Tauri는 `getDisplayMedia` source 선택, 화면 공유, 시스템 audio, frame별 PDF, 비디오 frame 복사의 공개 API가 없고 플랫폼 WebView의 기본 동작에 맡긴다.
- WebView2의 `ICoreWebView2PermissionRequestedEventArgs`가 구분하는 권한 종류(공개 문서의 목록 기준, 기준 SDK 버전은 확인하지 못했다)에서 화면 캡처를 가리키는 종류는
  찾지 못했다. `getDisplayMedia`가 WebView2 런타임에서 선택기를 띄우는지, 권한 요청 이벤트를 거치는지, 앱이 source를 대신 고를 수 있는지는 확인하지 못했다.
  비디오 컨텍스트 메뉴의 항목 구성도 확인하지 못했다.
- 이 저장소의 Windows 호스트는 WebView2 권한 요청을 모두 거부하고 지속 저장 결정을 끈다(`native/windows/bun/webview.ts`의 `permission-request-denied` 경로).
  `getDisplayMedia`가 이 경로를 거치는지는 확인하지 않았으며, 거치지 않으면 페이지 동작은 WebView2 런타임의 기본 동작을 따른다.
  [ADR 0107](./0107-webview-device-chooser-apis.md)이 같은 경로와 같은 한계를 다룬다.
- 선택 플러그인 `screen-capture`(Windows 전용)는 `listSources`(화면과 최상위 창 목록, 선택 `thumbnailSize`)와 `captureSource`(한 장짜리 PNG, 최대 4096 픽셀 변,
  640 KiB)만 제공하고, 연산마다 `screenCapture.listSources`, `screenCapture.captureSource` 권한을 따로 요구한다. thumbnail을 요청하면 `captureSource` 권한도 필요하다.
  연속 스트림과 시스템 audio는 없다.
- 연속 화면 스트림은 Windows Graphics Capture 같은 호스트 캡처 세션, 시스템 audio는 WASAPI loopback 같은 호스트 구현이 필요하고 두 방식 모두 이 저장소에 구현이 없다.
  이를 제공하려면 장기 캡처 자원의 수명, 창 재생성 때의 정리, 동시 개수 상한, 취소, 프레임 전달 경로의 크기와 속도 제한, 그리고 화면 내용이 WebView에 노출되는 것에 대한
  앱 단위 동의가 새로 필요하다. 이는 모든 앱의 화면 노출 경계에 닿는다.

## 결정

1. UI의 `getDisplayMedia`에 앱이 source를 골라 주는 연산, 이벤트, 설정을 코어와 플러그인에 두지 않는다. 화면 공유와 시스템 audio capture(loopback)를 제공하지 않는다.
2. 호스트의 기존 동작을 바꾸지 않는다. 권한 거부 경로는 그대로 두고 화면 캡처 요청을 허용하는 경로를 만들지 않는다. `getDisplayMedia`가 WebView2에서 어떻게 끝나는지는
   확인하지 않았으므로 bunaway는 이 API가 동작한다거나 막힌다고 약속하지 않으며, 앱은 이 API에 의존하지 않는다.
3. 화면 내용이 필요한 앱은 백엔드에서 `screen-capture`의 `listSources`와 `captureSource`를 호출하고, 결과를 앱이 등록한 명령으로 UI에 넘긴다. `screen-capture` 연산을
   뷰의 `commands`에 넣어 페이지가 직접 호출하는 방식은 `screen-capture` 문서가 권장하지 않는다. 썸네일 선택기를 UI에 그리면 화면 내용이 WebView에 노출되므로 그 노출은
   앱이 책임지고 정한다. 연속 갱신이 필요해 호출을 반복하면 캡처가 호스트의 I/O Worker에서 한 번에 하나씩 실행되고 시작한 캡처를 취소할 수 없어 같은 Worker의 다른 작업이
   늦어진다. 반복 호출이 스트림 수준의 프레임 속도를 내는지는 검증하지 않았다. 시스템 audio는 대체 경로가 없다.
4. frame별 PDF와 비디오 frame 복사, 비디오 저장을 제공하지 않는다. 사용자가 선택하는 인쇄는 `windows.showPrintUI`가 있고, frame 단위가 아닌 PDF 내보내기와 페이지 capture는 별도 항목에서 정한다.
   비디오 파일을 가진 앱은 원본 URL이나 파일을 직접 다루면 된다. WebView2 공개 API에서 frame별 PDF나 비디오 frame 복사에 대응하는 항목은 찾지 못했다.
5. 이 결정을 위한 `UNSUPPORTED` 항목이나 선택 렌더러 요구 사항을 새로 만들지 않는다. 요구가 확인되면 별도 결정에서 다루며, 그때 전제는 호스트 캡처 세션의 수명과 상한,
   WebView2에서 source 선택 응답이 가능한지의 확인, 앱 단위 동의 방식이다.
6. 이 결정은 권한 훅 일반, 카메라와 마이크의 OS 권한, 페이지 capture와 PDF 내보내기를 다루지 않는다. 각각 별도 항목에서 정한다.

## 근거

- Electron은 source 선택과 loopback을 제공하고 Tauri는 제공하지 않아 둘이 다르다. 코어는 작게 두는 쪽을 따르고, 플러그인으로 새로 만들지도 않는다.
  `plugins`, `packages`, `examples`에서 `getDisplayMedia`나 시스템 audio loopback을 쓰는 코드가 없어 요구가 확인되지 않았기 때문이다.
- 연속 스트림과 loopback은 호스트에 장기 자원과 응답 계약을 새로 요구하고 화면 노출 경계를 모든 앱에 대해 바꾼다. 지킬 수 있는지 확인하지 못한 WebView2 동작 위에 계약을 공개하지 않는다.
- bunaway가 제공하는 화면 내용 경로는 신뢰 코드(백엔드)가 연산별 권한 검사를 거쳐 얻는 `screen-capture`뿐이다. 이 결정은 페이지가 WebView2 런타임의 기본 동작으로
  `getDisplayMedia`를 직접 호출하는 경로를 통제하지 못하며, 그 경로가 있는지는 확인하지 않았다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 source 선택, 화면 공유와 시스템 audio, frame별 PDF와 비디오 frame 세 항목을 결정 완료로 바꾸고 이 결정을 참조한다.
- 사이트 문서 `screen-capture.mdx`가 이 결정을 링크한다.
- 요구가 확인되면 별도 결정에서 다룬다.

---
status: accepted
---

# WebView 다운로드의 redirect chain과 frame별 initiator를 제공하지 않는다

결정일: 2026-10-28. 검토 기준: main `5832b295`.

## 배경

`windows.getDownloads`는 최종 다운로드 URL, MIME, Content-Disposition, 기본 저장 경로, 바이트 수, 상태와 interrupt reason을 돌려준다.
다운로드가 거쳐 온 redirect URL 목록과, 다운로드를 시작한 frame 정보를 조회하는 기능을 더할지 정해야 했다.

- Electron의 `DownloadItem`은 `getURLChain()`으로 요청 URL부터 redirect를 거친 URL 목록을 주고, `getURL()`로 최종 URL을 준다. 시작 frame을
  식별하는 값은 `DownloadItem`에 없다. `session`의 `will-download` 이벤트가 다운로드를 시작한 `webContents`를 넘기므로 창 단위까지는 알 수 있다.
- Tauri와 wry의 다운로드 훅(`on_download`)은 `Requested`에서 URL과 저장 경로만 주고, `Finished`에서 URL, 경로, 성공 여부를 준다.
  redirect 목록과 시작 frame에 해당하는 값은 없다.
- WebView2의 `ICoreWebView2DownloadStartingEventArgs`는 다운로드 operation, 취소, 결과 파일 경로, handled, deferral만 주고,
  `ICoreWebView2DownloadOperation`은 `Uri`, `ContentDisposition`, `MimeType`, 총 바이트, 받은 바이트, 예상 종료 시각, `ResultFilePath`, 상태,
  interrupt reason, `CanResume`와 Cancel, Pause, Resume을 가진다. redirect 목록이나 시작 frame을 돌려주는 속성은 없다.
  `Uri`가 최종 URI인지 요청 URI인지는 문서에 명시돼 있지 않다.
- 이 저장소의 Windows 호스트(`native/windows/bun/webview-downloads.ts`)가 읽는 operation 속성은 위 목록과 같고, 호출하는 vtable
  위치는 operation 인터페이스의 마지막 속성(`CanResume`)까지다. 호스트가 읽을 수 있는 값 중 redirect나 frame을 나타내는 것은 없다.
- 근사하려면 `NavigationStarting`, `FrameNavigationStarting`, `WebResourceResponseReceived`로 요청과 redirect를 관찰해 다운로드와 짝지어야 한다.
  `WebResourceResponseReceived`는 다운로드가 되는 응답의 본문은 주지 않지만 요청과 응답 header는 주는 관찰 전용 이벤트다. 다만 다운로드 operation과
  이 이벤트를 잇는 공통 식별자가 없어 URL과 시간으로 추정해야 한다. 같은 URL을 동시에 여러 번 요청하거나, 다운로드를 시작한 요청이
  이미 끝난 탐색의 후속 동작이면 짝이 어긋난다. Electron과 Tauri 문서의 서술은 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.
- [ADR 0083](./0083-webview-request-interception.md)은 WebView의 HTTP 요청 단위 가로채기와 요청 결과 이벤트를 제공하지 않기로 했다.
  redirect chain을 만들려면 그 결정이 막은 요청 관찰을 호스트에 상시 켜야 한다.
- 앱의 판단 수단은 이미 있다. 승인 요청은 문서 origin과 다운로드 URI를 모두 대상 뷰의 기존 HTTP/HTTPS origin 안에서만 받고, 기본은 거부이며,
  `windows.approveDownload`는 신뢰된 backend만 부른다([windows 계약](../site/src/content/docs/reference/host/windows.mdx)).

## 결정

1. `windows.getDownloads` 항목에 redirect URL 목록, 요청 URL, 시작 frame, initiator 필드를 더하지 않는다. 별도 조회 연산과 이벤트도 두지 않는다.
   `url`은 지금처럼 WebView2가 돌려주는 다운로드 URI다.
2. 호스트의 기존 동작을 바꾸지 않는다. 다운로드를 짝짓기 위한 요청 관찰이나 `WebResourceResponseReceived` 구독을 새로 켜지 않는다.
3. 다운로드를 시작한 출처가 필요한 앱은 승인 시점의 문서 origin 검사와 `url` 검사를 쓰고, 더 필요하면 자기 페이지가 다운로드를 시작하는 순간
   자기 명령으로 backend에 알린다. 저장소는 이를 위한 연산을 제공하지 않는다.
4. 이 결정은 `UNSUPPORTED` 항목이나 선택 렌더러 요구를 새로 만들지 않는다. 제공하는 공개 연산이 없으므로 표시할 대상이 없다.
   WebView2가 redirect 목록이나 시작 frame을 직접 돌려주는 SDK가 나오면 그때 `getDownloads`의 선택 필드로 다시 검토한다.
5. 사용자 지정 저장 경로, 진행 이벤트, 중단 다운로드 재개는 각각 별도 항목에서 정한다.

## 근거

- Electron은 URL chain을 주고 Tauri는 주지 않아 선례가 갈린다. 갈릴 때는 코어는 작게, 기능은 플러그인 쪽을 따른다. WebView2가 값을 직접 주지
  않으므로 Electron의 계약은 요청 관찰로 짜 맞춰야만 지킬 수 있고, 그 값은 정확하지 않을 수 있다. 부정확한 chain을 공개 계약으로 두면
  앱이 안전 판단에 쓰다가 어긋난 값에 속을 수 있다.
- 짝짓기용 요청 관찰은 ADR 0083이 코어에 넣지 않기로 한 방향이다. 다운로드 하나를 위해 모든 리소스 요청에 구독을 켜면 페이지 로드마다 비용이 든다.
- frame별 initiator는 Electron의 `DownloadItem`에도 없고 Tauri도 주지 않아 따를 선례가 없다.
- 호스트 코드와 권한 경계를 바꾸지 않는다.

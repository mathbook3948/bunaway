---
status: accepted
---

# WebView의 offscreen rendering, painting 제어, WebContents clone, GPU shared texture를 제공하지 않는다

결정일: 2026-10-28. 검토 기준: main `310be4a0`.

## 배경

페이지가 그린 화면을 창에 표시하지 않고 프레임 단위로 받아 쓰는 기능이 있다. 앱이 이 프레임을 직접 합성하거나 다른 곳으로
내보내며, 그리는 시점도 앱이 제어한다. bunaway가 이 기능군을 제공할지 정해야 했다. 대상은 아래 네 묶음이다.

- offscreen rendering: 프레임, 변경된 영역(dirty rect), 프레임 속도.
- painting 제어: 그리기 시작, 중단, 상태 조회, 다시 그리기 요청(invalidate).
- WebContents clone과 프레임 구독.
- GPU shared texture: 텍스처 핸들 가져오기, 다른 프로세스나 API로 전달, 수명과 동기화.

각 프레임워크의 방식은 다음과 같다.

- Electron은 Chromium을 내장하므로 네 묶음을 모두 제공한다. `webPreferences.offscreen`을 켜면 창에 표시하지 않고 렌더링하며,
  `paint` 이벤트로 비트맵과 dirty rect를 받고 `setFrameRate`, `getFrameRate`로 프레임 속도를 정한다.
  `startPainting`, `stopPainting`, `isPainting`, `invalidate`로 그리기를 제어한다. `offscreen.useSharedTexture`를 켜면
  `paint`가 비트맵 대신 GPU 텍스처 핸들을 주고, `sharedTexture` 모듈이 그 핸들을 가져오고 전달하고 해제한다.
  WebContents 프레임을 구독하는 API도 Chromium 렌더링 경로에 기댄다. WebContents clone을 제공하는 API는 확인하지 못했다.
- Tauri는 시스템 WebView를 쓰며 위 API에 해당하는 공개 API가 없다. 창에 붙은 WebView만 다루며 프레임 콜백, painting 제어,
  텍스처 공유를 주지 않는다.
- WebView2는 공개 문서 기준으로 페이지 프레임을 지속적으로 받는 콜백을 주지 않는다. 화면을 얻는 경로는 `CapturePreview`(한 번의
  스크린샷)와 composition hosting(`ICoreWebView2CompositionController`)이다. composition hosting은 호스트가 시각 트리와 입력
  전달을 직접 맡는 방식이다. 이 방식으로 합성 결과를 가져올 수 있는지는 검토하지 않았다.
- 위 서술은 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다. 저장소 서술은 코드를 근거로 한다.
- 이 저장소의 Windows 호스트는 창마다 WebView2 컨트롤러 하나를 만들어 창에 붙인다(`native/windows/bun/webview.ts`의
  `CreateController` 호출, [ADR 0026](./0026-single-webview-single-window.md)).
  앱은 창 하나와 WebView 하나를 가지며 창 대상 필드가 없다. 화면 밖 렌더링용 WebView를 따로 만드는 경로, 같은 문서를 여러
  WebView에 복제하는 경로는 없다. 화면 캡처는 `screenCapture.captureSource`가 화면이나 창 단위로 단발 캡처를 제공한다.

## 결정

1. offscreen rendering(프레임, dirty region, 프레임 속도), painting 제어(시작, 중단, 상태 조회, invalidate), GPU shared
   texture(가져오기, 전달, 수명, 동기화)를 코어와 플러그인의 공개 연산, 이벤트, 설정으로 제공하지 않는다. 이 저장소의 WebView2
   호스트에는 구현이 없고 Tauri에도 대응 API가 없다. 쓰는 곳이 없는 계약을 코어에 넣지 않고 Tauri 쪽을 따른다.
2. WebContents clone과 프레임 구독을 제공하지 않는다. clone은 같은 문서를 가진 WebView를 추가로 만드는 일이며
   [ADR 0026](./0026-single-webview-single-window.md)이 정한 창 하나에 WebView 하나 모델과 맞지 않는다. 프레임 구독은 위 1과
   같은 이유로 제공하지 않는다.
3. 호스트와 코어의 기존 동작을 바꾸지 않는다. 이 기능들을 위한 `UNSUPPORTED` 항목, 설정 필드, 권한 이름을 새로 만들지 않는다.
   제공하는 공개 연산이 없으므로 표시할 대상이 없다.
4. 화면 내용이 필요한 앱은 단발 캡처로 채운다. 현재 화면이나 창 단위는 `screenCapture.captureSource`로 얻는다. WebView 영역
   단발 캡처는 별도 항목에서 다룬다. 연속 프레임이 필요한 앱은 이 저장소가 채우지 않는다.
5. 선택 Chromium 렌더러를 연결하는 결정이 나면 그때 이 기능군을 다시 검토한다. 그 렌더러가 offscreen과 shared texture를 낼 수
   있어도 별도 패키지의 선택 기능으로 두고 코어 계약에 넣지 않는다.
6. 이 결정은 WebView 영역 단발 캡처, 화면 공유(`getDisplayMedia`), 선택 Chromium 렌더러의 도입 여부, View tree와
   native child view, guest WebView를 다루지 않는다. 각각 별도 항목에서 정한다.

## 근거

- Electron의 이 기능군은 Chromium 임베딩에 기대고, Tauri와 WebView2는 대응 수단이 없다. 둘이 다르면 Electron을 따르는 것이
  기본이지만, WebView2 위에서는 같은 계약을 지킬 수 없으므로 공개하지 않는다.
- 이 저장소에는 프레임 단위 접근을 요구하는 이슈나 TODO가 없다. 프레임 단위 접근은 화면 전송이나 3D 합성처럼 좁은 용도로
  보이며, 단발 캡처로 채울 수 있는지는 용도가 나오면 확인한다. 코어에 프레임, 텍스처 수명, 동기화 규칙을 넣으면 코어가 GPU 자원의 소유권과 해제 순서를 유지해야 한다.
- clone은 이미 정한 단일 WebView 모델을 다시 여는 일이므로 별도 근거 없이 되돌리지 않는다.
- 호스트 코드와 권한 경계를 바꾸지 않는다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 offscreen rendering, painting 제어, WebContents clone과 프레임 구독, GPU shared texture 네 항목을
  결정 완료로 바꾸고 이 결정을 참조한다.
- 연속 프레임이 필요한 용도가 확인되거나 선택 Chromium 렌더러가 생기면 별도 결정에서 다룬다.

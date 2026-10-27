---
status: accepted
---

# WebView silent print, PDF 내보내기, 페이지 capture와 페이지 저장을 제공하지 않는다

결정일: 2026-10-26. 검토 기준: main `8e4e0c35`.

## 배경

아래 Electron, Tauri, WebView2 서술은 해당 프로젝트의 공개 문서와 API 목록에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

WebView 문서를 프린터에 바로 출력하는 기능, PDF로 내보내는 기능, 페이지 이미지와 지정 영역을 capture하는 기능, 페이지를 HTML 또는 리소스를 포함한
형태로 저장하는 기능을 제공할지 정해야 했다.

- Electron은 `webContents.print`(`silent`, `deviceName`, 용지와 여백 옵션), `webContents.printToPDF`(용지, 방향, 여백, 페이지 범위, 배경 옵션),
  `webContents.capturePage`(전체 또는 `rect` 영역), `webContents.savePage`(`HTMLOnly`, `HTMLComplete`, `MHTML`)를 제공한다.
- Tauri는 WebView 창의 `print()`로 인쇄 대화상자를 여는 API를 제공하고, PDF 내보내기, 페이지 capture, 페이지 저장의 크로스플랫폼 공개 API는 찾지 못했다.
  Windows에서는 `with_webview`로 얻은 WebView2 객체에 앱이 직접 호출할 수 있다.
- WebView2는 `Print`(`ICoreWebView2PrintSettings`와 프린터 이름으로 대화상자 없이 출력), `PrintToPdf`, `PrintToPdfStream`, `CapturePreview`(PNG 또는 JPEG, 보이는 영역),
  `ShowPrintUI`를 제공한다. 지정 영역 capture와 MHTML 저장은 DevTools Protocol(`Page.captureScreenshot`의 `clip`, `Page.captureSnapshot`)을 `CallDevToolsProtocolMethod`로
  호출하는 경로가 있고 이 저장소에는 해당 바인딩이 이미 있으나, 두 메서드의 결과를 검증하지 않았다. HTML과 리소스 폴더를 함께 저장하는 `HTMLComplete`에 해당하는
  전용 API는 찾지 못했다.
- 이 저장소는 이미 `windows.showPrintUI({ kind? })`로 browser 또는 system 인쇄 대화상자를 요청하고, 프린터 이름과 기본 여부는 `os.listPrinters`,
  `os.getDefaultPrinter`가 조회한다. 사용자가 프린터와 출력 여부를 고르는 경로는 이미 있다.
- 선택 플러그인 `screen-capture`는 화면과 최상위 창의 축소 PNG를 `captureSource`로 제공한다. 다만 지정 영역 입력이 없고(`id`, `maxWidth`, `maxHeight`만 받는다),
  반환 PNG에 크기 상한이 있으며, 최소화된 창은 `SOURCE_UNAVAILABLE`이고 Windows 전용이다. WebView 콘텐츠의 캡처 결과는 TODO-windows의 해당 항목에서 아직 검증 중이다.
  따라서 페이지 capture를 대체한다고 약속하지 않고, 창 단위 이미지가 필요할 때 쓸 수 있는 기존 기능으로만 가리킨다.
- 사용자 확인 없는 출력은 프린터에서 종이와 소모품을 쓰고 되돌릴 수 없다. PDF와 이미지는 결과 바이트를 백엔드로 넘기는 크기와 deadline, 저장 위치(`storage`의 경로 책임)를
  함께 정해야 하며, 오프스크린 렌더링이나 보이지 않는 창의 결과는 숨김 WebView 페인트 동작에 의존한다.

## 결정

1. 프린터와 인쇄 옵션을 프로그램에서 지정하는 silent print를 추가하지 않는다. 인쇄는 `windows.showPrintUI`가 맡는다.
2. PDF 내보내기와 용지, 방향, 여백, 페이지 범위, 배경 옵션을 추가하지 않는다.
3. WebView 페이지 전체와 지정 영역 capture를 추가하지 않는다. 창 단위 이미지는 `screen-capture`의 `captureSource`로 얻을 수 있으나 영역 지정과 WebView 콘텐츠 캡처는 보장하지 않는다.
4. 페이지를 HTML 또는 리소스를 포함한 형태로 저장하는 기능을 추가하지 않는다. 앱이 이미 가진 콘텐츠는 앱 자산 경로로 제공하고, 페이지 상태는 앱 코드가 직접 직렬화한다.
5. 요구가 확인되면 별도 결정에서 다룬다. 이때 PDF는 WebView2 `PrintToPdfStream`으로 결과 크기 상한과 deadline, 저장 경로 책임을 계약으로 먼저 정하고,
   silent print는 사용자 확인 없이 출력된다는 점을 허용할 권한 단위와 함께 정한다. 페이지 저장은 DevTools `Page.captureSnapshot`(MHTML)로 가능한지 먼저 검증한다.

## 근거

- Electron은 네 기능을 제공하고 Tauri는 인쇄 대화상자만 제공한다. 둘이 다르므로 코어는 작게, 기능은 필요한 곳에 맞추는 쪽을 따른다.
  또한 쓰는 곳이 없다(`plugins`, `packages`, `examples`에서 WebView PDF, 페이지 capture, silent print를 호출하는 코드는 없다).
- 사용자가 선택하는 인쇄는 이미 `windows.showPrintUI`가 제공한다. 남은 기능은 사용자 확인 없는 출력(silent print)과 저장 위치, 결과 크기 계약을 가진
  결과물 생성(PDF, 페이지 저장, 영역 capture)이며, 쓰는 곳 없이 계약을 고정하면 이후 요구에 맞추기 어렵다.
- `HTMLComplete`와 같은 범위의 전용 API는 찾지 못했고, MHTML과 지정 영역 capture는 DevTools Protocol 경로를 검증해야 한다. 같은 이름의 옵션이 플랫폼과
  경로마다 다른 범위를 약속하게 되는 것을 피한다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.
- 사이트 문서 `windows.mdx`의 인쇄 서술을 이 결정에 맞춘다.

---
status: accepted
---

# WebView 파일 drop 이벤트, File 객체와 OS 경로 연결, 앱 밖 드래그를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `01de66d6`.

## 배경

파일을 WebView에 끌어다 놓을 때 enter, over, leave, drop 이벤트와 경로, 좌표를 앱에 주는 기능, 페이지의 `File` 객체를 OS 파일 경로와
연결하는 기능, 파일을 앱 밖으로 끌어내며 drag 이미지를 표시하는 기능을 정해야 했다.

아래 외부 동작은 Electron v45.0.0, Tauri 2.12.5(wry 0.57.1), WebView2 SDK 1.0.4314.35의 공식 문서와 해당 태그의 소스를 확인한 것이며 이
저장소의 테스트로 검증한 것은 아니다.

- Electron에는 드롭된 경로와 좌표를 주는 main 프로세스 이벤트(`webContents`, `BrowserWindow`)가 없다. 페이지가 HTML5 drop으로 받은
  `File`을 preload에서 `webUtils.getPathForFile(file)`로 OS 경로로 바꾼다(`File.path`를 대체). 문서는 전체 경로를 웹 콘텐츠에 노출하지
  않는 편이 좋다고 밝힌다. 앱 밖으로 끄는 것은 `contents.startDrag(item)`이며 `file` 또는 `files`의 절대 경로와 `icon`을 받는다.
- Tauri는 `onDragDropEvent`(webview, window)와 Rust `WindowEvent::DragDrop`, `WebviewEvent::DragDrop`으로 `enter`(paths, position),
  `over`(position), `drop`(paths, position), `leave`를 준다. position은 webview 왼쪽 위 기준 물리 픽셀이다. Windows에서 wry는
  `SetAllowExternalDrop(false)`를 호출하고 WebView2의 child HWND drop target을 자기 `IDropTarget`으로 교체해 `CF_HDROP`에서 경로를
  얻는다. 그래서 HTML5 drag and drop이 꺼지며, 쓰려면 `disable_drag_drop_handler()` 또는 설정 `dragDropEnabled: false`가 필요하다.
  앱 밖으로 끄는 공개 API는 확인하지 못했다.
- WebView2는 `ICoreWebView2Controller4::AllowExternalDrop`(기본 TRUE)로 외부 drop 허용 여부를 정한다. 호스트가 직접 받으려면
  `ICoreWebView2CompositionController3`의 `DragEnter`, `DragOver`, `DragLeave`, `Drop`을 쓰는 composition 모드에서 `IDropTarget`을
  등록하고 `IDataObject`와 WebView client 좌표를 전달해야 한다. 이 모드에서 `IDataObject`로 경로를 얻는 방법은 문서가 다루지 않는다.
  WebView 안에서 시작한 드래그는 `ICoreWebView2CompositionController5::add_DragStarting`(1.0.3719.77)으로 재정의한다.
- 드롭된 HTML5 `File`의 OS 경로는 호스트에 자동으로 전달되지 않는다. 페이지가 `chrome.webview.postMessageWithAdditionalObjects`로
  `File`을 보내면 호스트가 `ICoreWebView2WebMessageReceivedEventArgs2::AdditionalObjects`의 `ICoreWebView2File::get_Path`로 절대
  경로를 얻는다(1.0.1774.30). 페이지 JS의 `File`에 OS 경로가 노출된다는 문서는 확인하지 못했다.
- 이 저장소의 호스트는 `IDropTarget` 등록, `AllowExternalDrop` 변경, 드래그 시작 처리를 하지 않는다. 계약에도 해당 호출이나 이벤트가 없다.

## 결정

1. 파일 drop의 enter, over, leave, drop 이벤트와 경로, 좌표 API를 제공하지 않는다. 호스트는 WebView2의 drop target을 교체하지 않으며
   `AllowExternalDrop`을 바꾸지 않는다. 앱은 페이지의 HTML5 drag 이벤트(`dragenter`, `dragover`, `dragleave`, `drop`)와 이벤트 좌표를 쓴다.
2. 페이지의 `File` 객체를 OS 파일 경로와 연결하는 API를 제공하지 않는다. 페이지는 `File`의 내용을 웹 표준 API(`File.stream()`,
   `arrayBuffer()`, `FileReader`)로 읽는다. 경로가 필요한 앱은 `dialog` 플러그인의 파일 선택 대화상자로 경로를 받는다.
3. 파일을 앱 밖으로 끌어내는 API와 drag 이미지 지정 API를 제공하지 않는다.
4. 사용처가 확인되면 별도 결정에서 다룬다. 그때 정할 것은 경로를 페이지에 노출할지 여부, 허용 범위(창, origin, 파일 종류), 호스트가
   drop target을 가질 때 HTML5 drop과 공존하는 방식(composition 모드 전환 여부), 페이지가 `File`을 메시지로 보내 호스트가 경로를 얻는
   방식을 쓸지 여부다.

## 근거

- 두 프레임워크가 다르다. Electron은 main 프로세스에 drop 이벤트가 없고 페이지의 HTML5 drop과 renderer의 경로 변환 함수를 쓰며, Tauri는
  이벤트와 경로를 주는 대신 Windows에서 HTML5 drop을 끈다. 이 결정은 Electron의 main 프로세스 쪽과 같게 호스트에 drop 이벤트를 두지 않고
  페이지의 HTML5 drop을 그대로 둔다. 경로 변환은 사용처가 없어 보류하며, 코어는 작게 두는 쪽을 따랐다.
- 호스트가 drop 이벤트를 직접 받으려면 Tauri 방식이나 composition 모드 중 하나를 골라야 한다. Tauri 방식은 drop target 교체로 페이지의
  HTML5 drop이 꺼져 같은 창에서 두 방식을 함께 쓸 수 없다. composition 모드는 호스트가 `IDropTarget`을 등록하고 `IDataObject`와 좌표를
  전달해야 하며, controller 구성이 달라지는 별도 설계가 필요해 이 결정의 범위를 넘는다.
- 경로만 필요하면 페이지가 `chrome.webview.postMessageWithAdditionalObjects`로 `File`을 보내고 호스트가 `ICoreWebView2File::get_Path`로
  얻는 방식이 있어 composition 모드가 필요 없다. 다만 페이지가 명시적으로 보내야 하고 OS 경로가 호스트 코드에 닿으므로 아래 보안 경계와
  함께 사용처가 생길 때 정한다.
- 경로를 페이지에 주는 일은 모든 앱의 보안 경계를 바꾼다. 페이지가 OS 경로를 알면 앱이 허용하지 않은 파일 위치를 백엔드 명령에 넘길 수 있다.
  경로 제한은 앱의 책임이므로 기본으로 열지 않고 사용처가 생긴 뒤 허용 범위와 함께 정한다. Electron도 전체 경로를 웹 콘텐츠에 노출하지
  않기를 권한다.
- 앱 밖 드래그는 Electron만 `startDrag`로 제공하고 Tauri에서는 공개 API를 확인하지 못했다. WebView2에서 WebView 안에서 시작한 드래그를
  다루는 `DragStarting`은 `ICoreWebView2CompositionController5`에 있어 composition 모드가 전제다.
- 사용처가 없다. 파일 열기는 파일 선택 대화상자가, 내용 읽기는 `File`의 웹 표준 API가 맡는다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 세 항목을 완료로 표시하고 이 결정을 참조한다.

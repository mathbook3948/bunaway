---
status: accepted
---

# WebView 입력 이벤트 주입과 IME composition API를 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `f295a967`.

## 배경

앱 백엔드가 WebView에 키보드, 마우스, wheel 입력을 합성해 보내는 API와, IME 조합(composition) 상태를 조회하거나
제어하는 API를 제공할지 정해야 했다.

- Electron의 `webContents.sendInputEvent`는 키보드, 마우스, wheel 이벤트를 렌더러에 합성해 보낸다. IME 조합을
  제어하는 공개 API는 없고, 조합은 렌더러의 `compositionstart`, `compositionupdate`, `compositionend` 이벤트로 다룬다.
- Tauri 2의 `Webview`와 `Window`에는 입력 이벤트를 주입하는 API가 없다. IME는 WebView 엔진이 처리하고 페이지의
  composition 이벤트로 드러난다.
- WebView2는 텍스트 입력 서비스(TSF)로 IME 조합, 후보 창 위치, 조합 중 표시를 직접 처리한다. 호스트가 개입하지 않아도
  페이지의 입력 요소는 조합을 정상 처리한다.
- 페이지 안에서 `dispatchEvent`로 만든 합성 이벤트는 `isTrusted`가 false이고 사용자 활성화 같은 조건을 통과하지
  못한다. 호스트가 만든 입력이 신뢰된 입력으로 처리되면 사용자 제스처를 요구하는 웹 API를 앱 백엔드가 우회하게 된다.
- 앱 안의 편집 동작(undo, cut, copy, paste, select-all)은 메뉴 role로 이미 제공한다. 텍스트 삽입과 편집 명령 API는
  별도 항목(WebView 편집 명령)에서 다룬다.

## 결정

1. 키보드, 마우스, wheel 입력을 WebView에 합성해 보내는 API를 제공하지 않는다.
2. IME composition의 조회, 시작, 종료, 후보 창 위치 지정 API와 이벤트를 제공하지 않는다. 조합은 WebView2와 TSF가
   처리하고, 앱은 페이지의 `compositionstart`, `compositionupdate`, `compositionend` 이벤트를 쓴다.
3. 페이지 안의 합성 이벤트가 필요한 앱(자동화 테스트 등)은 렌더러에서 `dispatchEvent`를 쓴다. 이 이벤트는 신뢰되지
   않은 입력으로 처리되며 호스트가 이를 바꾸지 않는다.
4. 텍스트 삽입과 편집 명령은 입력 주입이 아니라 편집 명령 항목에서 정한다. 이 결정은 그 항목을 제한하지 않는다.
5. 렌더러 API로 만들 수 없는 용도가 확인되면 별도 결정에서 다룬다. 이때 호스트가 만든 입력이 사용자 제스처를
   대신하지 않는 형태로만 검토한다.

## 근거

- 두 프레임워크가 다르다. Electron은 입력 주입을 제공하고 Tauri는 제공하지 않는다. 이 저장소에 쓰는 곳이 없고,
  페이지 안의 `dispatchEvent`와 편집 명령 항목이 필요한 대부분을 덮는다. 쓰는 곳이 없는 기능을 위해 코어 API와
  네이티브 입력 경로를 늘리지 않는다.
- 호스트 주입 입력은 사용자 제스처를 요구하는 웹 API(전체화면, 파일 선택, 클립보드, 팝업)를 앱 백엔드가 우회하는
  경로가 된다. 사용처 없이 열면 이 경계를 먼저 정해야 한다.
- IME는 Electron과 Tauri 모두 호스트 API 없이 엔진이 처리한다. 같은 방식을 따른다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

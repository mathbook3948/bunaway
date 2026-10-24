---
status: accepted
---

# Windows tablet 모드 조회는 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `1fe26611`.

## 배경

Windows tablet 모드인지 조회하는 API를 제공할지 정해야 했다. 창 상태 조회는 `visible`, `focused`, `minimized`,
`maximized`, `fullscreen`, `alwaysOnTop`만 제공한다. Snap 배치 상태 조회는 [ADR 0031](./0031-window-snapped-state.md)에서
제공하지 않기로 했고, tablet 모드는 그 결정에서 따로 정하기로 남겼다.

- Electron의 `BrowserWindow.isTabletMode()`는 Windows 전용이며 문서에는 Windows 10 tablet 모드로 적혀 있다.
  구현은 Chromium의 `IsWindows10TabletMode`로 `UIViewSettings.UserInteractionMode`가 Touch인지 확인한다.
- Windows 11에는 사용자가 켜고 끄는 기존 tablet 모드가 없고, 키보드 분리와 부착 같은 기기 자세로 바뀌었다.
  Chromium은 Windows 11용으로 변환형 기기, 태블릿으로 사용 중인지, 디스플레이 구성을 보는 비동기 경로를 따로 두지만
  Electron의 공개 API는 Windows 10 경로만 호출한다. 그래서 Windows 11에서 이 값은 앱이 기대하는 의미를 갖기 어렵다.
- Tauri 2와 tao, wry의 창 API에는 tablet 모드를 조회하는 API가 없다.

## 결정

1. tablet 모드 조회 API를 추가하지 않는다. 창 `state`와 `windows.changed`에 tablet 항목을 만들지 않는다.
2. 터치 환경에 맞춘 화면이 필요한 앱은 렌더러에서 입력 장치와 창 크기를 신호로 쓴다. 예를 들어 CSS 미디어 쿼리
   `(pointer: coarse)`와 `(hover: none)`, 창 크기 변화가 있다.
3. 위 방법으로 만들 수 없는 용도가 확인되면 별도 결정에서 다룬다. 이때 Windows 11 기기 자세를 기준으로 하는 비동기
   조회로 검토하며 Windows 10 전용 값을 그대로 노출하지 않는다.

## 근거

- 두 프레임워크가 다르다. Electron은 제공하고 Tauri는 제공하지 않는다. Electron의 값은 Windows 10 경로에 묶여 있어
  Windows 11에서 쓰기 어렵고, 이 저장소에서 쓰는 곳도 없다. 쓰는 곳이 없는 기능을 위해 코어 API를 늘리지 않고
  Windows 11 동작이 불분명한 값을 계약에 넣지 않는다.
- 터치 환경에 맞춘 화면은 tablet 모드라는 기기 상태보다 입력 장치와 화면 크기에 맞추는 편이 키보드가 붙은 태블릿과
  터치 노트북에서도 맞는다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 창 상태 문단에 tablet 모드 조회가 없다는 점과 대안을 적는다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시한다.

---
status: accepted
---

# Windows snapped와 tablet-mode 상태 조회는 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `313b07ee`.

## 배경

Windows 창이 Snap으로 배치됐는지, 시스템이 tablet 모드인지 조회하는 API를 제공할지 정해야 했다.
창 상태 조회는 `visible`, `focused`, `minimized`, `maximized`, `fullscreen`, `alwaysOnTop`만 제공한다.
`windows.getSnapshot()`의 `state`와 `windows.changed`도 같은 항목을 다룬다.

- Snap 배치는 창 상태가 아니다. 창은 일반(restored) 상태로 남고 위치와 크기만 작업 영역의 절반이나 모서리로 바뀐다.
  `GetWindowPlacement`와 `IsZoomed`는 Snap 여부를 따로 알려주지 않는다. 앱이 읽을 수 있는 값은 창 bounds와
  모니터 작업 영역뿐이라서 Snap 여부는 두 값을 비교한 추정이다. 사용자가 같은 크기로 직접 옮긴 창과 구분되지 않는다.
- tablet 모드는 Windows 10의 모드이고 Windows 11에서는 모드 전환이 없다. 2-in-1 기기의 키보드 분리 상태는
  `GetSystemMetrics(SM_CONVERTIBLESLATEMODE)`로 읽을 수 있으나, 창이 아니라 시스템 입력 상태이고 창 API가 소유할 값이 아니다.

## 결정

두 조회를 모두 추가하지 않는다. 창 `state`에 `snapped`나 `tabletMode` 같은 항목을 만들지 않는다.

- Electron은 `BrowserWindow`에 Snap이나 tablet 모드 조회를 제공하지 않는다. Tauri v2의 `Window`도 마찬가지다.
  둘이 같으므로 그대로 제공하지 않는다.
- 이 값은 추정에 의존하는 상태라 창 계약에 넣으면 사용자가 같은 배치를 만드는 경우와 구분하지 못하는 거짓 양성이 생기고,
  실행 환경이 Windows 11인지 10인지에 따라 의미가 달라진다.
- 앱이 필요하면 `windows.getOuterBounds`와 `windows.getMonitor`의 작업 영역을 비교해 직접 판단할 수 있다.
  tablet 모드와 키보드 분리 같은 입력 상태는 창 API가 아닌 별도 시스템 플러그인의 주제이며, 쓰는 곳이 생기면 그때 정한다.

## 영향

공개 API, 이벤트, 설정과 권한은 바뀌지 않는다. 문서에 지원하지 않는다는 사실만 적는다.

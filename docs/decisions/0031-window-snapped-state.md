---
status: accepted
---

# Windows Snap 배치 상태 조회는 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `313b07ee`.

## 배경

Windows 창이 Snap으로 배치됐는지 조회하는 API를 제공할지 정해야 했다.
창 상태 조회는 `visible`, `focused`, `minimized`, `maximized`, `fullscreen`, `alwaysOnTop`만 제공한다.
`windows.getSnapshot()`의 `state`와 `windows.changed`도 같은 항목을 다룬다.

Win32 문서 기준으로 다음 사실이 있다(이 저장소의 테스트로 검증한 것은 아니다).

- Snap 배치는 창 상태가 아니다. 창은 일반(restored) 상태로 남고 위치와 크기만 작업 영역의 절반이나 모서리로 바뀐다.
  `IsZoomed`와 `GetWindowPlacement`의 표시 상태는 Snap 여부를 따로 알려주지 않는다.
- 앱이 읽을 수 있는 값은 창 bounds와 모니터 작업 영역이므로 Snap 여부는 두 값을 비교한 추정이다.
  사용자가 같은 크기로 직접 옮긴 창과 구분되지 않는다.

## 결정

Snap 상태 조회를 추가하지 않는다. 창 `state`에 `snapped` 항목을 만들지 않는다.

- 추정에 의존하는 값을 창 계약에 넣으면 사용자가 같은 배치를 만든 경우와 구분하지 못하는 거짓 양성이 생긴다.
- 앱이 필요하면 `windows.getOuterBounds`와 `windows.getMonitor`의 작업 영역을 비교해 직접 판단할 수 있다.
  두 조회 모두 각자의 작업 이름 권한이 필요하며, 창 테두리 여백 때문에 허용 오차가 필요할 수 있다.

tablet 모드 조회는 이 결정에 포함하지 않는다. 별도로 정한다.

## 영향

공개 API, 이벤트, 설정과 권한은 바뀌지 않는다. 문서에 Snap 상태를 조회하지 않는다는 사실만 적는다.

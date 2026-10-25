---
status: accepted
---

# 혼합 DPI 화면의 공통 논리 좌표계와 지점 기준 변환은 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `b2061c78`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

배율이 다른 모니터를 함께 쓰는 Windows 화면에서 좌표 변환을 어디까지 제공할지 정해야 했다. 현재 계약은 다음과 같다.

- 화면 좌표(`setPosition`, `getOuterBounds`, `getCursorPosition`, `windows.changed`의 bounds, 모니터의 `bounds`와
  `workArea`)는 모두 가상 화면의 물리 픽셀이다.
- `windows.toLogical`과 `windows.toPhysical`은 대상 창의 현재 DPI 하나로 값 전체를 변환한다. 위치도 화면 원점
  `(0, 0)`에 같은 배율을 곱한다.
- `getMonitors`, `getMonitor`, `getMonitorNearestPoint`, `getMonitorNearestRect`는 모니터마다 물리 `bounds`, `workArea`,
  유효 `dpi`와 `scaleFactor`를 반환한다.

- Electron은 화면 좌표를 DIP로 다루는 `screen.screenToDipPoint`, `dipToScreenPoint`와 사각형 변환을 Windows에서 제공한다.
  변환에는 지점 또는 사각형이 놓인 디스플레이의 배율을 쓴다. `Display.bounds`는 DIP이고 `scaleFactor`를 함께 준다.
- Tauri 2와 tao의 모니터는 물리 `position`, `size`와 `scale_factor`를 주고 창 위치와 크기는 물리와 논리 단위 타입으로
  나뉜다. 논리 값으로 바꾸는 배율은 호출자가 고르며 모니터 전체에 걸친 공통 논리 좌표계는 없다.

## 결정

1. 혼합 DPI 화면 전체에 공통 논리 좌표계를 만들지 않는다. 화면 좌표의 기준은 계속 물리 픽셀이다.
2. 지점 또는 사각형이 놓인 모니터의 배율로 변환하는 API를 추가하지 않는다. `windows.toLogical`과 `windows.toPhysical`은
   대상 창의 현재 DPI만 쓴다.
3. 다른 모니터 기준의 논리 값이 필요한 앱은 `windows.getMonitorNearestPoint` 또는 `getMonitorNearestRect`로 모니터를
   고르고 그 모니터의 `scaleFactor`로 직접 변환한다.
4. 위 방법으로 만들 수 없는 용도가 확인되면 별도 결정에서 다룬다.

## 근거

- 두 프레임워크가 다르다. Electron은 지점 기준 변환을 제공하고 Tauri는 모니터의 배율만 주고 변환을 호출자에게 맡긴다.
  이 저장소는 이미 모니터별 `scaleFactor`와 물리 좌표 모니터 조회를 공개하므로 두 호출로 같은 결과를 얻을 수 있다.
  쓰는 곳이 없는 변환 API를 코어에 더하지 않고 계약을 작게 유지하는 쪽을 따른다.
- 공통 논리 좌표계는 모니터 배율마다 논리 좌표의 간격이 달라져 인접한 모니터 경계에서 연속하지 않을 수 있다. 창 배치 API는
  모두 물리 좌표를 받아 반올림 오차 없이 모니터 경계를 다룬다. 공통 논리 좌표를 만들면 이 API와 단위가 둘로 갈린다.
- 창이 두 모니터에 걸치면 어느 배율을 쓸지 정해야 한다. 창 단위 변환은 Windows가 그 창에 적용 중인 DPI를 기준으로 하므로
  창의 크기 제약과 `setSize`의 논리 단위와 같은 값을 쓴다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 좌표 변환 문단에 지점 기준 변환이 없다는 점과 대안을 적는다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시한다.

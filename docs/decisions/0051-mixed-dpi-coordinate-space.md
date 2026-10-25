---
status: accepted
---

# 혼합 DPI 화면의 공통 논리 좌표계와 지점 기준 변환은 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `b2061c78`.

## 배경

배율이 다른 모니터를 함께 쓰는 Windows 화면에서 좌표 변환을 어디까지 제공할지 정해야 했다. 현재 계약은 다음과 같다.

- 화면 좌표(`setPosition`, `getOuterBounds`, `getCursorPosition`, `windows.changed`의 bounds, 모니터의 `bounds`와
  `workArea`)는 모두 가상 화면의 물리 픽셀이다.
- `windows.toLogical`과 `windows.toPhysical`은 대상 창의 현재 DPI 하나로 값 전체를 변환한다. 위치도 화면 원점
  `(0, 0)`에 같은 배율을 곱한다.
- `getMonitors`, `getMonitor`, `getMonitorNearestPoint`, `getMonitorNearestRect`는 모니터마다 물리 `bounds`, `workArea`,
  유효 `dpi`와 `scaleFactor`를 반환한다.

다른 프레임워크는 다음과 같다. 아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의
테스트로 검증한 것은 아니다.

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

- 이 저장소는 Tauri처럼 모니터의 물리 `bounds`와 `scaleFactor`를 공개하고 변환의 기준 모니터는 호출자가 고르게 한다.
  Electron의 지점 기준 변환은 같은 정보를 코어가 대신 조합하는 것이므로, 코어는 작게 두고 앱이 조합하게 한다.
- 지점과 사각형 기준 모니터 조회가 이미 있다. `scaleFactor`는 `dpi / 96`이라 물리 값을 `scaleFactor`로 나누면 그 모니터의
  논리 값이다. 이 식은 대상 창이 그 모니터에 있을 때 `windows.toLogical`과 같고, 앱이 직접 계산하면 `toLogical`이 적용하는
  정수 반올림, `-0` 정규화와 범위 검사만 앱이 필요한 만큼 맞춰야 한다.
- 이 변환을 쓰려는 요구가 아직 없다. 요구가 생기면 결정 4에 따라 다시 정한다.
- 창 기준 단위는 이미 물리와 논리가 섞여 있다(화면 좌표는 물리, `setSize`와 크기 제약은 창 DPI의 논리). `margin`은 논리
  값이지만 대상 모니터의 DPI로 변환하므로 모니터 기준 변환이 일부 있다. 공통 논리 좌표계는 여기에 모니터마다 배율이 다른
  세 번째 기준을 더하므로 만들지 않는다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 좌표 변환 문단에 지점 기준 변환이 없다는 점과 대안을 적는다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시한다.

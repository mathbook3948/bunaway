---
status: accepted
---

# 초기 창 배치와 중앙 배치의 공통 계약

결정일: 2026-10-12. Windows에서 먼저 구현한다. 런타임 center API와
resizable, movable은 이 결정의 구현 범위가 아니다.

## 입력과 병합

선언의 `window`와 네 생성 API의 `options.window`에 `x`, `y`, `center`,
`useContentSize`, `preventOverflow`를 추가한다. ADR 0016과 0017의 필드별 병합과
선언값 보존을 따른다. x/y는 signed 32-bit 정수인 outer의 물리 화면 좌표다.
둘 다 생략하거나 `null`이면 위치를 지정하지 않는다. 한 축만 지정하면 오류다.
음수 좌표도 허용한다. `center: true`와 좌표가 병합 결과에 함께 있으면
`INVALID_ARGUMENT`다. 어느 쪽도 조용히 우선하지 않는다. 선언의 좌표를 없애려면
호출에서 x/y를 모두 null로, 선언의 center를 해제하려면 false로 지정한다.

width/height는 기존 200–4096 정수와 96-DPI 논리 단위를 유지한다.
`useContentSize`는 기본 true다. false이면 요청 크기를 outer 크기로 해석한 뒤
대상 DPI의 프레임을 빼 content 크기로 바꾼다. min/max는 이 옵션과 관계없이
항상 논리 content 제약이다. 보정된 content와 프레임으로 실제 outer를 계산한다.
호출 옵션의 outer 크기를 병합 단계에서 content 제약으로 미리 보정하지 않는다.

## 모니터 선택과 재사용 경계

초기 좌표가 있으면 그 점에 가장 가까운 모니터를 `MonitorFromPoint`의
`MONITOR_DEFAULTTONEAREST`로 고른다. 모니터 안에 있는 점은 해당 모니터를 선택한다.
없으면 주 모니터를 선택한다. 현재 창이나 마우스, 마지막 활성 창을 기준으로 하지 않는다.
중앙 배치와 overflow는 선택한 모니터의 `GetMonitorInfoW.rcWork`를 사용한다.
태스크바를 제외한 작업 영역이고 음수 원점을 그대로 유지한다. 프레임을 포함한
outer rectangle을 기준으로 계산하며 content의 중앙을 맞추지 않는다.

후속 런타임 center 작업은 명시한 모니터가 있으면 그 모니터, 없으면 대상 창의
현재 모니터를 선택한다. 화면 좌표의 normal bounds와 가장 가까운 모니터를 쓰고,
최소화, 최대화, 전체화면 때의 normal monitor는 기존 보존 계약을 재사용한다.
지정 모니터가 사라졌으면 `INVALID_ARGUMENT`이며 주 모니터로 조용히 대체하지 않는다.
Win32 모니터 핸들은 공개 영속 ID가 아니다. 런타임 API가 도입될 때 공개 모니터
식별자를 해석하되 선택한 `rcWork`와 물리 outer 크기는 같은 순수 계산에 전달한다.

`window-placement.ts`는 작업 영역, DPI, 프레임을 입력받아 순수 크기와 위치 계산을
담당한다. Win32 조회와 자원 소유는 `Windows`에 남긴다. `getPlacementMonitor`와
`getWorkArea`는 모니터 선택과 작업 영역 조회를 제공한다. `centerInWorkArea`는
후속 중앙 배치에서도 재사용한다. 이미 존재하는 physicalPixels, logicalPixels,
clampWindowSize를 재사용한다. 변환과 중앙 계산은 Math.round로 가장 가까운 정수,
정확한 반은 양의 무한대 방향으로 반올림한다. 화면 좌표는 DPI로 다시 배율하지 않는다.
rectangle의 오른쪽과 아래쪽까지 signed 32-bit 범위를 검사한다.

## 위치 생략과 overflow

center와 preventOverflow가 모두 false이고 위치를 생략하면 기존 OS 기본 배치를
보존한다. 크기는 실제 생성 위치의 DPI로 적용한다. center이면 주 모니터의 작업
영역 중앙에 배치한다. 위치 없이 preventOverflow만 켜면 주 모니터 작업 영역의
왼쪽 위에서 시작한다. center와 preventOverflow는 함께 사용할 수 있다.

preventOverflow는 기본 false이며 초기 생성에만 적용한다. false일 때 작업 영역보다
큰 창과 화면 밖 좌표를 허용한다. true일 때 먼저 content min/max로 보정하고,
작업 영역에서 프레임을 뺀 공간에 맞는 논리 content 크기로 줄인 뒤 위치를 clamp한다.
축별 크기를 독립적으로 줄이며 최소 content 크기보다 작아지면 INVALID_ARGUMENT다.
min을 생략했을 때 overflow 계산의 content 하한은 1 논리 픽셀이다. 200은 입력 범위이며
자동 축소 결과의 하한은 아니다. max는 상한이므로 축소와 충돌하지 않는다.
배율 반올림 후에도 물리 outer가 실제 작업 영역을 넘지 않는 논리 크기를 선택한다.
이후 사용자의 이동, 크기 조절과 모니터 변경을 계속 제한하는 옵션이 아니다.

## 오류와 수명

설정은 모든 선언을 검증한다. startup, 지연 생성, single과 multiple의 생성 및
재생성에 같은 배치를 적용한다. 초기 시작에서는 모든 startup 창의 네이티브 배치를
먼저 검증한다. 생성 요청은 schema, 병합과 플랫폼 검사 및 작업 영역에 대한 배치
검증 뒤에만 예약과 기존 창 종료를 시작한다. 입력 오류는 기존 HWND와 세션을 보존한다.
선택한 모니터 정보는 생성 시 다시 읽는다. 검증 후 디스플레이 구성이 바뀌는 OS 경쟁은
네이티브 생성 실패로 처리하며 이미 승인한 종료를 되돌리는 보장은 없다.

macOS는 새 배치 필드를 명시한 선언을 startup 여부와 관계없이 UNSUPPORTED로 거부한다.
false나 true인 기본값의 명시도 예외가 아니다. 잘못된 설정은 먼저 공통 검증에서 거부한다.
비어 있지 않은 호출별 options는 기존대로 기존 창 종료 전에 UNSUPPORTED다.
옵션을 생략한 기존 macOS의 content 크기와 배치는 바꾸지 않는다.

## 검증 경계

순수 테스트로 음수 원점, 작업 영역 경계, DPI 96/120/144/192, 반올림, 크기 기준과
제약 충돌을 검증한다. 계약 테스트는 선언 보존과 예약 전 거부를 검증한다.
실제 HWND 및 WebView2 경로는 저장소의 Windows 네이티브 검사와 windows-native CI를
사용한다. 합성 모니터와 DPI 입력은 다중 물리 모니터 실행 검증을 대신하지 않는다.

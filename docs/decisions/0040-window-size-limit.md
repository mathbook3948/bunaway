---
status: accepted
---

# 창 크기 입력 상한을 4096에서 8192 논리 픽셀로 올리고 하한 200은 유지한다

결정일: 2026-10-25. 검토 기준: main `8f4d5bcb`. 프레임워크 기준: Electron 45.0.0, Tauri 2.12.5(wry 0.57.0). 아래 두 프레임워크 서술은 문서에서 확인한 내용이며, `WM_SIZE`와 배율에 관한 Windows 서술은 구현 검증 전 가정이다. 어느 쪽도 이 저장소의 테스트로 실행한 것은 아니다.

## 배경

설정(`window.width`, `height`, `minWidth`, `minHeight`, `maxWidth`, `maxHeight`)과 실행 중 `setSize`,
`setMinSize`, `setMaxSize`, `setSizeConstraints`는 96 DPI 기준 논리 픽셀 정수 200–4096만 받는다
(`MIN_WINDOW_DIMENSION`, `MAX_WINDOW_DIMENSION`). 이 범위가 실제 모니터와 DPI에 맞는지 다시 보고, 4096
상한을 유지할지 정해야 했다.

- 상한은 논리 픽셀이므로 DPI가 오르면 물리 픽셀 상한도 함께 오른다(200% 배율에서 8192). DPI 때문에 값을 바꿀
  필요는 없다. 문제가 되는 쪽은 배율이 낮은 큰 화면이다. 100% 배율의 5120×1440 울트라와이드와 7680폭 8K
  모니터는 폭이 4096을 넘어 한 화면을 채우는 창을 만들 수 없다.
- 상한을 넘는 요청은 `INVALID_ARGUMENT`다. `window-state`가 저장한 크기를 복원할 때도 같은 상한으로 자르므로
  4096보다 넓은 창을 쓰던 사용자는 다음 실행에서 창이 줄어든다.
- `setOuterSize`, `setContentBounds`, `setOuterBounds`도 바깥 크기에서 프레임을 뺀 내용 크기가 같은 범위
  (200–`MAX_WINDOW_DIMENSION`)여야 해서 같은 상한에 걸린다(`win32.ts`의 `requestedOuterSize`). 입력 스키마 단계에서는
  크기를 0–2147483647로 받고, 그 뒤에 이 범위 검사가 따로 붙는다. `setSize`의 범위 검증은 계약의 zod
  (`plugins/windows/src/contract.ts`)가 같은 상수로 한다. `clampWindowSize`는 상수를 읽지 않고 받은 제약만 쓴다.
- 문서에서 확인한 범위에서 Electron의 `BrowserWindow` 생성 옵션과 `setSize`, `setMinimumSize`, `setMaximumSize`는
  크기 상한을 명시하지 않는다. Tauri 2의 `inner_size`, `min_inner_size`, `max_inner_size`도 부동소수점 논리 크기를
  받고 상한을 명시하지 않는다.
- `WM_SIZE`는 클라이언트 폭과 높이를 16비트 값 두 개로 전달한다. 호스트의 `WM_SIZE` 처리(`ui.ts`)는 이 값을
  읽지 않는다(`webview.ts`는 `GetClientRect`로 크기를 다시 읽는다). 가정으로, Windows 설정의 최대 배율을 500%로 보면
  8192 논리 픽셀은 물리 40960으로 65535 아래다. 16비트 한계가 이 호스트의 어떤 코드를 깨뜨리는지는 확인하지 못했다.
- 호스트는 `WM_GETMINMAXINFO`에서 앱 제약이 있는 축의 최소는 시스템 최소와 앱 최소 중 큰 쪽, 최대는 작은 쪽으로
  정한다. 최소가 시스템 최대 추적 크기를 넘어도 줄이지 않는다. 작은 화면에서 `minWidth: 4096`을 주면 이미
  일어나는 동작이지만, 상한을 올리면 허용 범위가 두 배가 되어 그런 요청이 늘 수 있다. 초기 배치 경로
  (`initialOuterSizes`)는 다르게 동작하므로 구현 때 함께 확인한다.

## 결정

1. 논리 크기 입력의 상한 `MAX_WINDOW_DIMENSION`을 4096에서 8192로 올린다. 100% 배율의 5120폭 울트라와이드와
   7680폭 8K 모니터를 채우는 크기를 넣을 수 있다. 하한 `MIN_WINDOW_DIMENSION` 200은 유지한다.
2. 상한은 문서상 상한을 명시하지 않는 Electron, Tauri와 달리 유한값으로 둔다. 설정 오류(자릿수 실수)를 조기에
   거부하고 모든 크기 API가 같은 범위와 오류 메시지를 쓰게 하는 입력 검증용이다. 8192는 지금 확인된 요구(5120,
   7680)를 모두 덮는 가장 작은 2의 거듭제곱이며, 8K 둘을 이은 15360 같은 걸침 창은 요구로 확인되지 않아 다루지
   않는다. 그런 요구가 확인되면 별도 결정에서 올린다.
3. 하한 200은 바꾸지 않는다. 문서상 Electron은 0도 받고 Tauri는 하한을 명시하지 않지만, 하한을 낮추는 것은 이번
   항목(상한 재검토)의 범위가 아니고 사용처도 확인되지 않았다. 필요가 확인되면 별도 결정에서 다룬다.
4. 동작 변경은 상수와 그 값을 문장에 적은 곳(오류 메시지, 설정과 창 문서, 문제 해결 문서)에 한정한다.
   `window-state`의 복원 보정, 호스트의 내용 크기 검사(`win32.ts`의 `requestedOuterSize`), 계약의 zod 범위
   (`setSize` 포함), `isWindowSizeDimension`, 설정 검증(`window-config.ts`)은 모두 이 상수를 읽으므로 로직은 따로
   바꾸지 않는다. 상수가 macOS 설정 검증과 공유되므로 macOS 호스트와 테스트도 같은 상한을 따른다.

## 근거

- 문서에서 확인한 범위에서 두 프레임워크 모두 4096 같은 고정 상한을 명시하지 않는다. 4096은 이 저장소 고유의
  제한이고 지금 모니터 구성(울트라와이드, 8K)에서 이미 걸린다.
- 구현 검증에서 높은 배율이나 큰 `min*` 값의 문제가 확인되면 이 결정을 개정한다.

## 결과

- 이 결정은 코드를 바꾸지 않는다. 구현은 후속 항목으로 TODO에 둔다: 상수 변경, `win32.ts` 오류 문구와 문서에 적힌
  `200..4096` 문구 갱신(ADR 0016, 0019 포함), 4096을 가정한 테스트(`window-state-persistence.test.ts`,
  4097 거부 단언(`windows-geometry.test.ts`, `protocol.test.ts`, `windows-config.test.ts`, `window-creation.test.ts`)과 상한보다 큰 값도 변환함을 확인하는 허용 단언
  (`tests/api/window-geometry.test.ts`의 `toPhysical`), `windows-window-placement.test.ts`의 4096 리터럴과 이름,
  `windows-initial-placement.ts`와 그 fixture) 갱신.
- `tests/lifecycle/macos-webview-regressions.ts`는 제약이 없을 때 `contentMaxSize`의 모든 값이 상수보다 큰지
  확인한다. AppKit의 "무제한" 값이 8192보다 큰지는 이 결정에서 확인하지 못했으므로 구현 때 macOS CI로 확인한다.

---
status: accepted
---

# 호스트가 측정하는 startup 시간과 WebView 렌더러 내부 지표는 제공하지 않는다

결정일: 2026-10-28. 검토 기준: main `58ddd4ee`.

## 배경

앱 상태 지표 중 프로세스별 working set과 누적 CPU 시간은 `os.listAppProcesses`가 제공한다. 남은 두 가지를 제공할지 정해야
했다.

- startup 시간: 프로세스 시작부터 창이 보이고 SDK가 준비될 때까지 호스트가 재어 주는 경과 시간.
- 렌더러 내부 지표: WebView2 렌더러의 JS 힙, 레이아웃 횟수, 프레임 시간 같은 값.

비교 기준은 다음과 같다.

- Electron은 호스트가 계산한 startup 시간을 주지 않는다. `process.getCreationTime()`은 프로세스 생성 시각만 돌려주고,
  `app.getAppMetrics()`는 프로세스별 CPU, 메모리, 생성 시각을 준다. 호스트가 startup 시간이나 렌더러 지표를 모아 주는 API는 없고,
  앱이 페이지의 `performance` API와 렌더러 쪽 `process`, `webFrame`이 주는 값(힙 통계 등)을 직접 조합한다.
- Tauri는 지표 API가 없다. startup 시간도 렌더러 내부 지표도 앱이 직접 잰다.
- WebView2는 프로세스 정보 외에 렌더러 내부 지표를 위한 공개 API를 주지 않는다. 내부 지표를 얻는 방법은 DevTools 프로토콜의
  `Performance.getMetrics` 같은 명령뿐이다. 호스트는 내부 동작(reload 등)에서 DevTools 프로토콜 메서드를 직접
  호출하지만 앱이 쓰는 공개 연산으로는 노출하지 않으며, 노출할지는 별도 항목에서 정한다.
- 위 Electron과 Tauri, WebView2 서술은 공개 문서에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.
- 이 저장소의 앱은 `windows.readiness` 이벤트와 `windows.getReadiness` 조회로 네이티브 창 생성, 문서 완료, SDK 협상의 완료
  상태를 받는다. 렌더러의 `performance.timeOrigin`과 `PerformanceNavigationTiming`은 페이지 안에서 읽을 수 있고, 백엔드는
  자기 시작 지점에서 시각을 기록할 수 있다.

## 결정

1. 호스트가 측정한 startup 시간을 코어와 플러그인의 공개 연산, 이벤트, 설정으로 제공하지 않는다. `windows.readiness`와
   `windows.getReadiness`의 스키마에 타임스탬프를 추가하지 않는다.
2. 앱이 필요하면 직접 계산한다. 백엔드 진입 시점에 `Date.now()`를 기록해 두고, 정책이 허용한 UI가 `windows.readiness`
   이벤트에서 `document`와 `sdk`가 모두 `ready`가 되는 시점을 받아 차이를 구한다. 이 값은 앱이 관측한 시각이다. UI가 구독하기 전에 단계가 끝났다면
   `windows.getReadiness`를 조회한 시점이 기준이 되어 UI 초기화 시간이 섞이고, 백엔드만 쓰면 조회 간격만큼 오차가 생긴다.
   준비가 끝난 정확한 시각은 제공하지 않는다. 이 값은 백엔드 진입부터 준비 완료까지이며 프로세스 시작이나 창 생성
   시점부터가 아니다. 페이지 안의 시간은 `performance.timeOrigin`과 `PerformanceNavigationTiming`으로 잰다. 프로세스 시작 시각 자체의 조회는 이 결정에 포함하지 않으며 지금 계약에도 없다.
3. WebView2 렌더러 내부 지표(JS 힙, 레이아웃, 프레임 시간)를 공개 연산으로 제공하지 않는다. 페이지 안에서 `performance`
   API로 읽을 수 있는 값은 앱이 직접 읽고, 프로세스 단위 값은 `os.listAppProcesses`가 준다.
4. `UNSUPPORTED` 항목이나 선택 렌더러 요구 사항을 새로 만들지 않는다. 제공하는 공개 연산이 없으므로 표시할 대상이 없다.
   선택 Chromium 렌더러를 연결하는 결정이 나면 렌더러 지표를 다시 검토한다.

## 근거

- Electron과 Tauri 모두 호스트가 startup 시간을 계산해 주지 않고, 호스트가 지표를 모아 주는 API도 없다. 같은 방식을 따른다.
- 앱이 이미 받는 readiness 이벤트와 기록한 시각, 페이지의 `performance` API로 같은 값을 얻을 수 있다. 호스트 타임스탬프를
  계약에 넣으면 모든 앱이 받는 코어 계약이 커지고, 값의 기준(창 표시, 문서 완료, SDK 협상 중 어느 시점)이 앱마다 달라 한 가지
  정의로 고정하기 어렵다.
- 렌더러 내부 지표는 DevTools 프로토콜로만 얻을 수 있다. 호스트가 내부에서 쓰는 호출을 지표 조회에 재사용할 수는 있지만, 앱이 쓰는 지표 연산을 새로 만들면 공개 계약이 커지고 Electron과 Tauri에도 없는 기능이므로 만들지 않는다. 이 결정은 지표 전용 연산을 만들지 않는다는 데까지만 정하며, DevTools 프로토콜을 공개 연산으로 노출할지는 별도 항목에서 정한다.

## 결과

- 코드와 공개 계약은 바뀌지 않는다.
- `os.listAppProcesses`가 제공하는 프로세스별 working set과 CPU 시간이 이 영역의 제공 범위다.

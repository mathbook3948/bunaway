---
status: accepted
---

# 종료 지연(ShutdownBlockReason) API를 제공하지 않는다

결정일: 2026-10-25.

## 배경

앱 정의에 Windows의 `ShutdownBlockReasonCreate` 기반 종료 지연 API를 선택 기능으로 제공할지 정해야 했다.
이 저장소에는 해당 호출을 쓰는 코드와 테스트가 없다. 아래 외부 동작은 2026-10-25에 Microsoft Learn 문서,
Electron v45.0.0, Tauri 2.12.5(tao 0.37.0)에서 확인한 것이며 이 저장소의 테스트로 실행한 것은 아니다.

Win32 동작:

- `ShutdownBlockReasonCreate`는 창에 사유 문자열을 등록할 뿐 그 자체로 종료를 막지 않는다. 등록한 사유는
  종료가 막혀 차단 화면이 나올 때 표시된다. 차단 화면이 나오려면 앱이 `WM_QUERYENDSESSION`에 FALSE를 반환하거나
  응답을 5초 넘게 지연해야 한다.
- 사용자는 차단 화면에서 언제든 강제 종료를 고를 수 있다. 콘솔 앱과 보이는 창이 없는 앱은 종료를 막을 수 없다.
- 문서의 권고는 앱이 종료를 막지 않고 막을 수 있다고 기대하지도 않는 것이다. `WM_QUERYENDSESSION`의 기본 반환은
  TRUE이고 정리는 `WM_ENDSESSION`에서 하도록 안내한다.

Electron과 Tauri:

- Electron은 Windows에서 BrowserWindow `query-session-end`(`preventDefault`로 FALSE를 반환해 종료 거부 가능)와
  `session-end`(막을 수 없고, 앱이 종료 중이 아니면 이후 프로세스를 즉시 끝낸다)를 제공한다.
  `ShutdownBlockReasonCreate`는 호출하지 않는다.
- Tauri 2와 tao는 세션 종료 이벤트도 차단 API도 없다. `WM_QUERYENDSESSION`을 처리하지 않아 TRUE가 반환되고,
  `WM_ENDSESSION`에서 종료 이벤트를 보낸 뒤 프로세스를 끝낸다. 기능 요청 tao#1115가 열려 있다.

이 저장소의 세션 종료 계약은 [ADR 0020](./0020-close-and-quit-lifecycle.md)에 있다.

- `WM_QUERYENDSESSION`은 항상 TRUE로 응답한다. `WM_ENDSESSION(TRUE)`는 취소할 수 없는 `"session-end"` 종료이고,
  UI 스레드는 최대 4초 동안 `onWillQuit`과 플러그인 StopHook을 기다린 뒤 반환한다.
- 4초 안에 끝나지 않는 작업(대용량 저장, 업로드, 설치)을 위한 수단은 지금 없다.
- 이 요구를 가진 앱은 확인되지 않았다. 검토 시점의 열린 이슈와 저장소 전체 검색에서 예제, 템플릿, 코드에
  이 기능을 쓰거나 요구하는 곳이 없었고 ADR 0020과 TODO 문구만 `ShutdownBlockReason`을 언급한다.

## 결정

1. `ShutdownBlockReasonCreate`와 `ShutdownBlockReasonDestroy`에 대응하는 공개 API, 설정, 이벤트를 추가하지 않는다.
2. 세션 종료의 ADR 0020 계약(항상 허용, 4초 기한, 취소 불가)을 바꾸지 않는다.
3. 앱은 변경이 생길 때마다 저장하고, 종료 때는 `onWillQuit`의 기한 3초 안에 끝나는 마지막 저장만 한다.
   세션 종료에서는 `onWillQuit`과 Core 정지가 4초를 나눠 쓰므로 `onWillQuit`이 3초를 다 쓰면
   Core 정지에는 1초가 남는다. `onWillQuit` 안에서는 창이나 클립보드 같은 호스트 작업이 `INVALID_ARGUMENT`로
   실패하므로 이 저장은 백엔드 안의 작업(파일 쓰기 등)이어야 한다.
   이 방법으로도 부족한 실제 앱 요구가 확인되면 이 ADR을 개정하는 별도 결정으로 다룬다.

## 근거

- 차단 사유를 등록하는 API는 Electron도 Tauri도 제공하지 않는다. 이 점에서 같은 방식을 따른다.
  Electron은 이와 별개로 종료 거부 수단(`query-session-end`)을 갖고 있고 이 저장소는 그렇지 않다는 차이가 아래에 있다.
- 사유는 차단 화면이 나올 때만 보이고, 차단 화면은 `WM_QUERYENDSESSION`에 FALSE를 반환하거나 그 응답을
  5초 넘게 지연해야 나온다. ADR 0020은 `WM_QUERYENDSESSION`에 즉시 TRUE로 응답하므로(4초 대기는 그 뒤
  `WM_ENDSESSION(TRUE)` 단계의 시간이다) 사유 등록만 추가해서는 사용자에게 보이지 않는다. 보이게 하려면
  종료 거부나 쿼리 응답의 5초 초과 지연이 필요하고, 이는 0020의 계약을 바꾸는 일이다.
- Electron이 Windows에서 제공하는 종료 거부(`query-session-end`)는 이 결정의 대상이 아니다. 0020은 `beforeQuit`이
  비동기라 동기 메시지 안에서 답할 수 없고 사용자가 이미 종료를 요청했다는 이유로 항상 허용을 정했으며,
  이 점은 Tauri와 같다. 이 PR은 그 결정을 바꾸지 않는다.
- 사유 문자열, 해제 규칙, 차단 중 메시지 처리, `onQuit` 보장 범위는 한 번 공개하면 바꾸기 어려운 계약이다.
  쓰임이 확인되기 전에 정하면 다시 고쳐야 할 가능성이 크다.
- 세션 종료는 UI 스레드의 모든 HWND가 하나의 처리기를 공유한다(클립보드 창 제외). 선택 기능 하나를 위해 이
  처리기에 차단 상태를 더하면 모든 앱의 종료 수명 주기가 복잡해진다.

## 열린 질문

나중에 제공한다면 다음을 먼저 공개 계약으로 정해야 한다.

- `WM_QUERYENDSESSION` 거부나 5초 초과 지연을 허용할지. 허용한다면 ADR 0020의 항상 허용과 4초 기한을 개정해야 한다.
- 사유 문자열의 길이, 로컬라이즈, 갱신 방법.
- 작업 완료, 앱 정의의 취소, 프로세스 종료, 사용자의 강제 종료 선택에 따른 해제 규칙.
- 차단 중 UI 스레드의 메시지 처리, `onQuit`과 네이티브 정리의 보장 범위.
- 플러그인이 차단 상태를 가질 수 있는지. ADR 0020은 UI 스레드의 모든 HWND가 하나의 처리기를 공유하고
  플러그인 전용 창(클립보드)은 제외한다고 정하므로, 선택 플러그인으로 두려면 이 처리기와의 관계를 먼저 정해야 한다.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 ShutdownBlockReason 항목을 결정 완료로 바꾸고 이 ADR을 가리킨다.

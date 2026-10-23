---
status: accepted
---

# 앱 하나는 WebView 하나와 창 하나로 실행한다

결정일: 2026-10-23. 검토 기준: main `6f32e6cd`.

## 배경

bunaway의 목표는 TypeScript만으로 데스크톱과 모바일 앱을 쉽게 만드는 것이다.
지금 데스크톱 창 모델은 Electron의 `BrowserWindow` 여러 개를 기준으로 커졌다.

- [ADR 0004](./0004-multi-window-per-view-policy.md)는 창마다 정책 뷰를 붙이고 뷰별 프로필과 세션을 분리했다.
- [ADR 0016](./0016-window-creation-contract.md)은 사전 선언 창의 호출별 생성 옵션을 정했다.
- [ADR 0017](./0017-multiple-windows-per-view.md)은 같은 뷰의 창 인스턴스 여러 개를 도입했다.
- 그 결과 창 계약은 거의 모든 작업 입력에 `{ view, windowId? }`를 받고, 호스트는 창 인스턴스, 부모와 모달 관계,
  격리 프로필, 창별 세션 라우팅을 소유한다.

반면 모바일 호스트는 이미 단일 화면이다([ADR 0015](./0015-android-bundled-process-host.md),
[ADR 0018](./0018-ios-embedded-bun-worker.md)).

앱 개발자는 플랫폼마다 다른 창 모델을 배워야 하고, 데스크톱에서만 쓰는 창 선택 인자를 모든 호출에 넘긴다.
다중 창 계약은 세션 라우팅, 프로필 소유권, 상한 예약, 부모 종료 순서처럼 보안 경계와 수명주기에 걸친 규칙을
늘렸고, 새 창 기능마다 이 규칙을 다시 검증해야 한다.

## 결정

bunaway는 데스크톱과 모바일 모두 **앱 하나에 WebView 하나, 창 하나**인 앱 런타임으로 정의한다.

1. **화면 단위.** 앱은 실행 중 네이티브 창을 최대 하나 가진다. 그 창은 WebView 하나와
   정책 뷰 하나를 가진다. 화면 전환과 모달은 같은 WebView 안의 웹 라우팅과 웹 UI로 한다.
   데스크톱에서는 창을 닫았다 다시 만들 수 있지만(트레이, `keep-alive`) 동시에 두 개를 열지 않는다.
   창을 만들지 않고 시작하는 앱(`app.startup: false`)과 창을 숨긴 채 상주하는 앱(`app.visible: false`)은
   `bunaway.json`의 `app` 필드로 표현한다. 창을 숨겨 상주하는 트레이 앱은 숨긴 창과 문서 세션이 시작부터
   남는 비용을 받아들인다.
2. **정책.** 정책 뷰는 하나다. `policy.json`의 `views` 배열 형식은 유지하고 항목 수를 1로 제한한다.
   권한 이름은 계속 완전한 Host operation 이름(`windows.setOuterSize` 등)이며 바꾸지 않는다.
   [ADR 0002](./0002-host-owned-call-context.md)의 호스트 발급 호출 컨텍스트는 그대로 유지한다.
3. **창 제어 대상.** 창 API는 대상 인자 없이 앱의 창을 제어한다. 웹 문서와 백엔드가 같은 창을 가리킨다.
   `view`와 `windowId` 입력은 모든 플러그인에서 바로 제거한다. `windowId`는 창 수명 식별자로
   `windows.getSnapshot()` 결과와 이벤트 payload에 남겨, 호출자가 재생성 여부를 구분하는 데 쓴다.
   창이 열려 있는지는 `windows.isOpen()`으로 조회한다. `windows.list()`와 `isDestroyed`는 `isOpen`이 대신한다.
   창이 없을 때 창 제어와 상태 조회는 `INVALID_ARGUMENT`로
   실패한다. 예외로 `windows.create()`와 `windows.recreate()`는 창을 만들고, `windows.isOpen()`과 창과 무관한 작업
   (모니터, 커서)은 성공하며, `windows.getReadiness()`는 닫힌 창의 마지막 결과를 유지한다(창을 한 번도 만들지 않았으면
   `INVALID_ARGUMENT`). 창이 없을 때 `windows.destroy()`는
   아무 일도 하지 않고 `true`를 돌려주며 앱 종료는 `quit`만 맡는다. 플랫폼 미지원(`UNSUPPORTED`) 판정이 창 없음
   판정보다 앞서므로, `destroy`가 `UNSUPPORTED`인 macOS와 모바일에서는 창이 없어도 `UNSUPPORTED`다.
4. **창 수명 이벤트.** `windows.lifecycle`은 문서 세션뿐 아니라 백엔드도 받는다. 백엔드는 windows 플러그인이 제공하는
   구독 API로 권한 검사 없이 모든 단계를 받는다. 문서 세션은 정책 `events`와 `windows.getSnapshot` 권한을 요구한다.
   앱 종료나 세션 종료가 시작된 뒤에는 전송하지 않는다.
5. **모바일.** 창 크기, 위치, 최대화, 전체화면, Z 순서, 작업 표시줄 같은 데스크톱 창 작업과 창 수명 작업
   (`create`, `recreate`, `close`, `destroy`, `show`, `hide`, `respondClose`)은 Android와 iOS에서 `UNSUPPORTED`로
   실패한다. 앱은 `capabilities()`로 작업별 지원 여부를 먼저 조회한다. 경고만 남기고 성공으로 처리하지 않는다.
   모바일은 `app.startup: false`와 `app.visible: false`를 거부하고 `app.showWhenReady`는 무시한다.
   Android는 `launchMode`를 `singleTask`로 두어 Activity를 하나로 제한하고, 두 번째 실행은 기존 창을 앞으로 가져온다.
6. **`window.open`과 링크.** 새 창 요청은 창을 만들지 않는다. 정책 뷰의 `origins` 안 문서가 시작한 요청만 처리하고,
   `origins`에 속한 URL은 같은 WebView에서 탐색한다. 그 밖의 `http`, `https` URL은 opener 플러그인(`opener.openUrl`)을
   거쳐서만 시스템 기본 브라우저로 넘기며, opener가 없거나 권한이 없으면 차단하고 진단을 남긴다. 다른 scheme은
   차단한다. Android와 iOS는 opener 어댑터가 생길 때까지 외부 URL을 차단한다. 세부는 아래 "열린 질문"의 기본값에서
   구현 단계에 확정한다.
7. **Android 뒤로가기.** 시스템 뒤로가기는 WebView history를 먼저 소비하고, 더 돌아갈 곳이 없을 때만
   Activity를 종료한다.
8. **다중 창은 코어 계약이 아니다.** 필요성이 확인되면 별도 플러그인의 opt-in 기능으로 다시 제안한다.
   그때도 이 결정의 기본값(창 하나)을 바꾸지 않는다. 다중 창 API는 바로 제거한다. 개발 단계이므로 이전 형식과의
   호환, 경고, 유예 기간을 두지 않는다. 구현은 [ADR 0010](./0010-windows-first-platform-model.md)에 따라
   Windows를 먼저 하고 macOS를 병행한다.

이 결정은 문서만 바꾼다. 런타임, 계약, 설정 스키마는 구현 단계에서 바꾸고, 그때까지 코드는 이전 계약을 따른다.
계약의 세부(선언 필드, 제거하는 작업 목록, 프로필 경로 등)는 구현 단계에서 이 결정에 맞춰 정한다.

## 열린 질문

아래는 이 결정의 범위 밖 세부이며, 기본값에서 시작해 구현 단계에서 플랫폼 API로 확인하고 확정한다.

### 링크와 `window.open`

- **시작 프레임.** 요청을 시작한 프레임을 플랫폼이 알려 줄 때만 인정한다(Apple은 `sourceFrame.isMainFrame`).
  알 수 없으면 내부 URL을 포함해 차단한다. Windows는 시작 프레임을 확인할 수 있을 때까지 차단하고 Android
  `onCreateWindow`도 같다. 확인할 Windows API 후보는 `OriginalSourceFrameInfo`다.
- **사용자 동작.** 외부 URL은 사용자 동작으로 시작한 요청만 처리한다. 이 조건은 암묵적 링크 처리에만 적용되며 권한
  경계가 아니다. `opener.openUrl` 권한이 있는 문서가 SDK로 직접 호출하는 것은 별개의 경로다.
- **opener 대리 호출.** 요청을 시작한 문서 세션의 호스트 발급 핸들([ADR 0002](./0002-host-owned-call-context.md))로
  호출한다. host 권한 `opener.openUrl`과 정책 `commands`의 `plugin.opener.openUrl`을 요구하고, 코어를 거쳐
  호스트 발급 요청 ID(문서의 ID와 분리), 진행 중 요청 상한, 실행 직전 재검사를 적용한다. 처리 중 세션이 철회되면 취소한다.
  문서가 직접 호출하지 않은 새 출처는 [ADR 0002](./0002-host-owned-call-context.md)의 "호스트 발급 호출 프레임"으로 정했다.
  [ADR 0024](./0024-plugin-path-responsibility.md)와의 관계도 같은 절에 적었다. 뷰에 `plugin.*`을 직접 허용하지 말라는
  일반 지침의 예외는 `plugin.opener.openUrl` 하나이고, 외부 콘텐츠를 표시하는 뷰에는 여전히 허용하지 않는다.
- **리다이렉트.** 판정을 요청 URL로 할지 최종 URL로 할지 정한다. 기본값은 최종 URL이다.
- **`target` 없는 탐색과 내부 URL의 `window.open`.** 기본값은 외부 URL과 같은 조건이며, `target` 없는 외부 탐색은
  취소한다.
- **이름 있는 대상과 반환값.** `noopener`, `features`, 이름 있는 `target`은 새 창 요청과 같게 처리한다.
  `window.open`의 반환값(`null`)과 `opener`에 의존하는 웹 코드(팝업 OAuth 포함)는 지원하지 않고 차단 진단을 남긴다.
- **다른 scheme과 다운로드.** `mailto:`, `tel:`은 차단한다. 다운로드 링크는 다운로드 경로로 판정하고 opener로 넘기지 않는다.
- **내부 링크의 영향.** 내부 URL을 같은 WebView에서 열면 기존 세션과 진행 중 요청이 무효화되어 문서 상태를 잃는다.
- **차단 진단.** 반복 진단에는 빈도 상한을 둔다.
- **Android 전환.** `onCreateWindow`를 쓰려면 새 창 지원 설정을 바꿔야 하며 `_blank` 처리가 바뀐다. 전환 순서를 정한다.
- **앱의 거부 훅과 숨긴 문서.** 앱 코드가 opener 전에 거부할 수 있게 할지는 기본값을 두지 않고 정책의 작업 허용만 쓴다.
  숨겨져 상주하는 문서의 요청은 차단한다.
- **입력 검증.** 대리 호출의 URL 검사는 opener의 일반 입력 검증을 그대로 거친다.

### 모바일

- **창 수명.** Activity 재생성(회전 등 설정 변경)은 같은 창으로 보고 `windowId`와 라우트를 유지한다.
  설정 변경이 아닌 Activity 종료는 창 닫힘이며 앱을 종료한다. 종료 중에는 [ADR 0020](./0020-close-and-quit-lifecycle.md)대로
  `onAllWindowsClosed`를 호출하지 않는다.
- **지원 작업.** `isOpen`, `getSnapshot`, `getReadiness`, lifecycle 구독으로 시작한다. `getSnapshot`에서 데스크톱 전용
  필드에 채울 값을 정한다.
- **문서 세션이 받는 단계.** 닫히는 창의 세션은 먼저 철회되므로 문서 세션이 받을 수 있는 lifecycle 단계는 `ready`뿐일 수 있다.
- **종료 훅.** Android 뒤로가기나 Activity 종료로 앱이 끝날 때 종료 훅이 실행되는지 정한다.
- **`app.window`.** 모바일 CLI는 요구를 유지하되 값은 쓰지 않는다. 이 요구를 없앨지 정한다.

### 창이 없는 상태

- **트레이 앱.** 상주하려면 `desktop.tray`와 `closeBehavior`의 `"hide"` 또는 `"keep-alive"`가 필요하다.
  트레이 Open과 두 번째 실행이 새로 만든 창은 `visible`과 상관없이 표시한다. 창이 절대 보이지 않는 앱은 표현하지 않는다.
  macOS는 창 없는 시작이 `UNSUPPORTED`([ADR 0021](./0021-macos-desktop-lifecycle.md))이고, 숨긴 창을 다시 보여 줄
  경로는 구현 단계에서 확정한다.
- **프로필 데이터.** Windows는 영속 프로필 하나(`webview/`)를 쓰고 기존 뷰별 디렉터리와 임시 프로필은 옮기거나
  지우지 않는다. macOS는 앱마다 분리한 영속 프로필 하나로 바뀐다. 식별자 방식은 macOS 공개 API가 허용하는 범위에서 정한다.
- **창 소유 관련 입력.** 대화상자의 소유 창은 앱의 창이고, 메뉴의 창 메뉴는 재생성 뒤 새 창에 다시 붙으며,
  window-state 저장 키는 `key`가 없으면 정책의 유일한 뷰 ID를 쓴다.

## 결과

### 얻는 것

- **한 가지 모델.** 데스크톱과 모바일이 같은 화면 모델과 같은 앱 정의를 쓴다. 모바일에서 다른 것은 창 작업의 지원 여부,
  `app.startup: false`와 `app.visible: false` 거부, 외부 링크 열기(opener 어댑터가 생길 때까지 차단)이며
  지원 여부는 `capabilities()`로 조회한다.
- **짧은 호출.** `windows.minimize({ view: "main" })`가 `windows.minimize()`가 된다. 호출자가 창을 고르지 않으므로
  대상 창을 다루는 오류가 사라진다.
- **작은 코어와 보안 경계.** 창별 세션 라우팅, 같은 요청 ID의 창 간 분리, 슬롯 예약, 격리 프로필 정리, 부모 종료
  순서를 검증할 필요가 없다. 정책 뷰가 하나라 권한 검토 대상도 하나다.
- **Electron 동작 기준과의 관계.** Electron은 `BrowserWindow`를 앱 코드가 직접 만든다. bunaway는
  Capacitor처럼 창 하나를 런타임이 소유하고, 데스크톱 창 제어는 Electron과 같은 범위의 작업을 그 창에 대해 제공한다.
- **Tauri 동작 기준 대비 개선.** Tauri v2는 모바일에서 `set_size`, `set_position`을 효과 없이 경고만 남긴다.
  bunaway는 `UNSUPPORTED`와 지원 조회로 앱이 실패를 알 수 있게 한다.
- **링크 동작의 개선.** 내부 링크는 같은 WebView, 외부 링크는 `opener.openUrl` 권한이 있을 때 시스템 브라우저로 보낸다
  (Capacitor 동작 기준). 시작 프레임을 확인할 수 없는 플랫폼은 확인할 때까지 외부 링크를 차단하므로 개선은 그때부터 적용된다.

### 포기하는 것

- **다중 창.** 문서 편집기의 문서별 창, 채팅의 대화별 창, 분리 가능한 도구 창, 설정 창,
  splashscreen 창을 만들 수 없다. 화면은 같은 WebView의 라우트, dialog 플러그인,
  메뉴, 트레이로 대신한다. splashscreen은 `showWhenReady`와 `backgroundColor`로 대신한다.
- **창 간 통신.** 창끼리 메시지를 주고받는 경로가 필요 없어진다. 대신 같은 문서 안의 상태와
  백엔드 이벤트를 쓴다. 여러 창 사이의 상태 동기화 문제도 함께 사라진다.
- **창별 권한과 정책 뷰.** 쓰기 가능한 편집 창과 읽기 전용 창처럼 뷰마다 다른 권한을 주는 구성을
  잃는다. 한 앱의 모든 화면이 같은 세션과 같은 호출 컨텍스트를 쓰므로 호스트와 백엔드는 호출한
  라우트를 구별하지 못하고, 화면별 권한 분리를 다른 곳으로 옮길 수 없다. 화면마다 권한이 달라야 하는
  앱은 별도 앱으로 나누거나 같은 권한 집합으로 설계해야 한다. 렌더러 장애를 뷰 단위로 격리하던 효과도
  사라지며, 창 하나의 렌더러 장애는 그 창의 세션 폐기와 재탐색으로 처리한다.
- **창 없는 트레이 앱.** `app.startup: false`는 창 생성을 미룰 뿐이며 트레이 Open, 두 번째 실행, `windows.create()`가 창을 만든다. 창을
  절대 만들지 않는 트레이 전용 앱은 표현하지 않고, 창을 숨긴 채 유지하는 방식(`app.visible: false`)을 권장한다. 숨긴 창과 WebView, 정책 권한을 가진 문서 세션이 시작부터 상주하므로
  메모리 사용과 공격면이 늘어난다.
- **기존 데이터.** 이전 형식의 뷰별 WebView 프로필 데이터와 window-state 저장 키는 옮기지 않는다. 개발 단계이므로
  이전 디렉터리도 정리하지 않으며 쿠키와 웹 저장소가 디스크에 남는다.
- **부모와 모달 창, 창별 프로필 격리.** `setParent`, 부모 종속 모달, `profile: "isolated"`를 제거한다.
  네이티브 대화상자의 소유 창은 앱의 창으로 고정된다.
- **이미 구현하고 검증한 코드.** Windows 다중 창, 소유 관계, 격리 프로필 구현과 그 실제 OS 검증을 버린다.
  이 비용은 이후 모든 창 기능의 검증 비용을 줄이는 것으로 회수한다고 판단한다.

## 대안과 기각 이유

### 다중 창을 코어에 유지하고 기본값만 single로 둔다(현재 상태)

기각. ADR 0017이 이미 single을 기본값으로 두었지만 모든 입력이 `view`, `windowId`를 받고, 호스트는 다중 창
라우팅과 상한, 프로필 규칙을 계속 소유한다. 기본값만으로는 계약 크기와 검증 비용이 줄지 않으며,
모바일과 모델이 다르다는 문제도 남는다.

### 나중에 플러그인 opt-in으로 다중 창을 제공한다

지금은 채택하지 않고 재검토 경로로 남긴다. 코어는 작게, 기능은 플러그인으로 둔다는 원칙에 맞지만,
다중 창은 세션 라우팅과 호출 컨텍스트([ADR 0002](./0002-host-owned-call-context.md))를 바꾸므로
보통의 플러그인처럼 Host operation만 추가해서는 만들 수 없다. 재제안 조건은 다음과 같다.

- 같은 WebView의 라우트, dialog, 트레이로 해결되지 않는 실제 앱 사례가 있다.
- 코어 변경 없이 플러그인이 소유할 수 있는 확장점(추가 WebView의 세션 발급과 회수)이 별도 ADR로 정해진다.
- 기본 단일 창 앱의 계약과 성능, 보안 검토 범위를 늘리지 않는다.

### Tauri 2.11 방식(모바일 다중 창)

기각. Tauri v2는 2.11.0부터 Android activity embedding과 iOS scene으로 모바일 다중 창을 지원한다.
이 방식은 Android에서 Activity마다 WebView를 두고 iOS에서 scene 수명을 따로 다뤄야 한다.
bunaway의 모바일 호스트는 Activity 하나와 UIWindow 하나가 Bun과 WebView를 소유하는 모델이고,
모바일 다중 창은 태블릿과 폴더블의 일부 사례에만 이득이 있으며 플랫폼마다 다른 수명주기를 코어 계약에 끌어들인다.

### 창은 하나지만 WebView 여러 개(Electron `WebContentsView` 방식)

기각. 창 수는 줄지만 WebView별 세션, 정책, 포커스, 배치가 다시 필요해 다중 창과 같은 비용이 든다.

### 모바일에서 창 API를 경고만 남기고 성공으로 처리한다(Tauri 모바일 동작)

기각. 앱이 실패를 알 수 없다. `UNSUPPORTED`와 `capabilities()` 조회는 기존 bunaway 플러그인의
플랫폼별 미지원 처리와도 일치한다.

### `window.open`을 모두 차단한다

기각. 내부 링크의 `target="_blank"`가 아무 반응 없이 끝나 앱 개발자가 원인을 찾기 어렵다.
Capacitor 동작 기준처럼 외부 링크는 시스템 브라우저, 내부 링크는 같은 WebView가 사용자 기대와 맞는다.

## 기존 결정과의 관계

관계가 대체나 수정인 ADR은 머리말에 이 결정으로의 링크를 추가하고 본문은 당시 기록으로 남긴다. 유지인 ADR은 바꾸지 않는다.

| ADR | 관계 | 내용 |
| --- | --- | --- |
| [0004](./0004-multi-window-per-view-policy.md) 창과 뷰별 정책 분리 | 대체 | 창 N개와 뷰별 정책, 뷰별 프로필, 창별 종료 규칙을 단일 창으로 대체. splashscreen 전환 서술과 부모와 모달 수명 확장 절도 대체. 렌더러 장애 처리와 "창 닫기 = 세션 폐기"는 유지 |
| [0017](./0017-multiple-windows-per-view.md) 같은 뷰의 다중 창 | 대체 | 인스턴스 관련 설정과 작업, ID 지정 제어 전체 |
| [0016](./0016-window-creation-contract.md) 창 생성 계약 | 수정 | 호출별 옵션 허용 범위와 검증은 유지. `app.windows`, `view`, `windowId`가 전제인 부분은 대체 |
| [0013](./0013-desktop-lifecycle.md) 데스크톱 수명주기 | 수정 | 트레이 Open과 두 번째 실행은 앱의 창을 복원하거나 생성. 부모와 자식, splashscreen 절 제거. `app.windows: []`의 "창을 만들지 않는다"는 의미는 포기하고, 창 생성 지연(`app.startup: false`)과 숨긴 창 앱(`app.visible: false`)으로 바꾼다 |
| [0013](./0013-optional-native-plugins.md) 선택 네이티브 플러그인 | 수정 | "특정 창의 제어 같은 앱 규칙"은 창이 하나라 적용 대상이 없다 |
| [0014](./0014-optional-plugin-packages.md) 선택 플러그인 패키지 | 수정 | 허용된 작업은 앱의 창 하나를 대상으로 하며 화면별 접근 제한은 불가능하다 |
| [0020](./0020-close-and-quit-lifecycle.md) 닫기와 종료 수명주기 | 수정 | 여러 창과 자식 확인 언급 제거. `windows.lifecycle`의 백엔드 전달과 문서 세션 권한 변경. `respondClose` 입력에서 대상 제거와 `requestId`의 앱 실행 동안 유일 발급. `onAllWindowsClosed`는 "앱의 창이 닫혀 0개가 됨" |
| [0021](./0021-macos-desktop-lifecycle.md) macOS 데스크톱 수명주기 | 수정 | 권한 언급과 `windows.lifecycle` 전달을 0020과 맞춤. macOS 어댑터의 `getSnapshot` 구현과 영속 프로필 하나가 추가된다(프로필 식별자 방식은 열린 질문). 창 없는 시작은 계속 `UNSUPPORTED` |
| [0006](./0006-windows-bun-ui-worker.md) Windows UI Worker | 수정 | 뷰별 정책과 프로필은 단일 창으로 대체. 문서 세대는 유지 |
| [0015](./0015-android-bundled-process-host.md) Android | 수정 | 뒤로가기를 "WebView history 먼저"로 변경. `launchMode` 지정 추가 |
| [0015](./0015-macos-bun-ffi.md) macOS Bun FFI | 수정 | 다중 창 서술은 단일 창으로 대체 |
| [0019](./0019-initial-window-placement.md) 초기 창 배치 | 수정 | 생성 API 개수 표현을 create, recreate 두 개로 수정. 배치 계산은 유지 |
| [0002](./0002-host-owned-call-context.md) 호출 컨텍스트 | 수정 | 발급과 철회는 그대로. opener 대리 호출 전용 호스트 발급 호출 프레임을 추가했다 |
| [0024](./0024-plugin-path-responsibility.md) 경로 책임 | 유지(링크 예외는 ADR 0002에 기록) | 외부 콘텐츠를 표시하는 뷰의 최소 권한 지침은 단일 뷰에서 앱 전체 권한에 적용된다. opener 대리 호출을 위해 뷰에 `plugin.opener.openUrl`을 직접 허용하는 일반 지침의 예외 하나를 ADR 0002에 적었다. 외부 콘텐츠 뷰에는 허용하지 않는다 |
| [0010](./0010-windows-first-platform-model.md) Windows 우선 | 유지 | 구현 순서의 근거 |
| [0018](./0018-ios-embedded-bun-worker.md) iOS | 유지 | 단일 뷰 조건이 공통 계약이 됨 |
| `docs/GLOSSARY.md` | 수정 | 창 인스턴스, 창 소유 관계, 부모 종속 모달 창 항목 삭제. 뷰 ID, WebView 프로필, 앱 접근 규칙 수정 |

## 후속 작업

- 계약과 설정 변경, 호스트 정리, 외부 링크, 모바일 작업은 각각 별도 변경으로 구현한다.
- 다중 창 재제안은 위 조건을 갖춘 새 ADR로만 한다.

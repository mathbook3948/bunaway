---
status: accepted
---

# 앱 하나는 WebView 하나와 창 하나로 실행한다

결정일: 2026-10-23. 검토 기준: main `6f32e6cd`.

## 배경

bunaway의 목표는 TypeScript만으로 데스크톱과 모바일 앱을 쉽게 만드는 것이다.
지금 데스크톱 창 모델은 Electron의 `BrowserWindow` 여러 개를 기준으로 커졌다.

- [ADR 0004](./0004-multi-window-per-view-policy.md)는 창마다 정책 뷰를 붙이고 뷰별 WebView2 프로필과
  세션을 분리했다.
- [ADR 0016](./0016-window-creation-contract.md)은 사전 선언 창의 호출별 생성 옵션을 정했다.
- [ADR 0017](./0017-multiple-windows-per-view.md)은 같은 뷰의 창 인스턴스 여러 개
  (`instances`, `maxInstances`, `profile`, `createInstance`, `listInstances`)를 도입했다.
- 그 결과 `plugins/windows/src/contract.ts`는 1,646줄, 작업 139개와 이벤트 8개가 되었다.
  거의 모든 작업 입력이 `{ view, windowId? }`를 받고, 호출하는 쪽이 대상 창을 고른다.
  Windows 호스트는 창 인스턴스 Map, 슬롯 예약, 부모와 모달 관계(`native/windows/bun/window-relations.ts`),
  격리 프로필(`native/windows/bun/window-profiles.ts`)과 창별 세션 라우팅을
  `native/windows/bun/ui.ts`(2,530줄)에서 관리한다.

반면 모바일 호스트는 이미 단일 화면이다.

- Android는 Activity 하나가 Bun과 WebView 하나를 소유한다([ADR 0015](./0015-android-bundled-process-host.md)).
  CLI는 `app.windows`를 거부하고 `app.view`, `app.home` 하나를 요구한다(`packages/cli/src/android.ts`).
- iOS도 UIWindow 하나와 `BunawayViewController`를 쓰며 UIScene을 지원하지 않는다.
  `packages/cli/src/ios.ts`가 같은 단일 뷰 조건을 검사한다([ADR 0018](./0018-ios-embedded-bun-worker.md)).
- 모바일 호스트 설정에는 view, home, title, policy만 들어가고 크기와 위치 같은 window 설정은 버려진다.
- `window.open`과 `target="_blank"`는 어느 플랫폼에서도 새 창을 만들지 않고 처리가 다르다. Windows는 새 창 요청을 처리됨으로
  표시하고 버린다(`native/windows/bun/webview.ts`). Android는 다중 창 지원을 끄고 `onCreateWindow`가 없어 `_blank`가 같은 WebView의 일반 탐색이 되며,
  iOS와 macOS는 `createWebViewWith`가 없다. origin 밖 탐색은 취소되고 외부 브라우저로 넘기지 않는다.
- Android 뒤로가기는 웹 history와 관계없이 Activity를 종료한다(`BunawayActivity.java`).
- macOS 어댑터는 `instances: "multiple"`과 `profile: "isolated"`를 `UNSUPPORTED`로 거부한다.

앱 개발자는 플랫폼마다 다른 창 모델을 배워야 하고, 데스크톱에서만 쓰는 창 선택 인자를
모든 호출에 넘긴다. 다중 창 계약은 세션 라우팅, 프로필 소유권, 상한 예약, 부모 종료 순서처럼
보안 경계와 수명주기에 걸친 규칙을 늘렸고, 새 창 기능마다 이 규칙을 다시 검증해야 한다.

## 결정

bunaway는 데스크톱과 모바일 모두 **앱 하나에 WebView 하나, 창 하나**인 앱 런타임으로 정의한다.

1. **화면 단위.** 앱은 실행 중 네이티브 창을 최대 하나 가진다. 그 창은 WebView 하나와
   정책 뷰 하나를 가진다. 화면 전환과 모달은 같은 WebView 안의 웹 라우팅과 웹 UI로 한다.
   데스크톱에서는 창을 닫았다 다시 만들 수 있지만(트레이, `keep-alive`) 동시에 두 개를 열지 않는다.
2. **정책.** 정책 뷰는 하나다. `policy.json`의 `views` 배열 형식은 유지하고 항목 수를 1로 제한한다.
   권한 이름은 계속 완전한 Host operation 이름(`windows.setOuterSize` 등)이며 바꾸지 않는다.
   [ADR 0002](./0002-host-owned-call-context.md)의 호스트 발급 호출 컨텍스트는 그대로 유지한다.
3. **창 제어 대상.** 창 API는 대상 인자 없이 앱의 창을 제어한다. 웹 문서와 백엔드가 같은 창을 가리킨다.
   `view`와 `windowId` 입력은 모든 플러그인에서 바로 제거한다. `windowId`는 창 수명 식별자로
   `windows.getSnapshot()` 결과와 이벤트 payload에 남겨, 호출자가 재생성 여부를 구분하는 데 쓴다.
4. **모바일.** 창 크기, 위치, 최대화, 전체화면, Z 순서, 작업 표시줄 같은 데스크톱 창 작업은
   Android와 iOS에서 `UNSUPPORTED`로 실패한다. 앱은 `capabilities()`로 작업별 지원 여부를 먼저 조회한다.
   경고만 남기고 성공으로 처리하지 않는다.
5. **`window.open`과 링크.** 새 창 요청은 창을 만들지 않는다. 정책 뷰의 `origins` 안 문서가 시작한 요청만 처리하고,
   `origins`에 속한 URL은 같은 WebView에서 탐색한다. 그 밖의 `http`, `https` URL은 opener 플러그인(`opener.openUrl`)을
   거쳐서만 시스템 기본 브라우저로 넘기며, opener가 없거나 권한이 없으면 차단하고 진단을 남긴다. 다른 scheme은
   차단한다. Android와 iOS는 opener 어댑터가 생길 때까지 외부 URL을 차단한다. 세부 동작은 아래
   "열린 질문"에 기본값과 함께 두고 링크 구현 PR에서 확정한다.
6. **Android 뒤로가기.** 시스템 뒤로가기는 WebView history를 먼저 소비하고, 더 돌아갈 곳이 없을 때만
   Activity를 종료한다.
7. **다중 창은 코어 계약이 아니다.** 필요성이 확인되면 별도 플러그인의 opt-in 기능으로 다시 제안한다.
   그때도 이 결정의 기본값(창 하나)을 바꾸지 않는다.
8. **순서.** [ADR 0010](./0010-windows-first-platform-model.md)에 따라 Windows에서 먼저 구현하고
   macOS를 병행한다. 다중 창 API는 바로 제거한다. 개발 단계이므로 이전 형식과의 호환, 경고, 유예 기간을 두지 않는다.

### 열린 질문(링크 구현 PR의 기본값)

외부 링크와 `window.open`의 세부는 이 결정의 범위 밖이다. 링크 구현 PR은 아래 기본값에서 시작하고, 플랫폼 API로
확인한 내용에 따라 바꿀 수 있다.

- **시작 프레임.** 요청을 시작한 프레임을 플랫폼이 알려 줄 때만 인정한다(Apple은 `WKNavigationAction`의
  `sourceFrame.isMainFrame`). 알 수 없으면 내부 URL을 포함해 모두 차단한다. Windows는 시작 프레임을 확인할 수 있을
  때까지 차단하고, Android `onCreateWindow`도 같다. 서브프레임은 문서 세션이 없으므로 외부 URL을 시작할 수 없다.
- **사용자 동작.** 외부 URL은 사용자 동작으로 시작한 요청만 처리한다. 판정에는 Windows `NewWindowRequested`와
  `NavigationStarting`의 `IsUserInitiated`, Android `onCreateWindow`의 `isUserGesture`, Apple의
  `.linkActivated`를 쓴다. 이 조건은 암묵적 링크 처리에만 적용되며 권한 경계가 아니다. `opener.openUrl` 권한이 있는
  문서가 SDK로 직접 호출하는 것은 별개의 경로다. `target` 없는 탐색도 같은 원칙이다.
- **opener 대리 호출.** 요청을 시작한 문서 세션의 호스트 발급 핸들([ADR 0002](./0002-host-owned-call-context.md))로
  호출한다. host 권한 `opener.openUrl`과 정책 `commands`의 `plugin.opener.openUrl`을 모두 요구하고, 코어를 거쳐
  일반 호출과 같은 요청 ID 공간과 진행 중 요청 상한(`maxPending`), 실행 직전 재검사를 적용한다. 처리 중 탐색으로
  세션이 철회되면 요청을 취소하고 진단만 남긴다.
- **스크립트로 연 내부 URL.** 내부 URL의 `window.open`도 세션과 미완료 요청을 무효화하는 탐색이므로, 사용자 동작 조건을
  내부 URL에도 둘지 정한다. 기본값은 외부 URL과 같은 조건이다.
- **다른 scheme.** `mailto:`와 `tel:`을 opener가 다룰지 정한다. 기본값은 차단이다.
- **`target` 없는 외부 탐색.** 지금처럼 취소할지 opener로 넘길지 정한다. 기본값은 취소이고, 사용자 동작으로 시작한 메인 프레임 탐색만 opener로 넘길 수 있다.
- **ADR 0024와의 관계.** 대리 호출은 정책 `commands`의 `plugin.opener.openUrl`을 요구하지만 0024는 외부 콘텐츠를 표시하는 뷰에 `plugin.*`을 직접 허용하지 말라고 한다. 링크 구현 PR이 두 지침의 처리를 정한다.
- **ADR 0002 갱신.** 링크 구현 PR이 문서가 직접 호출하지 않은 새 출처 종류를 만들면 ADR 0002를 갱신한다.
- **`window.open` 반환값.** 새 창을 만들지 않을 때의 반환값(`null`)과 `opener` 참조에 의존하는 웹 코드의 호환을 정한다.
- **차단 진단.** 반복되는 차단 진단이 로그를 채우지 않도록 빈도 상한을 둔다.

### 단일 창 계약의 세부

| 항목 | 계약 |
| --- | --- |
| 창 선언 | `bunaway.json`의 `app.home`, `app.window`는 유지한다. `app.view`는 지금 단일 형식에서 필수인데 선택으로 바꾸고, 생략하면 정책의 유일한 뷰를 쓴다. `app.startup`, `app.visible`, `app.showWhenReady`는 지금 `app.windows[]` 항목의 필드인데 `app`으로 옮긴다. `app.windows`, `instances`, `maxInstances`, `profile`은 제거한다 |
| 창 없는 시작 | `app.startup: false`. 트레이 Open, 두 번째 실행, `windows.create()`가 창을 만든다. 기존 `desktop.tray` 또는 `closeBehavior: "keep-alive"` 요구는 유지. macOS는 [ADR 0021](./0021-macos-desktop-lifecycle.md)대로 계속 `UNSUPPORTED`이고, Android와 iOS는 빌드에서 `app.startup: false`와 `app.visible: false`를 거부한다 |
| 생성과 재생성 | `windows.create(options?)`, `windows.recreate(options?)`. 이미 열려 있으면 create는 기존처럼 `BUSY`. 창이 없을 때 `recreate`는 지금처럼 창을 새로 만든다(`INVALID_ARGUMENT`는 `recreateInstance`에만 있던 동작이다). 옵션 허용 범위는 ADR 0016, 0019를 유지 |
| 닫기 요청 응답 | `windows.respondClose({ requestId, allow })`는 대상 인자가 없으므로, 재생성된 창이 이전 창의 늦은 응답을 받지 않도록 `requestId`를 앱 실행 동안 유일하게 발급한다. 이미 처리됐거나 알 수 없는 `requestId`는 기존처럼 `INVALID_ARGUMENT`다 |
| 열린 상태 조회 | `windows.isOpen()`이 `windows.list()`와 `isDestroyed`를 대신한다. `getById`, `getCurrent`, `getFocused`, `getLastActive`는 제거하고 `getSnapshot()`과 `isFocused()`가 대신한다. 다른 창으로 전환하던 `windows.blur`는 창이 하나이므로 제거한다 |
| 창이 없을 때의 제어 | 창 제어와 상태 조회는 `INVALID_ARGUMENT`(창 없음). 기존 "닫힌 windowId" 오류와 같은 코드. 예외로 `windows.isOpen()`은 성공하고, `windows.destroy()`는 기존처럼 창이 없어도 `true`로 성공하며, `windows.getReadiness()`는 닫힌 창의 마지막 결과를 유지한다 |
| WebView 프로필 | 영속 프로필 하나. Windows 경로는 `webview/`이며 기존 `webview/v<인코딩한 view>` 데이터는 옮기거나 지우지 않는다. 격리 프로필을 제거하면서 비정상 종료로 남은 `webview/temporary`와 정리 커서(`webview/.temporary-cleanup-cursor`)는 매 시작 때 삭제한다. macOS는 지금 뷰별로 하나씩 비영속 저장소를 만들고 재생성 때만 유지하므로, 이 결정으로 쿠키와 웹 저장소가 디스크에 남아 실행 사이에도 유지되는 영속 프로필 하나로 바뀐다. 저장소는 앱마다 분리해, 번들 ID가 없는 개발 실행에서도 앱끼리 쿠키와 웹 저장소를 공유하지 않는다. 앱별 식별자로 분리할지 앱 데이터 디렉터리를 쓸지는 macOS 공개 API가 허용하는 방식으로 구현 PR에서 확정한다 |
| 이벤트 | `windows.changed`, `windows.closeRequested` 등의 payload 형식은 유지한다. 지금 `windows.readiness`와 `windows.lifecycle`은 권한이 있는 열린 창의 문서 세션에 방송하고 백엔드는 받지 않으며, 닫히는 창은 세션이 먼저 철회되어 자신의 `closed`, `destroyed`를 받지 못한다. 단일 창에서는 문서만 받아서는 창 상태를 볼 수 없으므로 `windows.lifecycle`을 백엔드(Bun 쪽 앱 코드)에도 전달한다. 이벤트 수신은 네이티브 작업이 아니라 알림이므로 백엔드의 `backend.permissions` Host API 검사 대상이 아니고(백엔드의 Host API 호출은 계속 검사한다), windows 플러그인이 제공하는 새 백엔드 구독 API로(windows 플러그인이 등록되지 않았으면 이벤트도 발행하지 않는다) `created`부터 `destroyed`까지 모든 단계를 권한 검사 없이 받아, Electron의 `window-all-closed`처럼 창 상태를 본다. 문서 세션이 받는 조건은 정책 `events`에 `windows.lifecycle`이 있어야 하는 기존 조건(유지)과 작업 권한 `windows.getSnapshot`(`windows.listInstances`를 대신한다)이며, 문서 세션도 계속 받는다(단일 창에서 문서 세션이 받을 수 있는 단계는 `ready`뿐이고, 문서의 구독이 `ready` 발행보다 늦으면 하나도 받지 못할 수 있다). 앱 종료나 세션 종료가 시작된 뒤에는 기존 계약대로 전송하지 않는다. 창 재생성 여부는 이벤트와 `getSnapshot()`의 `windowId`로 구분한다. `windows.readiness`는 문서 세션 전달을 그대로 두고, 백엔드는 `getReadiness()`로 조회한다. 이를 위해 macOS 어댑터도 `getSnapshot`을 구현해야 한다 |
| 다른 플러그인 | dialog의 `ownerWindowId`, menu의 `windowId`, window-state의 `view`와 `windowId`, appearance의 `windowId`는 입력에서 제거하고 항상 앱의 창을 뜻한다. appearance의 창 테마와 앱 테마는 하나로 합친다. 창이 없을 때와 창이 숨겨져 있을 때 dialog는 지금처럼 소유 창 없이 열고(보이는 창이 있을 때만 그 창이 소유 창이다), menu의 창 메뉴는 창 재생성 뒤 새 창에 다시 붙는다. window-state의 저장 키는 `key`를 생략하면 정책의 유일한 뷰 ID이고, `remove`도 `key` 생략 시 같은 값을 쓴다. 창 아이콘, 썸네일 툴바, 오버레이 아이콘, 닫기 확인 같은 런타임 창 상태는 지금의 재생성 동작을 유지한다 |
| 선언 필드 | `app.title`은 그대로 유지한다. `backgroundColor`는 `app.window` 아래 필드다 |

## 결과

### 얻는 것

- **한 가지 모델.** 데스크톱과 모바일이 같은 화면 모델과 같은 앱 정의를 쓴다. 모바일에서 다른 것은
  데스크톱 전용 창 작업의 지원 여부와 외부 링크 열기(opener 어댑터가 생길 때까지 차단)이고, 지원 여부는 `capabilities()`로 조회한다.
- **짧은 호출.** `windows.minimize({ view: "main" })`가 `windows.minimize()`가 된다.
  호출자가 창을 고르지 않으므로 대상 창을 다루는 오류(ID와 뷰 불일치, multiple 뷰에서 ID 생략)가 사라진다.
- **작은 코어와 보안 경계.** 창별 세션 라우팅, 같은 요청 ID의 창 간 분리, 슬롯 예약, 격리 프로필
  정리, 부모 종료 순서를 검증할 필요가 없다. 정책 뷰가 하나라 권한 검토 대상도 하나다.
- **Electron 동작 기준과의 관계.** Electron은 `BrowserWindow`를 앱 코드가 직접 만든다. bunaway는
  Capacitor처럼 창 하나를 런타임이 소유하고, 데스크톱 창 제어는 Electron과 같은 범위의 작업
  (크기, 위치, 최대화, 전체화면, 제목, Z 순서, 썸네일 툴바 등)을 그 창에 대해 제공한다.
- **Tauri 동작 기준 대비 개선.** Tauri v2는 모바일에서 `set_size`, `set_position`을 효과 없이 경고만
  남긴다. bunaway는 `UNSUPPORTED`와 지원 조회로 앱이 실패를 알 수 있게 한다. 경고만 남기면 앱이
  기능이 동작한 것으로 오해하고 플랫폼별 분기를 테스트로 검증할 수 없다.
- **링크 동작의 개선.** 지금은 Windows, macOS, iOS에서 `target="_blank"`가 아무 반응 없이 끝나고, Android는 새 창 지원을 꺼서 `_blank`가 일반 탐색이 되어 같은 origin이면 이동하고 밖이면 취소된다.
  Capacitor 동작 기준처럼 내부 링크는 같은 WebView, 외부 링크는 `opener.openUrl` 권한이 있을 때 시스템 브라우저로 보낸다(세부 기본값은 위 열린 질문).
  모바일은 opener 어댑터가 생길 때까지 외부 링크를 차단한다.

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
- **창 없는 트레이 앱.** 지금은 `app.windows: []`로 창을 전혀 만들지 않는 트레이 전용 앱을 표현할 수 있고 트레이 Open이나 두 번째 실행도 창을 만들지 않는다. 이 결정의 `app.startup: false`는 트레이 Open, 두 번째 실행, `windows.create()`가 창을 만들므로 창을 절대 만들지 않는 앱은 표현할 수 없다. 트레이 전용 앱은 창을 숨긴 채 유지하는 방식(`app.visible: false`)으로 대신하며, 이때 트레이 Open과 두 번째 실행은 숨긴 창을 표시한다. 트레이 Open과 두 번째 실행이 새로 만든 창(`startup: false`나 `keep-alive`로 닫은 뒤)은 `visible` 설정과 상관없이 항상 표시한다. 창이 절대 보이지 않는 앱은 표현할 수 없다. 트레이 앱이 유지되려면 `desktop.tray`와 `closeBehavior: "hide"` 또는 `"keep-alive"`가 필요하며, 기본값 `"quit"`이면 창을 닫을 때 앱이 종료된다. 숨긴 창과 WebView, 정책 권한을 가진 문서 세션이 시작부터 상주하므로
  `app.windows: []` 앱보다 메모리 사용과 공격면이 늘고, 이 비용을 받아들인다.
- **기존 데이터 경로.** `app.windows`를 쓰던 Windows 앱은 `webview/v<인코딩한 view>`에 쿠키와 웹 저장소가 있으며
  이 결정으로 `webview/`를 쓰면 이전 데이터를 읽지 못한다. 개발 단계이므로 옮기지 않고 이전 디렉터리도 정리하지 않는다. window-state는 저장 키가 `key`가 없으면 `view`이므로, `view`를 생략하는 앱은 입력 제거 뒤에도 정책의 유일한 뷰 ID로 같은 키를 쓰지만 `windowId` 기반으로 저장했던 상태는 읽지 못한다.
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
현재 Android 호스트는 Activity 하나가 Bun과 WebView를 소유하고 여러 Activity의 동시 실행을 지원하지 않으며
([ADR 0015](./0015-android-bundled-process-host.md)), iOS 호스트는 UIScene을 쓰지 않는다. 모바일 다중 창은
태블릿과 폴더블의 일부 사례에만 이득이 있고, 플랫폼마다 다른 수명주기를 코어 계약에 끌어들인다.

### 창은 하나지만 WebView 여러 개(Electron `WebContentsView` 방식)

기각. 창 수는 줄지만 WebView별 세션, 정책, 포커스, 배치가 다시 필요해 다중 창과 같은 비용이 든다.

### 모바일에서 창 API를 경고만 남기고 성공으로 처리한다(Tauri 모바일 동작)

기각. 앱이 실패를 알 수 없다. `UNSUPPORTED`와 `capabilities()` 조회는 기존 bunaway 플러그인의
플랫폼별 미지원 처리와도 일치한다.

### `window.open`을 모두 차단한다(Windows, iOS, macOS의 현재 동작)

기각. 내부 링크의 `target="_blank"`가 아무 반응 없이 끝나 앱 개발자가 원인을 찾기 어렵다.
Capacitor 동작 기준처럼 외부 링크는 시스템 브라우저, 내부 링크는 같은 WebView가 사용자 기대와 맞는다.

## 기존 결정과의 관계

대체되거나 수정되는 ADR(0002, 0004, 0006, 0013, 0015 Android와 macOS 파일, 0016, 0017, 0019, 0020, 0021)은 머리말에 이 결정으로의 링크를 추가하고 본문은 당시 기록으로 남긴다.

| ADR | 관계 | 내용 |
| --- | --- | --- |
| [0004](./0004-multi-window-per-view-policy.md) 창과 뷰별 정책 분리 | 대체 | 창 N개와 뷰별 정책, 뷰별 프로필, 창별 종료 규칙을 단일 창으로 대체. 렌더러 장애 처리와 "창 닫기 = 세션 폐기"는 유지. splashscreen 전환 서술과 2026-10-11 부모와 모달 수명 확장 절도 대체 |
| [0016](./0016-window-creation-contract.md) 창 생성 계약 | 수정 | 호출별 옵션 허용 범위와 검증, 옵션 검증 오류 행은 유지. 오류 표 중 `app.windows`, `view`, `windowId`가 전제인 행은 대체. `view` 입력, 선언 0–128개, 뷰별 슬롯과 식별자 조회 절은 대체 |
| [0017](./0017-multiple-windows-per-view.md) 같은 뷰의 다중 창 | 대체 | `instances`, `maxInstances`, `profile`, `createInstance`, `recreateInstance`, `listInstances`, ID 지정 제어 전체 |
| [0013](./0013-desktop-lifecycle.md) 데스크톱 수명주기 | 수정 | 트레이 Open과 두 번째 실행은 "살아 있는 모든 창"이 아니라 앱의 창을 복원하거나 생성. `completeSplashscreen`, 부모와 자식 종료 절 제거. `app.windows: []`는 창 없는 시작(`app.startup: false`)과 숨긴 창 앱(`app.visible: false`)으로 나누어 대체 |
| [0019](./0019-initial-window-placement.md) 초기 창 배치 | 유지(용어 수정) | "네 생성 API"를 create, recreate 두 개로 수정. 배치 계산은 그대로 |
| [0020](./0020-close-and-quit-lifecycle.md) 닫기와 종료 수명주기 | 수정 | `windows.lifecycle`을 백엔드에도 전달하고 문서 세션의 수신 권한을 `windows.getSnapshot`으로 변경. 여러 창, 자식 확인, splashscreen 언급 제거. `onAllWindowsClosed`는 이름을 유지하고 "앱의 창이 닫혀 0개가 됨"으로 정의 |
| [0021](./0021-macos-desktop-lifecycle.md) macOS 데스크톱 수명주기 | 수정 | `windows.listInstances` 권한 언급을 0020과 같이 변경하고 `windows.lifecycle`의 백엔드 전달을 따른다. macOS의 영속 프로필 하나와 `getSnapshot` 구현이 추가된다. 창 없는 시작은 계속 `UNSUPPORTED` |
| [0002](./0002-host-owned-call-context.md) 호출 컨텍스트 | 수정 | 호출 컨텍스트 발급과 철회는 그대로. 링크 구현 PR이 정하는 호스트 대리 호출(문서가 직접 호출하지 않은 출처)이 추가될 수 있다 |
| [0024](./0024-plugin-path-responsibility.md) 경로 책임 | 유지 | 외부 콘텐츠를 표시하는 뷰의 최소 권한 지침은 단일 뷰에서 앱 전체 권한에 적용된다 |
| [0014](./0014-optional-plugin-packages.md) 선택 네이티브 플러그인 | 유지 | "허용된 작업은 앱에 선언된 창을 대상으로 하며 특정 창의 접근 제한은 앱 명령에서 검사"에서 대상은 앱의 창 하나이고, 화면별 접근 제한은 이 결정의 "포기하는 것"대로 불가능하다 |
| [0010](./0010-windows-first-platform-model.md) Windows 우선 | 유지 | 구현 순서의 근거 |
| [0015](./0015-android-bundled-process-host.md) Android | 수정 | 뒤로가기를 "Activity 종료"에서 "WebView history 먼저"로 변경. 단일 뷰 조건은 이 결정의 공통 계약이 됨 |
| [0015](./0015-macos-bun-ffi.md) macOS Bun FFI | 수정 | "현재 범위는 macOS arm64의 다중 창" 서술은 단일 창으로 대체 |
| [0006](./0006-windows-bun-ui-worker.md) Windows UI Worker | 수정 | "뷰별 정책, 프로필, 문서 세대는 유지" 중 뷰별 정책과 프로필은 단일 창으로 대체. 문서 세대는 유지 |
| [0018](./0018-ios-embedded-bun-worker.md) iOS | 유지 | 단일 뷰 조건이 공통 계약이 됨 |
| `docs/GLOSSARY.md` | 수정 | "창 인스턴스" 항목 삭제, "뷰 ID"와 "WebView 프로필"의 multiple, isolated 설명 삭제, "창 소유 관계", "부모 종속 모달 창" 삭제 |

## 후속 작업

- 이 결정 PR은 문서만 바꾼다. 런타임, 계약, 설정 스키마는 구현 PR에서 바꾼다.
- 모바일 CLI는 지금 `app.view`와 `app.window`가 없으면 거부하므로 `app.view` 선택화에 맞춰 검사를 바꿔야 한다.
- 모바일 CLI는 지금 host 권한과 backend 권한을 모두 거부하므로, 모바일에서 `capabilities()`와 windows 작업을 호출하려면
  모바일 windows 어댑터와 capabilities 어댑터, CLI 검사 변경이 필요하다. 구현 PR에서 다룬다.
- 다중 창 API와 설정은 구현 PR에서 바로 제거한다. 개발 단계이므로 이전 형식과의 호환, 경고, 유예 기간을 두지 않는다.
- 구현 PR은 계약 테스트, windows-native CI, macOS 네이티브 CI 결과를 구분해서 보고한다.
- 다중 창 재제안은 위 조건을 갖춘 새 ADR로만 한다.

근거: [창 계약](../../plugins/windows/src/contract.ts), [창 선언 검증](../../packages/runtime-bun/src/window-config.ts),
[CLI 설정](../../packages/cli/src/config.ts), [Android 조건](../../packages/cli/src/android.ts),
[UI 소유권](../../native/windows/bun/ui.ts), [새 창 요청 처리](../../native/windows/bun/webview.ts),
[Android Activity](../../native/android/host/src/main/java/dev/bunaway/host/BunawayActivity.java).

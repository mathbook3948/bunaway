---
status: accepted
---

# 뷰는 화면과 정책을 선언하고 창 인스턴스는 실행 중에 생성한다

결정일: 2026-10-11. 검토 기준: main `49ed0a5`.
Windows SDK와 호스트가 이 계약을 구현한다. 실제 WebView2 검증은 windows-native CI에서 수행한다.

## 배경과 기존 결정의 변경

문서 편집기와 채팅 앱은 같은 화면을 사용하면서 서로 다른 문서나 대화를 여러 창에
표시한다. 실제 창 개수는 실행 중에 정해지므로 `editor1`, `editor2`처럼 뷰와 정책을
미리 복제하는 방식으로는 이 사용 사례를 자연스럽게 표현하기 어렵다.

[ADR 0004](./0004-multi-window-per-view-policy.md)의 뷰별 창 하나 제한과
[ADR 0016](./0016-window-creation-contract.md)의 같은 뷰 다중 창 보류 결정을 변경한다.
뷰는 UI 자산, 출처, 접근 정책과 생성 기본값을 선언하는 단위로 유지한다.
그 선언에서 실제 창을 여러 번 생성할 수 있게 한다. 실행 중 새로운 뷰, 임의 URL이나
권한 정책을 등록하는 기능은 허용하지 않는다.

기존 단일 창 동작과 프로필 경로는 기본값으로 보존한다.
[ADR 0010](./0010-windows-first-platform-model.md)에 따라 Windows에서 먼저 구현하고,
macOS는 해당 어댑터 구현 전까지 새 계약을 `UNSUPPORTED`로 거부한다.
스키마는 새 필드를 검증하며 macOS 네이티브 지원 여부는 그 뒤에 검사한다.

## 뷰 선언과 생성 모드

`app.windows`에는 계속 뷰마다 생성 정의 하나만 선언한다. 중복 view 선언은 오류다.
현재 설정은 다음 필드를 받는다.

| 필드 | 계약 |
| --- | --- |
| `instances` | `"single"` 또는 `"multiple"`. 기본값은 `"single"`. |
| `maxInstances` | 정수 1–128. multiple에서는 필수이며 single에서는 생략 또는 1만 허용한다. |
| `profile` | `"shared"` 또는 `"isolated"`. 기본값은 `"shared"`. 생성 호출에서 변경할 수 없다. |

```json
{
  "view": "editor",
  "title": "Editor",
  "home": "https://app.bunaway.local/editor.html",
  "window": { "width": 800, "height": 600 },
  "startup": false,
  "instances": "multiple",
  "maxInstances": 8,
  "profile": "shared"
}
```

editor 화면과 정책을 한 번 선언하고 필요할 때 최대 8개의 창을 연다.
설정 창처럼 하나만 필요한 화면은 기본 single 모드를 사용한다.
`startup: true` 또는 생략은 모드와 관계없이 초기 인스턴스 하나만 생성한다.
`startup: false`는 초기 인스턴스를 생성하지 않는다. 창 없는 시작의 tray 또는
keep-alive 요구는 그대로 유지한다.

## 생성, 조회와 특정 창 제어

기존 create/recreate의 `Promise<null>` 결과는 바꾸지 않는다.
창 인스턴스를 직접 다루는 API를 추가하고 기존 제어 입력을 선택적으로 확장한다.
현재 SDK는 다음 인스턴스 API와 입력을 제공한다.

| API 또는 입력 | 계약 |
| --- | --- |
| `create({ view, options? })` | single 전용. 이미 열린 창 또는 생성 예약이 있으면 `BUSY`. 결과는 `null`. |
| `recreate({ view, options? })` | single 전용. 기존 확인과 정리를 거쳐 재생성하며 결과는 `null`. 닫힌 창도 생성한다. |
| `createInstance({ view, options? })` | single과 multiple 모두 지원한다. 새 인스턴스를 생성하고 `{ windowId, viewId }`를 반환한다. single은 기존 create와 같은 슬롯을 사용한다. |
| `recreateInstance({ view, windowId, options? })` | 지정한 살아 있는 인스턴스만 교체하고 새 `{ windowId, viewId }`를 반환한다. 이전 ID가 닫혔거나 없으면 `INVALID_ARGUMENT`. 다른 창을 만들거나 선택하지 않는다. |
| `list()` | 기존 선언별 `{ view, open }` 목록을 유지한다. open은 그 뷰에 닫히지 않은 네이티브 창이 하나 이상 있는지 나타낸다. |
| `listInstances()` | 닫히지 않은 네이티브 창의 `{ windowId, viewId }` 목록을 반환한다. 숨김과 준비 중인 창도 포함하며 선언 순서와 생성 승인 순서로 정렬한다. 네이티브 창을 아직 만들지 않은 예약은 제외한다. |
| 제어와 상태 조회의 `{ view, windowId?, ... }` | view는 권한 대상이며 windowId는 특정 창 수명이다. ID가 지정되면 호스트가 실제 뷰와 일치하는지 확인한다. ID 생략은 single에서만 허용한다. |

multiple 뷰에 기존 create/recreate 또는 ID 없는 제어를 호출하면 `INVALID_ARGUMENT`다.
창이 우연히 하나만 열려 있더라도 자동 선택하지 않는다. 이렇게 해야 동시 생성과
종료에 따라 같은 입력의 대상이 달라지지 않는다. 새 SDK의 일반 소비자는 반환된
WindowIdentity의 viewId를 제어 입력의 view로, windowId를 창 수명으로 사용한다.

옵션의 허용 필드, 선언값 병합, `null`의 제약 해제, 준비 후 표시와 기본값 복원은
ADR 0016과 [생성 옵션 구현 이슈 #102](https://github.com/mathbook3948/bunaway/issues/102)를
재사용한다. 프로필, 새 정책, URL과 호출자 지정 windowId는 생성 옵션이 아니다.
createInstance도 WebView 설정 완료 시 반환하며 문서와 SDK 준비를 기다리는 작업은 아니다.

getCurrent는 인증된 호출 컨텍스트에 연결된 창을 반환한다. 같은 view의 첫 창이나
전경 창으로 대신하지 않는다. getById, getFocused와 getLastActive도 특정 창 수명을
반환한다. 문서 탐색과 SDK 재연결은 ID를 유지하고 네이티브 재생성은 새 ID를 받는다.
getById는 닫힌 이전 ID에 `null`을 반환한다. 그 ID를 제어하면 `INVALID_ARGUMENT`이며
isDestroyed는 형식과 view 권한을 확인한 뒤 `true`를 반환한다. 살아 있는 다른 view의
ID를 넣으면 일치 검사에서 거부한다. ID를 다른 창에 재할당하지 않는다.

부모 조회와 자식 종료, 모달 입력 차단은 계속 windowId 수명으로 처리한다.
setParent의 자식 입력에도 선택적 windowId를 적용하고 부모의 실제 view 권한을 확인한다.
부모 하나를 닫아도 같은 view의 다른 부모 인스턴스나 그 자식까지 닫지 않는다.
completeSplashscreen의 기존 `{ view, splash }`는 두 선언 모두 single인 경우만 지원한다.
multiple 뷰를 넣으면 `INVALID_ARGUMENT`이며 임의 인스턴스를 선택하지 않는다.

## 권한과 연결 세션

생성과 제어에는 기존 대상 view의 `windows:control`을 사용하고 deny를 우선한다.
같은 view의 모든 인스턴스는 같은 명령, 이벤트와 Host 정책을 사용한다.
이 권한은 해당 뷰의 모든 창 제어를 허용한다. 창별로 다른 권한이 필요한 경우에는
서로 다른 정책 뷰를 선언한다. 생성 요청자의 정책을 새 창에 복사하지 않는다.
웹 직접 호출에는 각 새 API의 `plugin.windows.<작업>` 명령 허용도 필요하다.

listInstances는 `windows:list`를 요구하고 결과를 대상 view의 control 권한으로 제한한다.
기존 네 ID 탐색 API의 list와 control 요구는 유지한다. 특정 창의 getSnapshot과
getReadiness는 대상 view의 control만 요구한다. 호스트는 입력 형식, view 권한,
선언과 ID의 일치 여부를 검사한 뒤에만 창이나 프로필을 변경한다.

각 창은 별도 WebView, ViewBoundary와 연결 컨텍스트를 소유한다. 문서 세대, pending
요청, 구독, 취소와 준비 상태도 창마다 분리한다. 같은 view에서 같은 요청 ID와 문서
세대 숫자를 쓰더라도 응답이나 SDK 준비 확인을 다른 창에 전달하지 않는다.
UI의 소유 자원과 작업 예약은 창 인스턴스로 관리하고, 라우트는 호스트 발급 컨텍스트로
찾은 뒤 viewId와 문서 세대를 확인한다. packet.route.viewId만으로 전달 대상을 찾지 않는다.

앱 이벤트의 기존 view 대상 발행은 그 view의 구독한 모든 세션에 전달한다.
명령 응답과 세션 대상 native event는 해당 컨텍스트로만 전달한다.
windows.changed는 변경된 창의 문서 구독으로만 보내고 windows.readiness는 기존 대상
control 권한을 가진 구독 세션들에 보낸다. 두 이벤트의 windowId로 같은 view의 창을
구분한다. 폐기된 컨텍스트와 이전 문서 세대의 응답 및 이벤트는 차단한다.

## WebView 프로필과 데이터 수명

프로필은 연결 세션과 별개다. 같은 프로필을 공유해도 IPC 응답과 이벤트의 세션 격리는
유지해야 한다. 앱 백엔드 상태와 Host 저장 범위도 별도 계약을 유지한다.

- shared: 같은 view의 창들이 영속 WebView2 프로필을 공유한다. 기존 인코딩한 viewId의
  경로와 단일 창 호환 경로를 보존한다. 호스트가 같은 설정의 environment를 함께 소유하고
  controller를 창마다 만든다. 쿠키, localStorage와 IndexedDB가 공유되며 브라우저 프로세스
  장애가 해당 프로필의 여러 창에 영향을 줄 수 있다. 창 하나를 닫아도 다른 창의
  environment를 해제하지 않는다.
- isolated: 각 인스턴스가 별도 임시 프로필과 environment를 소유한다. 프로필은 열린
  인스턴스의 네이티브 재생성에서 유지하고 최종 종료와 실패 정리 후 제거한다.
  windowId가 바뀌어도 내부 프로필 소유자는 재생성 정리가 끝날 때까지 유지한다.
  새 createInstance와 앱 재실행은 이전 임시 데이터를 복원하지 않는다.

isolated의 영속 복원 키와 호출별 임의 프로필 선택은 이번 범위에 포함하지 않는다.
프로필 모드 전환은 앱 설정 변경이며 기존 데이터를 자동 이동하지 않는다.
정리 실패와 OS 파일 잠금으로 즉시 제거하지 못한 임시 프로필은 다시 사용하지 않고
앱 소유 경로 안에서 후속 정리한다. 정리 기한 초과를 자원 해제 성공으로 계산하지 않는다.

## 동시 작업, 상한과 종료

선언 상한 128개와 살아 있거나 생성 예약 또는 정리 중인 인스턴스 상한을 구분한다.
Windows 호스트는 앱 전체에서 인스턴스 슬롯을 최대 128개 유지하며 뷰별 maxInstances도
동시에 검사한다. single은 1개다. 상한은 성능 보장이 아니며 앱은 더 작은 값을 선언할 수 있다.
용량이 없으면 새 createInstance는 `BUSY`로 실패한다.

multiple에서는 같은 view의 서로 다른 창을 동시에 생성할 수 있다. 입력과 권한 검사를
마친 뒤 UI 소유 경로에서 슬롯을 원자적으로 예약한다. 생성 실패와 취소는 그 요청의
슬롯과 자원만 정리한다. 닫는 중인 인스턴스는 실제 네이티브 정리 전까지 슬롯을 점유한다.
재생성은 자신의 슬롯을 유지하고 기존 controller와 HWND를 정리한 뒤 새 자원을 만든다.
같은 인스턴스의 중복 재생성은 `BUSY`지만 같은 view의 다른 인스턴스를 막지 않는다.
shared environment의 초기화와 참조 수 변경은 프로필 소유 경로에서 직렬화한다.

닫기 확인 거절은 기존 창을 유지한다. 승인된 재생성은 이전 문서 컨텍스트 철회와
구분해서 완료하고 새 ID를 반환한다. 권한 있는 다른 세션이나 백엔드에서 호출하면
그 결과를 받을 수 있다. 교체되는 창 자신의 문서에서 호출한 경우에는 기존처럼
연결이 폐기되므로 결과 수신을 보장하지 않는다. 기존 WebView 설정 30초, 정리 35초와
취소 계약을 유지하며 프로필 해제 책임도 작업 소유자에게 둔다.
마지막 창 종료와 재생성 예약, keep-alive, 트레이 복원은 실제 인스턴스 수로 판단한다.
[ADR 0013](./0013-desktop-lifecycle.md)에 따라 트레이 Open과 두 번째 실행은 기존처럼
살아 있는 모든 창을 복원한다. 살아 있는 창이 없으면 첫 선언에서 한 인스턴스만
생성한다. 빈 선언은 창을 생성하지 않는다.

## 구현 이슈와 완료 기준

이 결정 PR은 런타임이나 스키마를 바꾸지 않으며 기존 뷰별 창 하나 검사는 유지한다.
#102는 생성 옵션 구현 PR에, 다중 창은
[Windows 구현 이슈 #104](https://github.com/mathbook3948/bunaway/issues/104)로 관리한다.
공통 창 작업 이슈 [#78](https://github.com/mathbook3948/bunaway/issues/78)의 macOS 후속
작업도 Windows 실제 구현과 검증이 끝나기 전에는 완료로 닫지 않는다.

다중 창 구현에는 선언 검증과 패키징, SDK와 native schema, 창별 자원 Map과 세션 라우팅,
프로필 소유권, 상한 예약, 부모 및 모달, 트레이와 종료 경로를 함께 변경해야 한다.
실제 WebView2에서 같은 view의 동시 생성, 같은 요청 ID의 응답 분리, 단일 창 종료와
재생성, shared 데이터 공유, isolated 데이터 격리, 준비 실패와 취소, 프로필 참조 수 및
종료 후 자원 정리를 확인해야 한다. 기존 앱과 single 기본값 회귀도 통과해야 한다.
현재 사용할 수 있는 API와 새 결정, 계약 테스트와 실제 OS 실행 검증을 문서에서 구분한다.

근거: [창 선언 검증](../../packages/runtime-bun/src/window-config.ts),
[창 작업](../../plugins/windows/src/coordinator.ts), [권한과 조회](../../plugins/windows/src/windows.ts),
[UI 소유권과 전달](../../native/windows/bun/ui.ts), [프로필](../../native/windows/bun/webview.ts),
[Core 세션과 이벤트](../../packages/core/src/create-core.ts).

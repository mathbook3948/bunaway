---
status: accepted
---

# 창 생성 옵션은 사전 선언 안에서 확장하고 뷰별 창 하나를 유지한다

2026-10-11: [ADR 0017](./0017-multiple-windows-per-view.md)에서 같은 뷰의 다중 창 보류를
변경하고 single 기본값과 multiple 선택을 후속 계약으로 정했다. 아래 뷰별 하나 제한과
보류는 당시 결정 및 현재 구현의 기록이다. 호출별 옵션의 허용 범위와 기존 single API의
결과는 유지하며 다중 창 API, 프로필 소유권과 상한은 ADR 0017을 따른다.

결정일: 2026-10-11. 검토 기준: main `222998f`.
Windows 호출별 생성 옵션을 구현했다. 실제 네이티브 회귀는 CI의 windows-native 작업에서 검증한다.

## 배경과 현재 경계

[용어집](../GLOSSARY.md)의 뷰는 UI와 접근 정책의 단위이고 창은 OS 자원의 단위다.
[ADR 0004](./0004-multi-window-per-view-policy.md)의 뷰별 창 하나 정책을 유지한다.
[ADR 0002](./0002-host-owned-call-context.md)의 호스트 발급 컨텍스트와
[ADR 0010](./0010-windows-first-platform-model.md)의 Windows 우선 순서도 유지한다.

현재 구현에서 서로 다른 식별자가 있다고 해서 같은 뷰의 창 여러 개를 지원하지는 않는다.

| 경계 | 현재 구현과 새 요구사항의 관계 |
| --- | --- |
| `viewId` | 정책의 안정적인 ID다. 설정의 `view`와 같으며 생성, 제어, 목록의 대상이다. UI 자산이 같아도 뷰 ID가 다르면 별도 정책이다. |
| `windowId` | Windows 호스트가 HWND 수명마다 `window-<UUID>`로 발급한다. 문서 탐색과 SDK 재연결은 유지하고 네이티브 재생성은 교체한다. 권한이나 프로필의 키가 아니다. |
| 세션 | UI의 `views` Map은 `viewId`당 한 WebView와 `ViewBoundary`를 소유한다. 연결마다 새 호출 컨텍스트를 발급하고 라우트의 컨텍스트, `viewId`, 문서 세대를 모두 확인한다. 같은 요청 ID도 세션별로 분리한다. |
| 권한 | 새 창 문서는 대상 뷰의 명령, 이벤트와 Host 정책을 사용한다. 생성을 요청한 뷰의 권한을 새 문서로 복사하지 않는다. 뷰에서 시작한 백엔드 명령도 원래 컨텍스트를 유지한다. |
| 프로필 | 각 선언 뷰는 독립 WebView2 environment와 controller를 갖는다. 영속 user-data 경로는 앱 데이터의 `webview/<인코딩한 viewId>`이고 기존 단일 창 호환 경로는 유지한다. 재생성은 같은 프로필을 재사용한다. 창 ID를 경로에 쓰지 않는다. |
| 이벤트 | 앱 이벤트 구독과 응답은 세션 컨텍스트로 전달한다. `windows.changed`는 해당 창의 문서 구독으로 보낸다. `windows.readiness`는 이벤트 구독과 대상 뷰의 control 권한을 가진 문서들에 전달한다. 두 창 이벤트의 payload는 `windowId`, `viewId`, revision을 포함한다. 폐기된 컨텍스트와 문서 세대의 전달은 차단한다. |

앱 백엔드 상태와 Host 저장 범위는 WebView 프로필과 별개다. 서로 다른 뷰라도
같은 저장 범위 권한을 부여하면 그 범위의 앱 데이터에 접근할 수 있다.

## 결정: 사전 선언 창의 호출별 옵션을 후속 구현한다

Windows의 `create`와 `recreate`에 선택적인 `options`를 추가하는 범위로 정한다.
입력은 `{ view, options? }`이고 `options` 생략 또는 빈 객체는 기존 `{ view }`와 같다.
반환값은 기존 `Promise<null>`을 유지한다. 현재 SDK와 Windows 호스트가 이 입력을 지원한다.

| 허용할 options 필드 | 값, 적용과 기본값 |
| --- | --- |
| `title` | 1–1024자 문자열, NUL 금지. 생략하면 선언 제목. |
| `window.width`, `window.height` | 내용 영역의 96 DPI 논리 픽셀, 정수 200–4096. 각 필드를 생략하면 선언값. |
| `window.minWidth`, `window.minHeight`, `window.maxWidth`, `window.maxHeight` | 정수 200–4096 또는 `null`. 생략하면 선언값, `null`이면 해당 축의 제약 해제. 병합한 min > max는 거부하고 초기 크기는 최종 제약 안으로 보정. |
| `visible` | boolean. 생략하면 선언값, 선언도 생략하면 `true`. `false`는 처음부터 숨겨 생성하며 활성화하지 않는다. |
| `showWhenReady` | `"document"`, `"sdk"` 또는 `null`. 생략하면 선언값, `null`이면 선언된 자동 표시를 이번 생성에서 해제. 설정하면 visible과 관계없이 숨겨 생성하고 첫 준비 뒤 한 번 표시. |

`window`는 위 여섯 필드의 부분 객체다. 빈 객체도 선언값을 유지한다.
모든 옵션은 생성할 때 선언값과 병합한 새 설정에만 적용한다. 카탈로그와 정책,
이전 호출의 설정을 수정하지 않는다. 옵션 없는 다음 재생성은 원래 선언으로 돌아간다.
선언 옵션과 같은 검증을 재사용하고 크기 제약의 `null`과 자동 표시의 해제만 명시적으로 처리한다.

`home`, URL query, origin, 새 뷰나 정책, 프로필 경로와 공유 여부, 호출자 지정 ID,
`startup`, 부모와 모달, 위치, 스타일과 렌더러 선택은 생성 옵션에서 허용하지 않는다.
알 수 없는 필드와 잘못된 옵션은 `INVALID_ARGUMENT`로 거부한다.
UI 자산과 출처는 배포 때 검증한 선언으로 고정하며, 부모와 모달은 열린 두 창에
기존 `setParent`로 설정한다. 위치는 생성 뒤 기존 geometry API로 변경한다.
macOS의 기존 `{ view }`는 유지한다. 새 nonempty options는 어댑터 구현 전
`UNSUPPORTED`로 거부한다. 다른 플랫폼 지원을 Windows 구현의 선행 조건으로 삼지 않는다.

## 권한, 생성 순서와 자원 제한

새 생성 권한은 추가하지 않는다. 현재와 후속 옵션 모두 대상 `view`의
`windows:control`을 요구하며 deny가 우선한다. 웹 직접 호출에는 해당 뷰의
`commands`에 `plugin.windows.create` 또는 `plugin.windows.recreate`도 필요하다.
앱 명령을 통한 호출은 그 명령의 허용과 원래 뷰 Host 권한을 따르고, setup은
`backend.permissions`를 따른다. 생성은 대상 뷰에 선언된 권한을 확대하지 않는다.

구현은 입력 검증, 권한 검사, 선언 조회와 병합값 검증을 완료한 뒤에만
예약하거나 기존 창을 닫는다. 잘못된 입력은 세션 철회, 프로필 생성이나 HWND 변경을
일으키지 않아야 한다. 이미 열린 뷰의 create와 같은 뷰의 동시 생성은 계속 `BUSY`다.
recreate는 닫기 확인과 기존 세션 철회, WebView와 HWND 정리 이후 새 자원을 만든다.
승인한 재생성은 이전 문서 세션이 폐기돼도 완료한다. 기존 취소, 정리 기한과
[데스크톱 종료](./0013-desktop-lifecycle.md) 계약을 유지한다.

선언은 앱당 0–128개이며 startup이 false이거나 숨겨진 선언도 상한에 포함한다.
선언된 뷰마다 활성 또는 생성 예약 창은 하나다. 예약과 정리 중인 창을 두 번째
생성의 빈 슬롯으로 취급하지 않는다. 이전 네이티브 자원 정리 전에 새 프로필 소유자를
만들지 않는다. 창 없는 시작은 tray 또는 keep-alive를 요구하며 빈 카탈로그는
임의 창 생성 권한을 의미하지 않는다. 메모리 예산이나 128개 창의 성능 보장은 아니다.

현재 API_LIMITS의 pending 요청 128개, 세션별 구독 128개, 기본 명령 기한 30초와
협상 기한 10초를 늘리지 않는다. 창 생성의 WebView 설정 대기는 30초, 이전 창
정리 대기는 35초다. 호출 기한이 먼저 만료될 수도 있다. UI 큐 포화는 `BUSY`,
새 생성의 요청 취소는 `CANCELLED`이며 이미 시작한 네이티브 작업은 정리 책임을 유지한다.

## 식별자 발급과 조회

`viewId`는 앱 개발자가 정책과 창 선언에 지정한다. 1–128자의 영문 대소문자, 숫자,
밑줄, 점, 콜론과 하이픈을 허용하고 대소문자를 구분한다. 런타임에서 새 정책 ID를
발급하거나 창 옵션으로 별칭을 만들지 않는다.
호스트만 `windowId`를 발급한다. create의 완료는 WebView 설정 준비이며 웹 문서나
SDK 초기화 완료를 뜻하지 않는다. 생성 뒤 `getById`, 인증된 출처의 `getCurrent`,
`getFocused`, `getLastActive` 및 `getSnapshot`과 `getReadiness`로 식별자와 상태를 구한다.
호출한 뷰와 생성 대상이 다르면 대상 view의 getSnapshot 또는 getReadiness에서 새 ID를
받는다. getCurrent는 생성 대상이 아니라 호출자 창을 반환하고 getById는 이미 받은 ID를 조회한다.
목록은 계속 `{ view, open }`이고 snapshot과 readiness에는 `viewId`를 쓴다.
`getById`, `getCurrent`, `getFocused`, `getLastActive`에는 `windows:list`와
결과 대상의 `windows:control`이 필요하다. `getSnapshot`과 `getReadiness`에는
대상 뷰의 `windows:control`만 필요하다.
자신의 HWND를 바꾸지 않은 세션 재연결은 ID를 유지한다. 닫거나 재생성한 이전 ID의
getById는 `null`이며 다른 창으로 자동 대응하지 않는다. 백엔드의 getCurrent는 `null`이다.
옵션을 추가해도 ID를 반환하기 위해 create의 기존 결과를 바꾸거나 ID에 권한을 부여하지 않는다.

## 보류: 같은 뷰의 창 여러 개와 임의 동적 선언

같은 UI 자산을 여러 창에서 쓰는 것은 서로 다른 사전 선언 뷰로 지원한다.
각 뷰의 정책은 앱이 명시한다. 프레임워크가 정책을 복제하거나 생성 때 새 뷰를 등록하지 않는다.
같은 `viewId`의 동시 다중 창과 선언되지 않은 창 생성은 보류한다.

이를 지원하려면 UI의 뷰별 자원 Map, 현재 창을 viewId로 찾는 API, 창 제어의 대상,
재생성 예약과 취소, renderer 복구 및 부모 종료를 창 수명별로 옮겨야 한다.
프로필을 공유하면 쿠키와 localStorage 및 브라우저 프로세스 장애가 함께 영향을 받을 수 있고,
창마다 프로필을 만들면 영속 키, 정리와 재실행 복원 계약이 필요하다.
windowId를 추가 인자로 받는 것만으로 이 문제들이 해결되지 않는다.
명시적 사용자 사례와 창별 라우팅, 프로필 선택, 뷰별 및 앱 전체 생성 상한,
교차 세션 응답과 이벤트 차단 검증을 갖춘 후 별도 ADR로 재검토한다.

## 현재 오류와 호환성

| 현재 입력 또는 상태 | 계약 |
| --- | --- |
| app.windows에 같은 view 두 번 선언 | 시작 전 설정 오류. 지연 또는 숨김 선언도 예외 없음. 뷰별 하나 제한과 별도 ID 사용을 진단. SDK WireError가 아님. |
| create/recreate에 options 또는 추가 필드, caller windowId 전달 | 공개 registry와 Host 입력 schema에서 `INVALID_ARGUMENT`. 아직 유효한 옵션 API가 아니므로 `UNSUPPORTED`로 바꾸지 않음. |
| 형식이 유효한 view에 생성 권한 없음 | `PERMISSION_DENIED`. 선언 여부와 무관하게 권한을 먼저 검사. |
| 권한을 가진 미선언 view | `INVALID_ARGUMENT`. 카탈로그에 새 항목을 만들지 않음. |
| 이미 열린 view의 create | `BUSY`. 기존 창과 세션을 유지하고 show 또는 recreate 사용을 안내. |
| 같은 view의 생성 또는 재생성 진행 중 추가 요청 | `BUSY`. 추가 작업을 시작하지 않으며 먼저 승인된 작업은 기존 수명주기를 계속 수행. |
| 취소, 종료, 재생성 닫기 거절 또는 정리 기한 초과 | `CANCELLED`. 생성 실패 또는 WebView 설정 기한 초과는 `INTERNAL`. |

ADR 0004의 정책은 변경하지 않으므로 ID, 프로필, 정책 파일의 마이그레이션은 없다.
여러 문서 창을 쓰려는 앱은 선언별로 서로 다른 view와 명시적인 정책을 작성하고 같은
home을 재사용할 수 있다. 기존 view 이름을 바꾸면 프로필 경로도 바뀌므로 데이터 이동 없이
이름만 바꾸는 마이그레이션을 안내하지 않는다. 기존 단일 창 프로필 호환 경로도 보존한다.
후속 options 도입은 선택적 입력 추가이며 기존 `{ view }`, `null` 결과와 재생성 기본값은 유지한다.
식별자 끝의 개행은 기존 공개 ID 계약에 맞춰 설정 경계에서도 즉시 거부한다.

## 구현과 검증 완료 기준

이번 변경은 선언 중복과 열린 창 재생성 안내, 식별자 끝의 개행 거부를 보완한다.
현재 schema의 옵션과 임의 ID 거부, 대상 권한, 중복 생성의 자원 보존, 128개 선언 경계를
계약 테스트로 고정한다. 기존 창 ID, 세션, 프로필과 이벤트 회귀는 그대로 사용한다.
이 결과를 호출별 옵션이나 같은 뷰의 여러 창 기능 구현 완료로 표시하지 않는다.

후속 옵션 구현은 SDK와 native schema, Windows UI 어댑터, 설정 병합과 실패 정리,
생성별 ID 조회 및 실제 WebView2의 숨김, 준비, 취소와 재생성을 함께 검증해야 한다.
특히 잘못된 옵션으로 기존 창을 닫지 않음, 재생성 기본값 복원, 새 세션의 대상 정책,
이전 컨텍스트의 응답과 이벤트 차단, 프로필 재사용과 동시 소유 방지를 확인한다.

후속 구현 명세와 완료 조건은 [GitHub 이슈 #102](https://github.com/mathbook3948/bunaway/issues/102)에서 관리한다.
이번 결정 PR으로 해당 구현 이슈를 닫지 않는다.

근거: [선언 검증](../../packages/runtime-bun/src/window-config.ts),
[창 schema](../../plugins/windows/src/contract.ts), [창 작업](../../plugins/windows/src/coordinator.ts),
[권한과 조회](../../plugins/windows/src/windows.ts), [UI 소유권](../../native/windows/bun/ui.ts),
[ID 발급](../../native/windows/bun/win32.ts), [프로필](../../native/windows/bun/webview.ts).

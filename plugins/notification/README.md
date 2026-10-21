# notification

`@bunaway/plugin-notification`은 Windows의 알림 API 지원과 현재 앱의 OS 알림 설정을
조회하고 Windows 알림 설정 페이지를 열며 실행 중 toast를 표시하는 선택 네이티브 플러그인이다.
`defineNativePlugin`과 Zod 계약으로 `notification.getStatus`, `notification.openSettings`를
`notification.show`, `notification.clear`, `notification.clearGroup`, `notification.clearAll`, `notification.list`를 선언하며 각 작업은 같은 이름의 독립 정책 권한을 요구한다.
공개 helper는 `notification.getStatus()`와 `notification.openSettings()`이다.

자세한 반환값, 권한, 오류와 사용 예는
[notification API](../../docs/site/src/content/docs/reference/plugins/notification.mdx)를 따른다.
현재 unpackaged Windows x64의 호스트 앱 ID를 사용한다. MSIX 상태 조회는 패키지 식별자
연동 전까지 `UNSUPPORTED`로 거부한다. 상태 조회에는 이 ID로 등록된 시작 메뉴 바로가기와
같은 process AppUserModelID가 필요하다. 바로가기만으로 OS 알림 상태가 초기화되지는 않으며
아직 알림을 보낸 적 없는 앱도 `UNSUPPORTED`를 반환할 수 있다. 등록 없이 실행하는 개발
환경이나 바로가기를 생성하지 않은 설치에도 적용된다. 기존 상태의 같은 ID는 같은 OS 설정을 읽는다.

## 네이티브 동작

상태 조회는 Windows Runtime의 `ToastNotificationManager.CreateToastNotifier(appId)`와
`ToastNotifier.Setting`을 직접 호출한다. WinRT 클래스나 인터페이스가 없으면
`support: "unsupported", setting: null`이다. Windows가 반환하는 사용자, 앱, 그룹 정책과
manifest 차단을 구분하며 모르는 값은 `unknown`이다. Windows가 현재 앱의 알림 상태를 찾지
못하면 `UNSUPPORTED`이며 다른 실제 조회 실패도 오류로 반환한다. 조회를 위해 알림을 보내거나
상태를 자동 생성하지 않는다. `show`는 요청한 첫 알림을 실제 전송하며 OS 상태를 만들 수 있다. `enabled`는 실제 toast
표시나 activation 가능성을 보장하지 않는다.

플러그인은 UI Worker의 기존 STA와 메시지 pump를 사용한다. 상태와 설정 요청은 호출별
WinRT 초기화, HSTRING과 COM 참조를 정리하고 toast는 이벤트 해제까지 자체 STA 참조를 유지한다.
opener가 먼저 초기화한 STA가 있어도 자신의 초기화 횟수만 해제한다. 어댑터 종료는
DLL을 정리하며 반복 종료는 안전하다. 정책과 취소 검사는 네이티브 실행 직전에
호스트가 수행한다. 이미 접수한 설정 열기 요청은 취소나 종료로 되돌리지 않는다.

설정 열기는 `ShellExecuteW`로 고정된 `ms-settings:notifications` URI를 요청한다.
임의 URI, 다른 앱 ID나 레지스트리 설정 변경을 제공하지 않는다. 성공은 OS 요청 접수이며
화면 표시, 사용자 동의나 설정 변경 완료가 아니다. Windows 데스크톱 알림에는 동의
팝업 요청 API가 없으므로 사용자가 설정에서 변경한 뒤 상태를 다시 조회해야 한다.

## Toast 표시와 실행 중 이벤트

`show({ id, group?, title, body?, data?, silent?, suppressPopup?, timeoutType?, expiresAfterSeconds? })`는 WinRT에 toast를
전달하고 `{ id, group }`을 반환한다. 반환은 OS 접수이며 화면 표시를 보장하지 않는다.
`id`와 `group`은 영문 대소문자, 숫자, `.`, `_`, `-`로 된 1~16자이며 기본 group은
`bunaway`이다. 같은 앱 ID, group, id는 이전 알림을 교체한다. 제목은 1~256자,
본문은 최대 2048자다. XML에 사용할 수 없는 제어 문자와 단독 surrogate는 거부하고
나머지 텍스트는 XML escape한다. 임의 XML, 파일, 이미지, 실행 명령이나 URI는 받지 않는다.
`silent` 기본값은 false이며 true이면 소리를 억제한다. `suppressPopup` 기본값도 false이며
true이면 popup 대신 알림 기록으로 전달한다. OS 설정에 따른 억제는 별개다.
`data`는 최대 2048자의 앱 문자열 또는 null이며 Windows activation 인수에 넣지 않는다.

`icon`(appLogoOverride)과 `image`는 `C:\` 형식의 로컬 드라이브 절대 경로 또는 null이다. 상대 경로, UNC,
URL, `..` 구간, 제어 문자는 거부한다. 확장자는 png, jpg, jpeg, gif만 허용하고 파일은 존재하는
일반 파일이며 3,000,000바이트 이하여야 한다. 드라이브 문자 뒤 `:`(NTFS ADS)와 짝 없는 surrogate도
거부한다. `imagePlacement: "hero"`는 `image`가 있어야 한다. 파일 접근 전에 `GetDriveTypeW`로 고정
드라이브와 RAM 디스크만 허용하고, 파일을 `GetFileAttributesW`로 한 번 확인해 디렉터리와 offline,
recall 속성을 거부한다. 링크는 따라가고 링크 대상은 이 검사에 포함하지 않으며 경로 제한은 앱 명령이 맡는다. 두 함수는
플러그인 수명 kernel32 바인딩을 쓴다. 네트워크를 가리키는 `subst` 드라이브와 검사 뒤 경로 교체는 막지
못한다. 인코딩한 file URI는 경로(최대 259자)보다 길어질 수 있고 길이는 검사하지 않는다.
`soundLoop`이면 `<toast duration="long">`을 출력한다. 검사는 show 직전에 하며 실패는 `INVALID_ARGUMENT`이다. 경로는
세그먼트별로 percent-encode한 `file:///` URI로 바꾸고 XML escape한다. `imagePlacement`는 `inline`(기본)
또는 `hero`이다. `sound`는 `Default`, `IM`, `Mail`, `Reminder`, `SMS`, `Looping.Alarm`~`Looping.Alarm10`,
`Looping.Call`~`Looping.Call10` 중 하나이며 `ms-winsoundevent:Notification.<이름>`으로 재생한다. Windows
비패키지 앱은 임의 소리 파일을 재생할 수 없다. `soundLoop`는 `Looping.*` 소리에만 허용한다.
`silent: true`와 `sound`는 함께 줄 수 없고 `INVALID_ARGUMENT`이다.

`timeoutType`은 `default`(기본)와 `never`이다(Electron `Notification`과 같은 값). `never`는
`<toast scenario="reminder">`를 출력해 popup이 사용자가 닫을 때까지 남게 한다. reminder는 버튼이 있어야
하므로 `actions`와 `reply`가 없으면 `<action content="" arguments="dismiss" activationType="system"/>`
닫기 버튼을 넣고, 있으면 그 버튼을 쓴다. `suppressPopup`이면 효과가 없다.
`expiresAfterSeconds`(1~604800의 정수 또는 null)는 `IToastNotification.put_ExpirationTime`(slot 7)에
`PropertyValue.CreateDateTime`(IPropertyValueStatics slot 21)로 만든 값을 `IReference<DateTime>`으로 QueryInterface해 넘겨
알림 센터에서 그 시간 뒤에 항목을 제거한다. DateTime은 1601-01-01 UTC 기준 100 ns tick이다. DateTime 값과
팩토리 참조는 호출 직후 해제한다. Windows CI는 시나리오 XML과 보관된 알림의 `ExpirationTime`을
확인하며, 실제 popup 유지와 만료 시점의 제거는 확인하지 않았다.

`actions`(`{ id, label }` 최대 5개, id 중복 불가, label 1~64자)와 `reply`(`{ placeholder?, buttonLabel }`)를
지정하면 toast에 버튼과 텍스트 입력 상자를 추가한다. 응답 입력 상자는 `hint-inputId`로 연결한 전송 버튼과 함께 선언하므로
버튼과 전송 버튼을 합쳐 5개까지이고 `buttonLabel`에 기본값이 없다. 버튼의 activation 인수는
`action:<id>`, 전송 버튼은 `reply`이며 `data`는 XML에 싣지 않는다. 버튼을 누르면
`notification.actionInvoked`를 `{ id, group, actionId, reply, data }`로 전달한다. `actionId`는 전송
버튼이면 null, `reply`는 입력 상자가 있으면 입력 문자열(비워 두면 빈 문자열), 없으면 null이다.
2048 UTF-16 코드 단위를 넘는 응답, 문자열이 아닌 응답 값, 선언하지 않은 인수와 읽을 수 없는 인수는 이벤트를 만들지 않는다. 본문 클릭은
`notification.clicked`이다. 인수는 Activated 이벤트 인자의 `IToastActivatedEventArgs`와
`IToastActivatedEventArgs2.UserInput`(ValueSet)에서 callback 안에 복사하고 얻은 COM 객체와 HSTRING은
모두 해제한다.

`notification.clicked`는 `{ id, group, data }`, `notification.dismissed`는
`{ id, group, reason }`, `notification.failed`는 `{ id, group, hresult }`를 전달한다.
이벤트는 실제 native callback에서 만들며 show 성공만으로 clicked나 표시 이벤트를 만들지 않는다.
reason은 `userCanceled`, `applicationHidden`, `timedOut`, `unknown`이다.
failed의 HRESULT는 unsigned 32비트 값이다. Show 자체의 동기 실패는 호출 오류로 반환한다.
이벤트 정책, 살아 있는 구독 경로와 `notification.show` 권한을 모두 가진 뷰에만 전달한다.
백엔드 이벤트 구독이나 `onOpen` 라우팅은 추가하지 않는다.

`clear({ id, group? })`는 같은 앱의 해당 popup과 기록만 제거하고 null을 반환한다.
이전 프로세스가 남긴 같은 ID의 기록도 제거할 수 있다. 같은 group 전체는 `clearGroup`, 앱 전체 기록은 `clearAll`이 지운다.
`clearGroup({ group })`은 같은 앱의 해당 group에 속한 popup과 알림 센터 기록을 모두 제거하고 null을
반환한다. `group`은 `id`와 같은 식별자 규칙을 따르며 기본값이 없어 생략할 수 없다. 이번 실행이 소유한
해당 group의 toast를 `ToastNotifier.Hide`로 숨긴 뒤 `IToastNotificationHistory.RemoveGroupWithId(group, appId)`를
호출하므로 이전 프로세스가 남긴 기록도 제거하고 다른 group과 다른 앱의 알림은 건드리지 않는다.
없는 group은 오류 없이 성공한다. 해당 group의 소유 항목은 폐기해 늦게 온 callback을 버리고 소유 상한 64개에서
빼며 dismissed 이벤트는 보내지 않는다. 실패하면 소유권을 유지하므로 다시 호출할 수 있다.
`clearAll()`은 입력 null로 같은 앱(호스트 앱 ID)의 popup과 알림 센터 기록을 모두 제거하고
null을 반환한다. 이번 실행이 소유한 toast를 `ToastNotifier.Hide`로 숨긴 뒤
`IToastNotificationHistory.ClearWithId(appId)`를 호출하므로 이전 프로세스가 남긴 기록도 제거하고
다른 앱의 알림은 건드리지 않는다. 소유 중인 항목을 모두 폐기해 늦게 온 callback을 버리고
소유 상한 64개를 비운다. 실패하면 소유권을 유지하므로 다시 호출할 수 있다.
Tauri 알림 플러그인의 `removeAllActive`와 같은 범위이며 Electron `Notification`에는 대응 API가
없어 Tauri 기준으로 제공한다. ClearWithId는 `IToastNotificationHistory`의 12번 slot
(IInspectable 다음 RemoveGroup, RemoveGroupWithId, RemoveGroupedTagWithId, RemoveGroupedTag,
Remove, Clear, ClearWithId)이며 기존 clear가 쓰는 RemoveGroupedTagWithId는 8번 slot이다.
`list()`는 입력 null로 호스트 앱 ID의 알림 기록(`IToastNotificationHistory2.GetHistoryWithId`,
IInspectable 다음 GetHistory, GetHistoryWithId의 7번 slot)에 남은 항목의 `{ id, group }` 배열을
반환한다. 각 항목의 Tag와 Group은 `IToastNotification2`(get_Tag 7번, get_Group 9번 slot)에서
읽으며 이전 프로세스가 남긴 항목도 포함한다. 다른 앱의 알림은 조회하지 않는다. 태그가 없거나
식별자 규칙(`[A-Za-z0-9._-]{1,16}`)을 벗어난 항목은 `clear`로 가리킬 수 없으므로 결과에서 뺀다.
제목, 본문과 `data`는 반환하지 않는다. 빈 기록은 빈 배열이며 소유권과 이벤트에 영향이 없다.
Tauri 알림 플러그인의 `active()`와 같은 범위이며 Electron `Notification`에는 대응 API가 없어
Tauri 기준으로 제공한다.
교체와 clear 이후 이전 객체에서 늦게 온 callback은 버린다. clear와 앱 종료는 별도
합성 dismissed 이벤트를 만들지 않는다. timeout dismissed 뒤에도 같은 객체의 후속 callback을
받기 위해 소유권을 유지한다. 동시에 최대 64개의 ID/group을 소유하며 clear로 반환한다.
한계에 도달하면 새 ID의 show는 `BUSY`이다. 같은 ID 교체는 가능하다.
종료는 이번 실행이 소유한 알림을 지우고 구독, COM 객체, callback과 DLL을 정리한다.
교체와 clear는 지연된 native Release를 STA marshaling pump에서 작업당 최대 1초 기다린다.
종료는 전체 정리에 하나의 1초 한도를 사용하며 실패는 숨기지 않는다.

시작 메뉴 바로가기와 process AppUserModelID가 일치하는 unpackaged Windows x64를
대상으로 한다. MSIX는 패키지 식별자 연동 전까지 `UNSUPPORTED`이다. 플러그인은 바로가기,
COM activator, URL handler를 자동 등록하지 않으며 기존 설치 선택을 보존한다.
실행 중인 프로세스가 받은 Activated callback만 clicked 또는 actionInvoked로 전달한다. 종료 상태에서 앱을
시작하거나 `onOpen`으로 전달하지 않는다. 알림 센터에서 나중에 클릭하거나 비정상 종료 후
남은 알림의 activation은 보장하지 않는다. 강제 종료는 정리를 실행할 수 없으며 앱은
다음 실행에서 알고 있는 ID/group을 clear할 수 있다. 이미지, 예약과 영속
activation은 후속 범위다. 종료 후 버튼 클릭과 이전 프로세스 알림의 버튼도 이벤트가 없다.

기준 API: [CreateToastNotifier](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationmanager.createtoastnotifier),
[Setting](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotifier.setting),
[NotificationSetting](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.notificationsetting),
[unpackaged 앱의 첫 알림 전 상태 조회 제약](https://github.com/CommunityToolkit/WindowsCommunityToolkit/blob/main/Microsoft.Toolkit.Uwp.Notifications/Toasts/Compat/ToastNotifierCompat.cs),
[Windows 설정 URI](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings-app).

## 검증 범위

- `bun test tests/api/notification.test.ts`: Zod 입력/출력, 독립 정책 권한, SDK 컨텍스트와
  취소, WinRT HRESULT와 자원 정리 및 고정 설정 URI의 성공/실패 계약을 검사한다.
  FFI 실패 검사는 별도 프로세스의 제어된 경계이며 실제 Windows 실행 근거가 아니다.
- `bun --no-env-file test tests/lifecycle/windows-notification.test.ts`: Windows에서 실제
  별도 프로세스에서 누락된 앱 등록의 오류를 확인한다. 등록된 조회는 격리된 프로세스와
  UUID 시작 메뉴 바로가기를 만들고 엄격한 WinRT projection getter와 FFI 값을 비교한다.
  fixture는 고유 tag/group의 popup을 억제한 15초 만료 알림으로 OS 상태를 초기화한 뒤
  성공과 실패 모두 history에서 제거하고 비었는지 확인한다. 실제 I/O Worker의 승인, 거부,
  취소와 opener STA 공존 및 종료도 검사한다. 바로가기도 실패 때 정리하며 사용자 알림
  설정이나 production 바로가기를 변경하지 않는다. 이 준비는 공개 알림 표시 API의 검증이 아니다.
  `mise run host:windows`에도 포함한다. 다른 OS에서는 해당 네이티브 검사를 건너뛴다.
- `BUNAWAY_NOTIFICATION_SETTINGS_NATIVE=1 bun --no-env-file test tests/lifecycle/windows-notification.test.ts`:
  폐기 가능한 Windows 데스크톱에서만 실행한다. 실제 알림 설정 열기 요청 접수를 추가로
  확인한다. 기본 CI는 이 표시 작업을 실행하지 않으며 페이지 렌더링이나 사용자 설정
  변경을 확인하지 않는다.

사용자가 Windows 설정에서 앱/전체 알림을 끄거나 정책으로 차단하는 시나리오, 실제
설정 페이지 표시와 집중 지원, MSIX, 실제 popup 화면과 사용자의 클릭/종료 activation은 수동 검증 또는
후속 구현 범위다. 기본 CI 통과로 이 항목을 완료했다고 판단하지 않는다.


- `bun test tests/api/notification-toast.test.ts`: 입력/출력, 작업별 권한과 이벤트 수신 권한,
  XML escape, 교체와 stale callback, 소유권 상한, 실패 후 재시도 및 지연 Release를 검사한다.
  격리된 FFI fixture는 실제 JSCallback vtable을 호출하지만 Windows 실행 증거는 아니다.
- `bun --no-env-file test tests/lifecycle/windows-toast.test.ts`: Windows에서 UUID 바로가기와
  소리/popup을 억제한 알림을 사용해 실제 Show, XML, 교체, 개별 제거와 종료 후 history를
  독립적인 WinRT projection으로 확인한다. 서로 다른 ID/group의 popup 억제 알림 3개를
  `clearAll`로 제거해 history가 비는 것도 확인한다. 같은 항목을 `list`가 id/group으로
  돌려주는지도 확인한다. 별도 STA/MTA fixture는 실제 COM marshaling,
  callback 실행 스레드와 지연 Release 정리를 확인한다. `host:windows`에도 포함한다.
  이 검사는 실제 사용자의 클릭이나 종료 상태 activation을 검증하지 않는다. 버튼과 응답 상자가
  있는 toast를 Windows가 접수하고 history에 보존하는지, Activated 인자 파서가 의존하는 인터페이스
  id와 메서드 순서가 Windows 메타데이터와 같은지, 실제 ValueSet에서 응답 문자열을 읽고 문자열이 아닌
  값과 없는 키를 구분하는지는 확인한다. 실제 버튼 클릭에서 인자 객체를 읽는 경로는 GUI 입력이
  필요해 자동 검증하지 않으며, `tests/api/notification-toast.test.ts`의 가짜 COM 객체와
  `tests/api/notification-actions.test.ts`의 계약 시험으로 해석과 자원 해제를 검사한다.

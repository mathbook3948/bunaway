# notification

`@bunaway/plugin-notification`은 Windows의 알림 API 지원과 현재 앱의 OS 알림 설정을
조회하고 Windows 알림 설정 페이지를 여는 선택 네이티브 플러그인이다.
`defineNativePlugin`과 Zod 계약으로 `notification.getStatus`, `notification.openSettings`를
선언하며 각 작업은 같은 이름의 독립 정책 권한을 요구한다.
공개 helper는 `notification.getStatus()`와 `notification.openSettings()`이다.

자세한 반환값, 권한, 오류와 사용 예는
[notification API](../../docs/site/src/content/docs/reference/plugins/notification.mdx)를 따른다.
현재 unpackaged Windows x64의 호스트 앱 ID를 사용한다. MSIX 상태 조회는 패키지 식별자
연동 전까지 `UNSUPPORTED`로 거부한다. 상태 조회에는 이 ID로 등록된 시작 메뉴 바로가기와
같은 process AppUserModelID가 필요하다. 등록 없이 실행하는 개발 환경이나 바로가기를
생성하지 않은 설치에서는 `UNSUPPORTED`를 반환할 수 있다. 등록된 같은 ID는 같은 OS 설정을 읽는다.

## 네이티브 동작

상태 조회는 Windows Runtime의 `ToastNotificationManager.CreateToastNotifier(appId)`와
`ToastNotifier.Setting`을 직접 호출한다. WinRT 클래스나 인터페이스가 없으면
`support: "unsupported", setting: null`이다. Windows가 반환하는 사용자, 앱, 그룹 정책과
manifest 차단을 구분하며 모르는 값은 `unknown`이다. Windows가 현재 앱 식별자를 찾지
못하면 `UNSUPPORTED`이며 다른 실제 조회 실패도 오류로 반환한다. `enabled`는 실제 toast
표시나 activation 가능성을 보장하지 않는다.

각 동기 요청은 I/O Worker에서 STA WinRT 초기화, HSTRING과 COM 참조를 정리한다.
opener가 먼저 초기화한 STA가 있어도 자신의 초기화 횟수만 해제한다. 어댑터 종료는
DLL을 정리하며 반복 종료는 안전하다. 정책과 취소 검사는 네이티브 실행 직전에
호스트가 수행한다. 이미 접수한 설정 열기 요청은 취소나 종료로 되돌리지 않는다.

설정 열기는 `ShellExecuteW`로 고정된 `ms-settings:notifications` URI를 요청한다.
임의 URI, 다른 앱 ID나 레지스트리 설정 변경을 제공하지 않는다. 성공은 OS 요청 접수이며
화면 표시, 사용자 동의나 설정 변경 완료가 아니다. Windows 데스크톱 알림에는 동의
팝업 요청 API가 없으므로 사용자가 설정에서 변경한 뒤 상태를 다시 조회해야 한다.

알림 표시, 이벤트와 toast activation은 구현하지 않았다. 바로가기나 COM activator도
자동 등록하지 않으며 시작 메뉴 바로가기를 만들지 않는 기존 설치 선택을 보존한다.
이 후속 기능에는 설치/제거, 실행 중 및 종료 상태 activation 전달 계약과 검증이 필요하다.

기준 API: [CreateToastNotifier](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationmanager.createtoastnotifier),
[Setting](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotifier.setting),
[NotificationSetting](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.notificationsetting),
[Windows 설정 URI](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings-app).

## 검증 범위

- `bun test tests/api/notification.test.ts`: Zod 입력/출력, 독립 정책 권한, SDK 컨텍스트와
  취소, WinRT HRESULT와 자원 정리 및 고정 설정 URI의 성공/실패 계약을 검사한다.
  FFI 실패 검사는 별도 프로세스의 제어된 경계이며 실제 Windows 실행 근거가 아니다.
- `bun --no-env-file test tests/lifecycle/windows-notification.test.ts`: Windows에서 실제
  별도 프로세스에서 누락된 앱 등록의 오류를 확인한다. 등록된 조회는 격리된 프로세스와
  UUID 시작 메뉴 바로가기를 만들고 엄격한 WinRT projection getter와 FFI 값을 비교한다.
  실제 I/O Worker의 승인, 거부, 취소와 opener STA 공존 및 종료도 검사한다. 바로가기는
  실패 때도 정리하며 사용자 알림 설정이나 production 바로가기를 변경하지 않는다.
  `mise run host:windows`에도 포함한다. 다른 OS에서는 해당 네이티브 검사를 건너뛴다.
- `BUNAWAY_NOTIFICATION_SETTINGS_NATIVE=1 bun --no-env-file test tests/lifecycle/windows-notification.test.ts`:
  폐기 가능한 Windows 데스크톱에서만 실행한다. 실제 알림 설정 열기 요청 접수를 추가로
  확인한다. 기본 CI는 이 표시 작업을 실행하지 않으며 페이지 렌더링이나 사용자 설정
  변경을 확인하지 않는다.

사용자가 Windows 설정에서 앱/전체 알림을 끄거나 정책으로 차단하는 시나리오, 실제
설정 페이지 표시와 집중 지원, MSIX, 실제 toast와 클릭/종료 activation은 수동 검증 또는
후속 구현 범위다. 기본 CI 통과로 이 항목을 완료했다고 판단하지 않는다.


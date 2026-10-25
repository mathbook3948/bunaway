---
status: accepted
---

# 알림 권한 요청 API, 첨부 파일, 클릭 액션 종류 등록을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `b2061c78`.

## 배경

`@bunaway/plugin-notification`은 Windows toast의 지원 여부와 사용자 설정을 `notification.getStatus`로 조회하고
`notification.openSettings`로 알림 설정 페이지를 연다. 다음 세 가지를 더 제공할지 정해야 했다.

1. 알림 권한을 앱이 요청하는 API(`requestPermission`).
2. 임의 파일 첨부(attachments).
3. 클릭 동작의 종류를 미리 등록하는 API(action type 등록).

근거가 되는 동작은 다음과 같다.

- Windows 데스크톱 앱의 toast에는 처음 표시할 때 뜨는 동의 팝업이 없다. 사용자가 설정에서
  앱 알림을 끄면 `ToastNotifier.Setting`이 그 상태를 알려 줄 뿐이고, 앱이 그 상태를 바꾸는 API는 없다.
- Electron의 메인 프로세스 `Notification`에는 권한 요청이나 조회 API가 없다. 정적 메서드는 `isSupported`와 알림 이력 관련
  메서드뿐이다. 렌더러에서는 웹 `Notification` API를 쓴다. macOS 구현은 내부에서 알림 권한을 요청하지만 앱 코드가 호출하거나
  결과를 받는 API는 없다.
- Tauri 알림 플러그인(2.7.0)은 `isPermissionGranted`와 `requestPermission`을 제공하지만, 데스크톱 구현은 항상 허용으로
  응답하고 팝업을 띄우지 않는 호환용 호출이다.
- Windows toast 스키마에는 파일 첨부 개념이 없다. 보이는 이미지(앱 로고, inline, hero)와 소리만 있고, 이 저장소는 이미
  선언 필드로 제공한다(경로 검사, 확장자와 크기 제한 포함).
- Electron `Notification`에는 첨부 파일 전용 필드가 없다. Windows에서 이미지는 `icon`(앱 로고 자리)뿐이고, 그 밖의 내용은
  `toastXml`을 직접 써야 한다. Tauri의 `attachments`는 모바일 전용이며 데스크톱 알림은 무시한다.
- Tauri는 2.6.0부터 데스크톱에서도 `registerActionTypes`로 등록한 액션을 알림 버튼으로 쓴다(`id`와 `title`만 사용하며 액션
  리스너가 있을 때만 표시한다). Electron은 알림마다 `actions`를 선언한다. 이 저장소도 알림마다 `actions`를 선언하므로 별도의
  종류 등록 단계가 필요 없다.
- 이 저장소의 클릭 경로는 알림 본문 클릭 `notification.clicked`, 버튼과 응답 전송 `notification.actionInvoked`,
  닫힘 `notification.dismissed`로 이미 나뉘어 있다(`dismissed`는 `show`로 표시한 알림 기준이며 예약 알림에는 연결되지 않는다). Electron의 `click`, `action`, `reply`, `close` 이벤트와 같은 구성이다.

## 결정

1. 알림 권한 요청 API를 제공하지 않는다. 앱은 `getStatus`로 상태를 읽고, 사용자가 선택했을 때만 `openSettings`로
   설정 페이지를 연다. 요청 접수는 사용자 동의나 설정 변경 완료를 뜻하지 않는다.
2. 임의 파일 첨부 필드를 제공하지 않는다. 이미지와 소리는 지금의 선언 필드(`icon`, `image`, `sound`)만 쓴다.
3. 클릭 액션 종류 등록(action type, 카테고리)을 제공하지 않는다. 앱은 `clicked`, `actionInvoked`, `dismissed`(`show` 알림 기준) 이벤트를
   받아 처리한다. 설치된 앱이 꺼진 동안의 클릭은 기존 `takeActivations` 경로로 받는다.
4. 사용처가 생기면 새 결정으로 다룬다. macOS 알림 구현을 추가할 때는 macOS의 권한 요청(`UNUserNotificationCenter`)이
   실제로 필요하므로, 그때 Windows에서는 항상 상태 조회와 같은 결과를 돌려주는 공통 호출을 만들지 따로 정한다.

## 근거

- 권한 요청과 첨부는 Windows 데스크톱에서 대응하는 OS 기능이 없다. Electron은 제공하지 않고, Tauri의 권한 호출은 항상
  같은 값을 돌려주며 첨부는 모바일 전용이다. 항상 같은 값을 돌려주는 API를 계약에 넣으면 호출처가 의미 없는 분기를
  쓰게 된다.
- 액션 종류 등록은 Electron과 Tauri가 다르다. Electron은 알림별 선언만 있고 Tauri는 종류를 먼저 등록해 알림이 참조한다.
  이 저장소는 Electron처럼 알림별 `actions`로 이미 같은 버튼을 만들 수 있고, 등록 단계를 더하면 등록 수명과 정리 규칙을
  새로 정해야 하므로 코어는 작게 두는 쪽을 따른다.
- `getStatus`가 이미 Windows가 실제로 알려 주는 상태(`enabled`, 앱 또는 사용자 또는 정책에 의한 비활성)를 구분한다.
  요청 API가 없어도 앱은 상태에 맞는 안내를 보여 주고 설정 열기를 제안할 수 있다.
- 파일 경로를 받는 필드를 늘리면 경로 검사, 크기 제한, 클라우드 파일 거부 같은 읽기 정책을 필드마다 유지해야 한다.
  현재 이미지 필드가 쓰는 하나의 경로 검사로 충분하다.

## 결과

- 계약, 스키마, 네이티브 코드, 권한 변경은 없다.
- `notification.mdx`의 "결과와 OS 권한" 절에 권한 요청 API가 없는 이유를, "우선순위와 고급 콘텐츠" 절에 첨부 파일과
  클릭 액션 종류 등록이 없다는 점을 적는다.
- `docs/TODO-windows.md`의 두 항목을 결정 완료로 바꾼다.

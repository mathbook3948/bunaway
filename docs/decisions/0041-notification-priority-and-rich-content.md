---
status: accepted
---

# 알림 표시 우선순위와 진행률 막대, 추가 텍스트 줄을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `aa78fa5f`.

## 배경

`@bunaway/plugin-notification`은 Windows toast를 선언 필드(제목, 본문, 아이콘, 이미지, 소리, 버튼, 응답 입력,
`timeoutType`, `expiresAfterSeconds`)에서 조립한다. 다음 두 가지를 더 제공할지 정해야 했다.

1. 표시 우선순위: toast `scenario`의 `alarm`, `incomingCall`과 알림 센터 안의 우선순위.
2. 고급 콘텐츠: 진행률 막대와 제목, 본문 밖의 추가 텍스트 줄.

근거가 되는 동작은 다음과 같다.

- Electron `Notification`은 Windows에서 `timeoutType`(`default`, `never`), `silent`, `icon`, `actions`, `reply`와
  `toastXml`을 받는다. 우선순위나 시나리오 전용 옵션과 진행률 필드는 없고, 이런 내용은 `toastXml`에서 XML을 직접
  쓰는 방법뿐이다. `urgency`는 Linux 전용이다.
- Tauri 알림 플러그인은 데스크톱에서 제목, 본문, 아이콘, 소리, 액션을 받으며 우선순위와 진행률 필드가 없다.
- 이 저장소는 `toastXml`을 제공하지 않기로 했다. 임의 XML은 activation 인자 형식, 이미지 경로 검사를 깨기 때문이다.
  따라서 Electron에서 XML로 하던 방법은 bunaway에서 쓸 수 없고, 필요한 기능은 선언 필드로만 들어올 수 있다.
- `timeoutType: "never"`는 이미 `scenario="reminder"`로 구현되어 있다. 현재 `sound`는 `Looping.Alarm*`,
  `Looping.Call*` 시스템 소리와 `soundLoop`을 이미 받는다.
- 진행률 막대는 한 번 표시하고 끝나는 toast와 달리 같은 알림을 이후에 갱신하는 경로(진행 값 갱신과 그 값의
  수명)가 필요하다. 현재 알림은 `show`로 만들고 같은 id로 교체하거나 지우는 모델이며 갱신 전용 작업이 없다.
- 이 저장소에는 진행률을 보여주는 별도 수단이 있다. 작업 표시줄 진행률(`windows.setTaskbarProgress`)과 앱 화면이다.

## 결정

1. `alarm`, `incomingCall` 시나리오와 알림 센터 우선순위 필드를 제공하지 않는다. 오래 남기는 알림은 `timeoutType:
   "never"`, 소리 반복은 `sound`의 `Looping.*`와 `soundLoop`, 보관 기간은 `expiresAfterSeconds`로 구성한다.
2. 진행률 막대와 추가 텍스트 줄을 선언 필드로 제공하지 않는다. 본문은 `body` 하나다. 진행률은 작업 표시줄 진행률이나
   앱 화면으로 보이고, 알림은 완료나 실패를 알릴 때 `show`로 같은 id와 group을 교체한다.
3. 실제 앱이 이 기능을 요구하면 `toastXml` 없이 선언 필드로 추가하는 방식을 새 결정으로 다룬다. 진행률은 갱신
   작업과 수명 규칙, 시나리오는 표시 조건과 권한 검토를 함께 정한다.

## 근거

- 두 프레임워크가 같다. Electron과 Tauri 데스크톱 알림은 모두 우선순위 필드와 진행률 필드를 제공하지 않는다. 그대로 따라 코어와 플러그인
  계약을 작게 유지한다.
- 이 저장소에서 쓰는 곳이 없다. 사용처가 없는 시나리오를 계약에 넣으면 시나리오별 표시 조건과 테스트, 문서를 함께
  유지해야 한다.
- 진행률 막대는 갱신 작업, 갱신 중 교체와 제거의 경쟁, 앱 종료 시 정리까지 새로 정해야 해서 선언 필드 하나로 끝나지
  않는다. 같은 정보를 이미 작업 표시줄 진행률이 전달한다.
- `toastXml`을 제공하지 않으므로 Electron 앱이 XML로 우선순위나 진행률을 쓰고 있었다면 옮길 수 없다. 이 차이는
  `notification.mdx`의 "사용자 지정 toast XML" 절에 적은 `toastXml` 결정과 같은 이유(activation 인자와 미디어 경로 검사 유지)이며 문서에 적는다.

## 결과

- 계약, 스키마, 네이티브 코드, 권한 변경은 없다.
- `notification.mdx`에 우선순위, 진행률 막대, 추가 텍스트 줄이 없다는 점과 위 대안을 적는다.
- `docs/TODO-windows.md`의 두 항목을 결정 완료로 바꾼다.

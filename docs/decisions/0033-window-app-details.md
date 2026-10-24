---
status: accepted
---

# 창별 앱 표시 이름, relaunch 명령과 아이콘 설정을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `fc249c56`.

## 배경

Windows 작업 표시줄은 창의 AppUserModelID(AUMID)로 버튼을 묶고, 창에 붙은 속성(`System.AppUserModel.ID`,
`RelaunchCommand`, `RelaunchDisplayNameResource`, `RelaunchIconResource`)으로 고정 항목의 실행 명령, 표시 이름,
아이콘을 정한다. 이 속성을 창 단위로 설정하는 API를 제공할지 정해야 했다.

- 두 프레임워크의 문서 기준 설명이며 이 저장소의 테스트로 검증한 것은 아니다. Electron은 Windows에서
  `BrowserWindow.setAppDetails({ appId, appIconPath, appIconIndex, relaunchCommand, relaunchDisplayName })`을
  제공한다. Tauri는 같은 종류의 창별 API를 제공하지 않는다.
- 호스트는 시작할 때 프로세스 전체의 AUMID를 앱 ID로 한 번 설정한다(`SetCurrentProcessExplicitAppUserModelID`,
  `native/windows/bun/win32.ts`). 창에 속성을 따로 쓰지 않으면 창은 프로세스 AUMID를 따른다.
- 같은 프로세스 AUMID에 다른 기능이 묶여 있다. 시작 메뉴 바로가기는 같은 AUMID와 toast activator CLSID를 기록하고,
  notification 플러그인은 같은 프로세스 AUMID로 toast를 띄우고 기록을 조회하며, opener의 Jump List도 프로세스
  AUMID에 속한다.
- 앱 하나는 창 하나로 실행한다([ADR 0026](./0026-single-webview-single-window.md)). 창별 값이 프로세스 값과
  달라야 할 다른 창이 없다.
- 창 아이콘은 `windows.setIcon`으로 이미 바꿀 수 있다. 앱 이름과 앱 아이콘은 앱 정의와 패키징이 정한다.

## 결정

1. 창 AUMID, relaunch 명령, relaunch 표시 이름, relaunch 아이콘을 설정하는 창별 API(Electron `setAppDetails`에
   해당)는 제공하지 않는다.
2. 작업 표시줄 버튼의 앱 정체성은 프로세스 AUMID 하나이며 앱 ID에서 정해진다. 고정 항목의 이름, 아이콘과 실행
   명령은 같은 AUMID를 기록한 시작 메뉴 바로가기(패키징이 만든다)를 따른다.
3. 창 아이콘 변경은 `windows.setIcon`, 앱 재시작은 `desktop.relaunch`가 맡는다. 이 둘로 충족하지 못하는 요구가
   확인되면 별도 결정에서 다룬다.

## 근거

- 창 AUMID를 프로세스 AUMID와 다르게 쓰면 그 창의 작업 표시줄 버튼은 시작 메뉴 바로가기, toast, Jump List가
  쓰는 정체성에서 분리된다. 단일 창 앱에서는 얻는 것 없이 알림 클릭이나 고정 항목이 앱 창과 이어지지 않을
  위험만 생긴다. 이 위험은 Win32 문서 기준 추정이며 이 저장소에서 측정한 값이 아니다.
- relaunch 명령은 고정 항목을 눌렀을 때 실행할 명령을 임의 문자열로 쓰게 하는 설정이다. 앱 코드가 정한 실행
  명령을 셸이 보관하고 나중에 실행하므로 코어 계약에 들일 때는 인자 검증과 신뢰 경계를 따로 설계해야 한다.
  쓰는 곳이 없는 상태에서 그 비용을 지지 않는다.
- Tauri가 제공하지 않고 Electron만 제공하는 기능이며, 이 저장소에서 창별 정체성을 필요로 하는 사용처가 없다.
- 이름과 아이콘은 앱 단위 값이므로 앱 정의와 패키징에서 한 번 정하는 쪽이 일관된다.

## 결과

- `docs/TODO-windows.md`의 해당 항목을 결정 완료로 체크하고 이 문서를 가리킨다.
- 코드 변경은 없다.

---
status: accepted
---

# 창별 앱 표시 이름, relaunch 명령과 아이콘 설정을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `fc249c56`. 프레임워크 기준: Electron 45.0.0, Tauri 2.12.5(wry 0.57.0).

## 배경

Windows 작업 표시줄은 창의 AppUserModelID(AUMID)로 버튼을 묶는다. 창의 속성 저장소에 쓰는
`System.AppUserModel.ID`, `System.AppUserModel.RelaunchCommand`, `System.AppUserModel.RelaunchDisplayNameResource`,
`System.AppUserModel.RelaunchIconResource`가 고정 항목의 실행 명령, 표시 이름, 아이콘 정보다. 이 속성을 창 단위로
설정하는 API를 제공할지 정해야 했다.

- Electron은 Windows에서만 `BrowserWindow.setAppDetails({ appId, appIconPath, appIconIndex, relaunchCommand,
  relaunchDisplayName })`을 제공한다. 창의 속성 저장소(`SHGetPropertyStoreForWindow`)에 `System.AppUserModel.ID`,
  `RelaunchIconResource`(`경로,인덱스`), `RelaunchCommand`, `RelaunchDisplayNameResource`를 비어 있지 않은 값만
  쓴다. `appId`가 없으면 다른 옵션은 효과가 없고, `relaunchCommand`와 `relaunchDisplayName`은 함께 설정해야
  한다. 프로세스 단위 `app.setAppUserModelId`는 `SetCurrentProcessExplicitAppUserModelID`를 호출한다.
- Tauri 2, tao, wry에는 창별 AUMID나 relaunch 속성을 설정하는 공개 API가 없고 `SetCurrentProcessExplicitAppUserModelID`도
  호출하지 않는다. NSIS와 MSI 설치기가 바로가기에 `System.AppUserModel.ID`를 `tauri.conf.json`의 identifier로
  설정한다.
- Microsoft 문서(Application User Model IDs)에 따르면 창 단위 AUMID가 프로세스 단위 AUMID보다 우선한다. relaunch
  속성은 창에 명시적 AUMID가 있을 때만 쓰이고, `RelaunchCommand`와 `RelaunchDisplayNameResource`는 하나라도
  빠지면 둘 다 쓰이지 않는다. 앱을 실행하는 바로가기가 있으면 relaunch 속성 대신 바로가기에 AUMID를 지정하라고
  하며, 그 경우 바로가기의 명령줄, 아이콘, 텍스트가 relaunch 정보를 대신한다.
- 호스트는 시작할 때 프로세스 전체의 AUMID를 앱 ID로 한 번 설정한다(`SetCurrentProcessExplicitAppUserModelID`,
  `native/windows/bun/win32.ts`). 앱 ID는 호스트 설정 검증에서 필수로 확인한다. 창에 속성을 따로 쓰지 않으면
  창은 프로세스 AUMID를 따른다.
- 같은 프로세스 AUMID에 다른 기능이 묶여 있다. 설치본의 시작 메뉴 바로가기(기본으로 만들며 옵션으로 끌 수 있다)는 같은 AUMID와 toast activator CLSID를
  기록하고(바탕 화면 바로가기는 AUMID만 기록한다), notification 플러그인은 같은 프로세스 AUMID로 toast를 띄우고
  기록을 조회하며, opener의 Jump List도 프로세스 AUMID에 속한다.
- 앱 하나는 창 하나로 실행한다([ADR 0026](./0026-single-webview-single-window.md)). 창별 값이 프로세스 값과
  달라야 할 다른 창이 없다.
- 창 아이콘은 `windows.setIcon`으로 이미 바꿀 수 있다. 앱 이름과 앱 아이콘은 앱 정의와 패키징이 정한다.

## 결정

1. 창 AUMID, relaunch 명령, relaunch 표시 이름, relaunch 아이콘을 설정하는 창별 API(Electron `setAppDetails`에
   해당)는 제공하지 않는다.
2. 작업 표시줄 버튼의 앱 정체성은 프로세스 AUMID 하나이며 앱 ID에서 정해진다. 고정 항목의 이름, 아이콘과 실행
   명령은 같은 AUMID를 기록한 바로가기(설치본의 시작 메뉴 바로가기와 선택 사항인 바탕 화면 바로가기)에 맡긴다. Microsoft 문서가 바로가기에 AUMID를
   지정하는 방식을 권하기 때문이다. 패키징 없이 실행하거나 두 바로가기를 모두 끄면 바로가기가 없다.
3. `windows.setIcon`은 창 아이콘만, `desktop.relaunch`는 앱 재시작만 맡는다. 둘 다 고정 항목의 아이콘이나
   실행 명령을 정하지 않으며 `setAppDetails`의 대체가 아니라 인접 기능이다. 고정 항목에 관한 요구가
   확인되면 별도 결정에서 다룬다.

## 근거

- 창 단위 AUMID는 프로세스 단위보다 우선하므로, 창 AUMID를 프로세스 AUMID와 다르게 쓰면 그 창의 작업 표시줄
  버튼은 프로세스 AUMID를 쓰는 시작 메뉴 바로가기, toast, Jump List와 다른 정체성이 된다. 단일 창 앱에서는
  얻는 것 없이 정체성이 갈라질 위험만 생긴다.
- relaunch 명령은 고정 항목을 눌렀을 때 실행할 명령을 임의 문자열로 쓰게 하는 설정이다. 앱 코드가 정한 실행
  명령을 셸이 보관하고 나중에 실행하므로 코어 계약에 들일 때는 인자 검증과 신뢰 경계를 따로 설계해야 한다.
  relaunch 속성은 명시적 창 AUMID와 명령, 표시 이름 쌍이 모두 있어야 쓰이므로 설정 조합도 계약에 포함된다.
  쓰는 곳이 없는 상태에서 그 비용을 지지 않는다.
- Electron만 제공하고 Tauri는 제공하지 않는 기능이며, Tauri는 설치기가 바로가기에 AUMID를 기록하는 방식으로
  정체성을 정한다. 이 저장소의 패키징도 바로가기에 AUMID를 기록하는 같은 방식이고 창별 정체성을 필요로 하는 사용처가 없다.
- 이름과 아이콘은 앱 단위 값이므로 앱 정의와 패키징에서 한 번 정하는 쪽이 일관된다.

## 결과

- `docs/TODO-windows.md`의 해당 항목을 결정 완료로 체크하고 이 문서를 가리킨다.
- 코드 변경은 없다.

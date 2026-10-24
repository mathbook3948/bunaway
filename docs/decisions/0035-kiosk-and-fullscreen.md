---
status: accepted
---

# 키오스크 모드를 전체화면과 별도 상태로 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `480ec2b6`.

## 배경

키오스크 모드와 일반 전체화면의 차이를 정하고, 키오스크용 별도 API(`kiosk` 옵션, `setKiosk`, `isKiosk`)를
제공할지 정해야 했다.

- Electron은 `kiosk` 창 옵션과 `setKiosk`, `isKiosk`를 제공한다. Electron 45 기준으로 Windows와 Linux에서
  `setKiosk(k)`는 `setFullScreen(k)`만 호출하고 `isKiosk()`는 `isFullScreen()`을 반환한다. 항상 위, 작업 표시줄
  숨김, Alt+Tab 차단 같은 키오스크 전용 처리는 없다. `fullscreenable: false`이면 전체화면 전환이 바로 반환하므로
  키오스크도 동작하지 않는다. Windows 전체화면은 Chromium이 `WS_CAPTION`, `WS_THICKFRAME`을 없애고 모니터 크기로
  배치하며 Z 순서는 바꾸지 않고(TOPMOST 아님) `ITaskbarList2::MarkFullscreenWindow`를 호출한다. macOS에서만
  키오스크가 다르다. presentation options(`HideDock`, `HideMenuBar`, `DisableAppleMenu`,
  `DisableProcessSwitching`, `DisableForceQuit`, `DisableSessionTermination`, `DisableHideApplication`)를 건 뒤
  전체화면에 들어가고, 해제하면 저장한 옵션을 복원한다. 일반 전체화면은 이 옵션을 바꾸지 않는다.
- Tauri 2(tao 0.37)는 키오스크 옵션이나 API가 없다. `set_fullscreen`은 tao의 Borderless 전체화면이고
  `set_simple_fullscreen`은 macOS 전용이며 다른 플랫폼에서는 `set_fullscreen`으로 대체된다. 앱 전환과 강제 종료를
  막는 `Disable*` 계열은 어느 모드에도 없다. Windows는 `MarkFullscreenWindow`를 호출하고 TOPMOST는
  `always_on_top`일 때만 쓴다.
- 이 저장소의 Windows 전체화면(`setFullscreen`, 선언과 생성 옵션의 `fullscreen`)은 창 스타일에서
  `WS_OVERLAPPEDWINDOW`를 빼고 창을 현재 모니터의 전체 영역으로 옮긴다. 이전 스타일, 위치와 표시 상태는
  저장했다가 해제할 때 복원한다. `setFullscreen`은 창을 활성화하거나 최상위로 올리지 않는다(`SWP_NOZORDER | SWP_NOACTIVATE`). 생성 옵션의 `fullscreen`은 이어지는 첫 표시 규칙을 따른다. 이 저장소는 `ITaskbarList2::MarkFullscreenWindow`를 호출하지 않는다.
  `setFullscreenable(false)`로 진입을 막을 수 있고, 전체화면 중에는 `minimize`, `maximize`, `unmaximize`, `restore`, `toggleMaximize`를 `INVALID_ARGUMENT`로 거부한다.
- 키오스크 앱이 일반적으로 더하는 동작은 이미 개별 API로 있다. 항상 위(`alwaysOnTop`), 작업 표시줄 제외
  (`skipTaskbar`, 숨김이 아니거나 최소화, 최대화, 전체화면이면 `BUSY`이므로 선언이나 창 옵션으로 지정), 메뉴 막대 숨김(`menu.setWindowMenuVisible`), 닫기 요청을 받아 거부하는 `windows.closeRequested`와 `windows.respondClose`(닫기 요청이 가는 경우만 대상이다. 문서가 구독하고 그 뷰에 `windows.respondClose` 권한이 있어야 하며, 강제 닫기, `windows.destroy`, 앱 종료, 세션 종료, 대기 중이 아닐 때의 `windows.recreate`, 브라우저 프로세스 종료와 `closeBehavior: "hide"`의 숨김 등은 요청 없이 진행한다. 이 목록은 전부가 아니며 정확한 조건은 `windows.mdx`의 닫기 확인 절을 따른다. 공개 `windows.close`는 요청 거부 시 `false`를 반환한다),
  전역 단축키다.
- Windows에서 사용자가 키오스크를 빠져나가는 경로(Alt+Tab, Win 키, Ctrl+Alt+Del, 작업 관리자)는 OS 기능이라
  창 API로 막을 수 없다. 이를 막는 방법은 OS 설정(할당된 액세스, 셸 런처, 그룹 정책)이며 앱 프로세스의 책임이
  아니다.

## 결정

1. 키오스크를 전체화면과 별도 상태로 제공하지 않는다. `kiosk` 선언 옵션, `setKiosk`, `isKiosk`는 추가하지
   않는다.
2. 키오스크가 필요한 앱은 전체화면에 위의 개별 API를 앱이 직접 조합한다. 호스트는 조합을 대신하지 않는다.
3. 전체화면은 키오스크가 아니다. 전체화면은 앱이 `setFullscreen({ fullscreen: false })`로 나갈 수 있는 표시
   모드이고(제목 표시줄이 없어 해제 UI는 앱이 제공한다), OS 수준의 탈출 경로 차단은 제공하지 않는다고 문서에 적는다.
4. macOS의 Dock과 메뉴 막대 숨김처럼 플랫폼 고유의 키오스크 표시 옵션은 macOS 전체화면 지원을 정할 때 같이
   다룬다(`docs/TODO-windows.md`의 macOS native fullscreen 항목).

## 근거

- 두 프레임워크가 다르다. Electron은 키오스크 API가 있고 Tauri는 없다. 그러나 Electron도 Windows에서는
  키오스크가 전체화면과 같은 경로이므로, Windows에서 별도 API는 같은 동작에 이름만 하나 더 추가하는 것이 된다.
  Electron의 키오스크가 다른 부분은 macOS의 presentation options뿐이다. 코어는 작게 두고
  필요한 동작은 기존 API 조합으로 얻는 쪽이 이 저장소 방침에 맞다.
- 키오스크의 차이를 만드는 부분(탈출 경로 차단)은 창 API 밖의 OS 구성이라 호스트가 보장할 수 없다.
  `kiosk: true`라는 이름은 보장하지 못하는 잠금을 약속하는 것처럼 읽힌다.
- 쓰는 곳이 없다. 이 저장소의 예제와 계약 테스트에 키오스크 요구는 없다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `windows.mdx`의 창 상태 절에 전체화면이 키오스크가 아니라는 점과 조합 방법을 적는다.
- 키오스크 전용 요구가 실제로 확인되면 별도 결정에서 다룬다.
- Electron과 Tauri는 Windows 전체화면에서 `MarkFullscreenWindow`로 셸에 전체화면 창임을 알리지만 이 저장소는
  호출하지 않는다. 전체화면 중 작업 표시줄이 남는 경우가 확인되면 별도 변경으로 다룬다.

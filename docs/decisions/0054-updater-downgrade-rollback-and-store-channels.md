---
status: accepted
---

# updater는 낮은 버전으로 되돌리지 않고, 프레임워크가 롤백을 구현하지 않으며, MSIX 설치에서는 동작하지 않는다

결정일: 2026-10-25. 검토 기준: main `eaa3c832`.

## 배경

`updater.check`와 `updater.download`는 구현돼 있다([updater](../site/src/content/docs/reference/plugins/updater.mdx)).
설치와 재시작은 아직 없고, 그 전에 세 가지를 정해야 한다.

- 현재보다 낮거나 같은 버전을 받을 수 있게 할지(downgrade).
- 내려받기나 설치가 중간에 실패했을 때 어디까지 되돌릴지(partial failure와 rollback).
- Microsoft Store가 업데이트를 전달하는 설치에서 자체 updater를 쓸 수 있는지.

현재 동작과 사실은 다음과 같다.

- `check`는 원격 버전이 현재 버전보다 클 때만 `updateAvailable`을 `true`로 하고, 같거나 낮은 버전은 내리지 않는다.
  호출자가 이 비교를 바꾸는 입력이나 설정은 없다.
- `download`는 `<sha256>.partial`에 받은 뒤 크기와 SHA-256(설정했다면 Authenticode 게시자)을 모두 확인하고서야 최종
  이름으로 바꾼다. 실패, 취소, 시간 초과에서는 부분 파일을 지우려 하고, 지우지 못하면 다음 성공한 내려받기가 지운다. 이미 설치된 앱 파일은 건드리지 않는다.
- 패키징 채널은 `win-direct`(Inno Setup 설치 파일), `win-store-unpackaged`(Store에 제출하는 일반 EXE/MSI),
  `win-store-msix`(이름만 등록돼 있고 패키지 생성은 차단됨)다([ADR 0005](./0005-packaging-contract.md),
  [플랫폼 지원 표](../platform-support/README.md)).
- 아래 MSIX와 패키지 ID 서술은 Windows의 일반 동작이며 이 저장소의 테스트로 검증한 것이 아니다. `GetCurrentPackagePath`는
  `updater`가 쓰며, 패키지가 없는 Windows 프로세스에서의 결과만 CI에서 실행해 확인한다.
- MSIX로 설치된 앱은 읽기 전용 패키지 폴더에서 실행되고, 패키지의 교체는 패키지 관리자(Store 포함)만 한다. 앱이 내려받은
  EXE로 이 패키지를 바꿀 수 없다. 패키지 ID가 있는 프로세스는 `GetCurrentPackageFullName`으로 구분할 수 있으며
  `autostart`와 `notification` 플러그인이 이미 이 호출을 쓴다. 다만 패키지 ID만으로는 MSIX 설치와 구분되지 않는다.
  외부 위치의 실행 파일에 패키지 ID만 붙이는 방식(sparse package)도 같은 호출이 성공하지만 실행 파일 폴더는 패키지가
  소유하지 않는다.

## 결정

결정 1과 2는 Windows 앱에 적용한다. macOS의 업데이트 채널과 설치는 [macOS TODO](../TODO-macos.md)의 범위로 따로 정한다.

1. 낮거나 같은 버전으로의 downgrade는 제공하지 않는다. `allowDowngrade` 같은 설정이나 호출 인자를 추가하지 않는다.
   이전 동작으로 되돌리려는 앱은 이전 코드를 더 높은 버전 번호로 다시 게시한다(roll forward).
2. 프레임워크는 설치 단계에서 파일을 직접 교체하거나 이전 버전을 보관해 되돌리는 롤백을 구현하지 않는다. 설치는 검증된
   설치 파일을 실행하는 것으로 한다. `win-direct`의 Inno Setup 설치 프로그램은 현재 설치 후 실패를 되돌리지 않는다
   ([패키징 README](../../packages/packaging/README.md)). Run 등록 실패는 이전 소유자 기록을 보존하고, 파일 연결 등록과
   이전 EXE 정리의 실패는 원인을 해결한 뒤 같은 설치 프로그램을 다시 실행해 복구한다. 파일 복사 단계 자체의 실패 동작은 그
   문서가 정하지 않았으므로 이 결정도 정하지 않으며, 프레임워크는 어느 단계의 실패도 되돌리지 않는다.
   - 현재 동작(구현됨): 내려받기 단계의 실패는 설치된 앱을 바꾸지 않는다(`download` 동작).
   - 설치 구현이 지켜야 할 조건(구현 예정): 설치 파일은 실행 직전에 SHA-256을 다시 확인하고, 앱이 `authenticode`를 설정했다면
     서명도 다시 확인한다(검증 뒤 설치 전에 다른 프로세스가 파일을 바꾸는 것을 막지 않는다는
     [updater 문서](../site/src/content/docs/reference/plugins/updater.mdx)의 제한을 닫는 조건이다). 설치 파일을 시작하지 못한 경우는 앱이 살아 있는 동안 오류로
     전달한다. 설치 실패 뒤의 복구는 같은 설치 파일을 다시 실행하는 방식을 전제로 하므로, 설치를 시작한 뒤에도 검증된 설치 파일을
     앱 데이터 폴더에 남겨 두어야 한다. 그 파일을 언제 지울지는 설치 항목에서 정한다. `download`는 다음 성공한 내려받기에서
     다른 `.package`를 지우므로, 그 사이 새 버전을 받으면 재실행용 파일이 사라진다. 복구 가능한 기간도 설치 항목에서 정한다.

   앱이 종료된 뒤의 설치 실패를 어떻게 알리고 relaunch할지, 설치와 종료 승인, relaunch의 구체적 계약은
   [TODO](../TODO-windows.md)의 해당 항목에서 이 결정을 전제로 정한다.
3. 패키지 ID가 있고 실행 파일이 패키지 설치 위치(`GetCurrentPackagePath`) 안에 있는 프로세스, 곧 MSIX로 설치된 앱에서는 `updater`가 `UNSUPPORTED`(`details.reason: "managedByStore"`)로 실패한다.
   `check`와 `download` 모두 해당한다. 앱은 같은 코드에서 이 오류를 보고 업데이트 UI를 숨기거나 Store의 업데이트 안내로
   대체한다. 이 조건은 실행 중인 호스트가 판단하며 앱 설정으로 바꿀 수 없다. 이 조건은 [`win-store-msix`](../platform-support/README.md)
   패키지 생성이 열릴 때 함께 구현하고 검증한다. 지금은 패키지 생성이 차단돼 있어 이 경로를 실행할 수 없다.
4. `win-direct`와 `win-store-unpackaged` 설치는 자체 updater를 쓰는 채널이며 이 결정으로 달라지는 것이 없다. 후자는 Store에
   제출한 일반 EXE/MSI이고, 새 버전은 자체 updater로 기존 사용자에게 전하는 것과 별개로 신규 설치자용으로 새 버전 고정 다운로드
   주소를 Partner Center에 제출해야 한다. 제출한 주소의 파일은 바꾸지 않는다.

## 근거

- downgrade를 막는 것은 안전 문제다. 매니페스트와 패키지는 같은 서버에서 오고, SHA-256은 서버가 침해된 경우를 막지
  못한다. 게시자 서명을 고정해도 과거에 서명된 정상 설치 파일은 서명이 유효하므로, downgrade를 허용하면 침해된 서버가
  이미 수정된 취약 버전을 강제로 설치시킬 수 있다. 낮은 버전은 나중 버전이 바꾼 저장 데이터 형식을 읽지 못할 수도 있다.
  roll forward는 서명과 버전 비교를 그대로 유지하면서 같은 목적을 이룬다.
- 선례도 같은 방향이다. 확인한 시점의 공개 문서와 소스(Electron 45, electron-updater 6.8, tauri-plugin-updater 2.14)에서
  Electron의 Squirrel.Windows는 현재 버전이 최신 전체 릴리스 이상이면 적용할 릴리스가 없다고 보고, MSIX는
  `allowAnyVersion`(기본 `false`)일 때만 낮은 버전을 허용한다. electron-updater는 `allowDowngrade` 기본이 `false`이고
  channel을 지정하면 `true`가 된다. Tauri는 기본에서 더 높은 버전만 설치하며, 낮은 버전 허용(`allowDowngrades`, 기본 `false`)은
  2.12.0부터 앱 설정이나 Rust 쪽 비교 함수로만 켠다. WebView의 `check` 인자로 켜던 방식은 같은 버전에서 제거됐다. 이 결정의
  "호출 인자로 downgrade를 열지 않는다"와 같은 이유다. 예외는 Electron 내장 autoUpdater의 macOS 서버 모드로, 클라이언트가
  버전을 비교하지 않고 서버가 준 업데이트를 같은 버전이어도 설치한다. bunaway는 `check`가 항상 클라이언트에서 비교한다.
- 롤백을 프레임워크가 구현하면 설치 폴더의 교체, 보관, 복원, 실행 중 파일 잠금, 권한 상승을 모두 소유하게 된다. 설치 폴더를
  바꾸는 일은 이미 설치 프로그램의 역할이고, 직접 만든 교체기는 설치 프로그램과 상태가 어긋날 수 있다. 코어는 작게 유지하고
  이 동작은 채널의 설치 형식에 맡긴다. 복구가 설치 파일 재실행에 의존한다는 한계는 그대로 받아들이며, 더 강한 복구가 필요하면
  그 채널의 설치 구성을 보강하는 방향으로 다룬다.
- MSIX는 앱이 자기 패키지를 바꿀 수 없으므로 `download`가 성공해도 쓸 곳이 없다. 아무 안내 없이 내려받게 하는 것보다 처음
  호출에서 이유를 담아 실패하는 편이 앱이 분기하기 쉽다. 오류 코드는 이미 있는 `UNSUPPORTED`를 쓰고 이유만 추가한다.
  Store의 MSIX 경로에서는 OS가 24시간 주기로 업데이트를 확인하고, 이미 받은 사용자에게는 더 낮은 버전 번호의 패키지를 다시
  올려도 적용되지 않으므로 더 높은 버전으로 다시 게시하는 것이 공식 방법이다. 이는 결정 1의 roll forward와 같다.
- `win-store-unpackaged`는 자체 updater를 허용한다. Microsoft의 EXE/MSI 업데이트 게시 문서는 설치 프로그램이 지원하면 앱 안에서
  기존 사용자에게 업데이트를 설치할 수 있다고 하고, Store가 기존 사용자에게 업데이트를 자동이나 수동으로 제공하지 않는다고 적는다.
  Win32(비패키지) 앱의 자동 업데이트는 앱의 책임이라고 비교 문서에도 명시돼 있다. 따라서 이 채널에서 `updater`를 막으면 기존
  사용자가 업데이트를 받을 방법이 없다. Store 정책 10.2.9에는 자체 업데이트를 금지하는 문구가 없고, Store 전용 설치와 업데이트를
  요구하는 10.2.5는 게임과 Xbox 제품에만 적용된다.

## 남은 결정

- 비게임 MSIX 앱이 Store 밖의 경로로 자체 업데이트하는 것을 Store 정책이 허용하는지는 확인하지 못했다. 결정 3은 정책과
  무관하게 `updater`가 MSIX 설치에서 설치 파일(EXE, MSI)을 내려받아 쓸 수 없다는 점에 근거하며, 패키지 배포 방식의 자체
  업데이트는 이 결정의 범위 밖이다.
- macOS의 업데이트 채널(직접 배포와 Mac App Store)은 [macOS TODO](../TODO-macos.md)의 범위이며 이 결정에 포함하지 않는다.

## 영향

- 코드 변경은 없다. `check`의 비교와 `download`의 임시 파일 규칙은 이미 이 결정과 같다.
- 후속 구현: MSIX 설치 프로세스의 `managedByStore` 거부(`win-store-msix` 생성과 함께), 설치 직전 재검증과 설치 파일 보존(설치 항목과 함께).
- 결정 3의 판별 조건(패키지 ID와 설치 위치, sparse package와의 구분)은 구현 때 실제 MSIX 패키지로 확인한다. 조건이 맞지 않으면
  이 결정을 고친다.

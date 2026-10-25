---
status: accepted
---

# 앱 이름 변경, 데이터 경로 변경, bundle type 조회는 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `f295a967`. 대상: Windows 호스트.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

[ADR 0022](./0022-app-info-context.md)는 `ctx.app.name`을 앱 설정의 `title`에서, `identifier`를 `appId`에서 가져오게 했고,
`plugin-path`의 앱 전용 폴더는 `appId`로 정해지며, 그중 `appLocalData`, `cache`, `logs`는 `%LOCALAPPDATA%\bunaway\<appId>` 아래에 있다(`path.mdx`의 경로 표).
Electron(v45)은 `app.setName`, `app.setPath`와 `app.getPath`로 실행 중 이름과 경로를 바꾸거나 조회할 수 있다. `setName`은 `userData` 기본 경로 계산에 반영되지만 OS가 쓰는 이름은 바꾸지 않으며, `sessionData`는 `ready` 전에 `setPath`로 바꿔야 하고, 경로 계산 결과가 캐시되므로 이름 기반 경로도 `userData`가 처음 계산되기 전에 바꿔야 할 것으로 본다(Chromium 소스에서 추론한 것이며 Electron 45가 쓰는 리비전에서는 확인하지 않았다).
Tauri(2.12)는 앱이 뜬 뒤 이름과 식별자를 바꾸는 API가 없다. 다만 앱 생성 전에 `Context::config_mut()`와 `package_info_mut()`로 코드에서 바꿀 수 있고, `app > appDirectoriesOverride` 설정으로 `app_*_dir` 경로를 식별자와 무관하게 지정하며, webview마다 `data_directory`를 줄 수 있다.
Tauri는 빌드된 패키지 종류를 `bundle_type()`/`getBundleType()`으로 조회한다. Windows에서는 `msi`, `nsis`이고 번들러가 패치하지 않은 실행 파일은 `null`이다. Electron에는 범용 조회가 없고 `process.windowsStore`(MSIX/AppX로 실행 중이면 `true`, 아니면 `undefined`), `process.mas`, `app.isPackaged`만 있다.
`opener.getFileIcon`으로 기본 file icon 조회는 이미 제공한다.

## 결정

1. 실행 중 앱 이름 변경은 제공하지 않는다. `ctx.app.name`은 시작 시 한 번 정해진 동결 값이다. Electron의 `setName`은 `userData` 같은 기본 경로 계산에 영향을 주는 전역 상태 변경인데,
   bunaway의 데이터 위치는 이름이 아니라 `appId`로 정해지므로 이름을 바꿔도 경로는 변하지 않아 얻는 것이 적다.
   창 제목이 필요한 앱은 `windows.setTitle`을 쓴다. 이름은 빌드 설정의 `title`이 정한다. 앱 생성 후 변경 API가 없다는 점에서 Tauri와 같고, 생성 전 코드 변경 경로(`package_info_mut()`)는 두지 않는 점에서 다르다.
2. 데이터 경로 사용자 지정은 제공하지 않는다. 데이터 루트(`%LOCALAPPDATA%\bunaway\<appId>`)는 호스트가 WebView 프로필, 로그, 인스턴스 잠금을 두는 호스트 소유 위치이며
   앱에 노출하지 않는다(`dataRoot` 같은 호스트 내부 경로를 `ctx.app`에 넣지 않는다는 [ADR 0022](./0022-app-info-context.md)의 결정). 이 위치를 앱 설정이나 API로 옮기게 하면 WebView 프로필 경로가 시작 전에 확정되어야 하고,
   임의 경로를 호스트가 프로필과 잠금 파일 위치로 쓰게 되어, 경로 제한은 앱 명령이 맡는다는 [ADR 0024](./0024-plugin-path-responsibility.md)의 범위를 호스트 내부까지 넓히게 된다.
   Electron과 Tauri는 모두 시작 전에 경로를 바꿀 수 있어 선례와 다르지만, 구체적인 요구가 아직 없고 열면 경로 검증 규칙이 코어에 들어오므로 코어를 작게 유지하며 보류한다. 다른 위치에 저장해야 하는 앱(예: 포터블 데이터 폴더, 사용자가 고른 폴더)은
   `storage`/`dialog`로 앱이 고른 경로에 직접 저장한다. 시작 시점 선언(아래 대안)은 두 프레임워크의 선례와 맞으므로, 사용 사례가 생기면 별도 ADR로 연다.
3. bundle type 조회는 제공하지 않는다. 현재 쓰는 곳이 없다. 설치 프로그램 종류에 따라 달라지는 동작(업데이트 방식 선택)은 updater 설계에서 필요가 확정될 때 함께 정한다
   (TODO "Store 업데이트와 자체 updater의 사용 조건을 구분한다"). MSIX 여부는 `autostart`와 `notification` 플러그인이 `GetCurrentPackageFullName`으로 이미 각자 판별한다(`autostart`는 등록을, `notification`은 토스트 전송과 상태 조회를 UNSUPPORTED로 처리한다).
   Electron에는 범용 조회가 없고 Tauri는 Windows에서 `msi`, `nsis`를 포함한 값 목록을 공개 계약으로 둔다. 값을 공개하면 설치 종류 목록이 계약이 되어 채널이 늘 때마다 호환 부담이 생긴다.
4. 기본 file icon은 `opener.getFileIcon`이 제공하므로 추가 결정이 없다.

## 대안

- `ctx.app.name` 설정 API를 Electron의 `setName`처럼 제공한다: 앱 이름과 데이터 위치가 독립이라 효용이 작고, 시작 후 변경은 이미 만든 창 제목과 등록된 항목 이름과 불일치를 만든다.
- `appDataRoot`를 `bunaway.json`에 시작 시점 설정으로 선언한다(Tauri `appDirectoriesOverride`, Electron의 `ready` 전 `setPath`에 대응): 포터블 앱에는 유용할 수 있지만 구체적인 요구가 아직 없고, 호스트가 쓰는 프로필과 잠금 경로를 설정으로 받게 되어 검증 규칙(길이, 네트워크 공유, 권한)이 코어에 들어온다. 필요가 구체화되면 다시 연다.
- `ctx.app.bundleType`을 추가한다: 빌드가 채널을 매니페스트에 기록하면 구현은 작지만 쓰는 곳이 없어 보류한다.

## 영향

TODO-windows의 해당 항목을 결정 완료로 바꾼다. `path.mdx`에 데이터 루트가 호스트 소유이며 바꿀 수 없다는 한 줄을 추가한다. 코드 변경은 없다.

---
status: accepted
---

# Windows 설치 형식은 Inno Setup EXE를 채택하고, MSI 생성은 제공하지 않으며, MSIX는 검증 전까지 차단을 유지한다

결정일: 2026-10-28. 검토 기준: main `37221b99`.

## 배경

[ADR 0054](./0054-updater-downgrade-rollback-and-store-channels.md)는 Windows 채널 세 개를 사실로만 적었고, 어떤 설치 형식을
제공하고 제공하지 않을지는 정하지 않았다. 이 결정은 Windows만 다룬다. macOS와 Linux의 형식은 각 TODO에서 따로 정한다.

현재 산출물은 코드에서 다음과 같이 확인했다.

- `win-direct`와 `win-store-unpackaged`는 같은 설치 단계(`installerStages`)로 Inno Setup 설치 파일(EXE) 하나를 만든다.
  `win-store-unpackaged`는 거기에 Store 제출 체크리스트(`submission.json`)를 더하고 WebView2 부트스트랩을 거부한다.
  이름과 문서의 "EXE/MSI"는 Store가 받는 형식의 범위이며, 이 저장소는 MSI 파일을 만들지 않는다.
- `win-store-msix`는 채널 이름과 매니페스트 렌더러(`msix.ts`)만 있고, `stages()`는 컴파일된 Bun 앱의 활성화와 앱 데이터 경로가
  검증되지 않았다는 오류를 던진다. 매니페스트에는 StartupTask와 파일, URL 연결 선언이 이미 들어 있다.
- 업데이트는 `updater`가 설치 파일을 내려받아 SHA-256과 Authenticode 게시자를 확인하는 데까지 구현돼 있고, MSIX 설치에서는
  `UNSUPPORTED`로 실패한다(ADR 0054 결정 3).

## 결정

1. Inno Setup EXE를 Windows의 기본 설치 형식으로 채택한다. 직접 배포(`win-direct`)와 Store 일반 EXE 제출
   (`win-store-unpackaged`)이 이 형식을 쓴다.
2. MSI 생성은 제공하지 않는다. WiX 같은 MSI 생성기를 패키징 채널에 넣지 않고, MSI 전용 설정 항목도 추가하지 않는다.
   MSI가 필요한 앱은 외부 도구로 만든 MSI를 직접 배포한다. 외부 MSI를 `win-store-unpackaged` 계약(체크리스트, 서명 검증)의
   입력으로 가져오는 방식은 쓰는 앱이 생길 때 따로 정할 후보로 남긴다. 이 결정은 그 후보를 막지 않는다.
3. MSIX(`win-store-msix`)는 채택하지 않은 것도 제외한 것도 아닌 "차단 유지" 상태로 둔다. 컴파일된 앱의 패키지 활성화,
   앱 데이터 경로, 업데이트 거부(ADR 0054 결정 3)를 CI에서 검증한 뒤에 생성을 연다. 그 전에는 지금처럼 명확한 오류로 거부한다.
4. 채택한 형식마다 설치, 최초 실행, 업데이트, 제거 검증의 증거 위치를 아래 표로 관리한다. 표의 "남음"은 아직 실행해서 확인하지
   않은 항목이며, 완료로 읽지 않는다.

## 검증 증거

| 형식과 채널 | 설치와 업데이트(덮어쓰기) | 제거 | 최초 실행 | 자체 updater가 받은 설치 파일 | 상태 |
| --- | --- | --- | --- | --- | --- |
| Inno EXE, `win-direct`와 `win-store-unpackaged` | `tests/packaging/windows.test.ts`에 실제 Inno 설치 프로그램을 실행하는 테스트가 있다(덮어쓰기 설치 정책, 바로 가기, 이전 메타데이터가 없는 경우). Inno 컴파일러가 없으면 건너뛰며, CI `Windows installer tests` 잡(`windows-2022`)이 Inno를 설치하고 이 파일을 실행하도록 정의돼 있다. 특정 실행의 통과 기록은 이 문서에 인용하지 않았다. | 같은 파일에 `unins000.exe`로 제거 정책(사용자 데이터 보존 포함)을 확인하는 테스트가 있다. | 설치된 컴파일 앱의 시작은 이 파일의 범위가 아니다. 컴파일된 EXE 시작 검증은 별도 작업(PR #552)에서 다루며 main에는 아직 없다. 남음. | `tests/lifecycle/windows-updater-signature.test.ts`가 내려받기와 게시자 서명 확인을 다룬다. Windows CI 러너에서만 실행되며(`CI` 환경 변수 필요), `tests/lifecycle/run-native.ts`의 Windows native 목록에 등록돼 있다. 설치 실행은 `updater.install` 구현 항목에서 검증한다. 남음. | 형식 결정 완료, 최초 실행과 설치 실행 검증 남음 |
| MSI | 제공하지 않음 | 제공하지 않음 | 제공하지 않음 | 제공하지 않음 | 제외 |
| MSIX, `win-store-msix` | 패키지 생성 차단. 설치 검증은 PR #557의 시험이 먼저 필요하다. 남음. | 남음 | 남음 | 해당 없음(Store가 전달, `managedByStore`) | 차단 유지 |

위 표의 PR #552와 #557은 이 결정 시점에 main에 합쳐지지 않았다. 합쳐진 뒤 표의 위치를 갱신한다.

## 근거

- Electron의 도구(Forge, builder)는 Squirrel, WiX MSI, NSIS, MSIX를 모두 지원하고, Tauri는 NSIS와 WiX MSI를 지원한다. 둘 다 MSI를
  제공하지만 이 프레임워크는 코어를 작게 두고 설치 형식을 패키징 채널의 책임으로 둔다. 이미 자동 시험, 서명, 업데이터 연동이 붙은
  Inno 경로와 MSI 경로를 함께 유지하면 설치 상태(Run 등록, 파일 연결, 제거 정보, 유지 보수 잠금)를 두 벌 검증해야 한다. 이
  비용에 비해 MSI만 필요한 앱의 수요가 확인되지 않았다.
- 패키징 README의 Store 일반 앱(EXE/MSI) 제출 요건은 설치 파일 형식이 아니라 오프라인 설치, 서명, 불변 URL, 무인 설치에 대한 것이고, `win-store-unpackaged`가 EXE로 이를 채운다.
- MSIX는 Electron과 Tauri 모두 지원하는 형식이지만 패키지 ID, 읽기 전용 설치 폴더, Store 전달 업데이트가 앱 동작을 바꾼다.
  검증 없이 열면 앱 데이터 경로와 활성화가 어긋날 수 있어 차단을 유지한다.
- 이 결정은 코드와 공개 계약을 바꾸지 않는다. 결론이 "MSI 생성 제공"으로 바뀌면 새 채널 계약이므로 별도 결정으로 다룬다.

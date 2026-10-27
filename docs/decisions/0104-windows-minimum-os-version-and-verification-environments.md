---
status: accepted
---

# Windows 지원 최소 버전은 10 1809(빌드 17763)로 유지하고 검증 환경 표를 둔다

결정일: 2026-10-27. 검토 기준: main `c2ce1e44`.

## 배경

Windows 호스트가 지원하는 최소 OS 버전이 코드의 여러 곳에 따로 있고 "지원"의 정의가 한 문서에 없었다. 현재 값은 다음과 같다.

| 값 | 위치 | 역할 |
| --- | --- | --- |
| 빌드 17763 (Windows 10 1809, `10.0.17763.0`) | `packages/packaging/src/channels/windows/common.ts`의 `WINDOWS_MIN_BUILD`, `WINDOWS_MIN_VERSION` | Inno `MinVersion`의 기본값이자 하한. Inno와 MSIX 렌더러가 이보다 낮은 `minVersion`을 거부한다(오류 문구는 "bundled Bun requirement"). |
| 빌드 18362 (`10.0.18362.0`) | `packages/packaging/src/channels/windows/msix.ts`의 `UNVIRTUALIZED_MIN_VERSION` | MSIX `unvirtualizedData`를 켤 때 필요한 `minVersion` 하한. |
| 빌드 22000 (Windows 11) | `native/windows/bun/window-corners.ts`의 `FIRST_CORNER_BUILD` | 창 모서리 속성(`DWMWA_WINDOW_CORNER_PREFERENCE`)을 아는 첫 빌드. |
| 빌드 22621 (Windows 11 22H2) | `native/windows/bun/window-backdrop.ts`의 `FIRST_BACKDROP_BUILD` | 배경 재질 속성(`DWMWA_SYSTEMBACKDROP_TYPE`)을 아는 첫 빌드. |

실제로 실행해 확인해 온 환경은 두 가지다. Windows 11 Pro x64 `10.0.26200`(`docs/architecture/windows-probe-results.md`, `docs/architecture/windows-bun-results.md`)과
CI의 `Windows native integration` 잡이 쓰는 GitHub 호스트 러너 `windows-2022`(Windows Server 2022, `10.0.20348`, `.github/workflows/ci.yml`의 `matrix.os`)다.
CI에는 빌드 17763 러너와 22000 이상 러너가 없다.

선례는 공개 문서를 읽은 내용이며 이 저장소의 테스트로 검증한 것이 아니다.

- Electron은 Windows 10 이상을 지원 대상으로 문서화하고, 일부 창 API에 Windows 11 조건을 둔다(`setBackgroundMaterial`은 Windows 11 22H2 이상, `roundedCorners`는 Windows 11).
- Tauri 2는 WebView2가 동작하는 Windows를 대상으로 한다. 이 프레임워크가 쓰는 번들 Bun의 하한과 같은 방식의 OS 하한은 Tauri 문서에서 확인하지 못했다.
- 이 프레임워크의 실질적인 바닥은 번들 Bun이 요구하는 Windows 10 1809이다. Electron의 "Windows 10 이상" 범위 안에 있다.

## 결정

1. **하한은 Windows 10 1809(`10.0.17763.0`)로 유지한다.** 하한을 올리려면 코드로 확인되는 근거가 있어야 한다(번들 Bun 요구 상승, WebView2 Runtime의 지원 OS 변경, 이 프레임워크가 쓰는 Win32 API의 하한 상승).
   하한을 올릴 때는 `WINDOWS_MIN_BUILD` 한 곳과 이 문서의 표를 바꾸고 `packages/packaging/README.md`, `channels.mdx`의 문장을 함께 갱신한다.
   WebView2 최소 Runtime 버전은 이 결정에서 다시 정하지 않는다(해당 항목이 따로 정한다).
2. **하한 아래 OS에서는 설치 단계의 거부까지만 보장한다.**
   - Inno 설치 프로그램은 `MinVersion`으로, MSIX는 `TargetDeviceFamily`의 `MinVersion`으로 설치를 막는다. 패키징 도구는 하한보다 낮은 `minVersion` 설정을 만들지 않는다.
   - 설치 프로그램을 거치지 않고 실행 파일을 복사해 하한 아래에서 실행하는 경우의 시작 시 진단은 만들지 않는다. 코어 시작 경로를 넓히는 일이고 쓰는 곳이 확인되지 않았다. 필요해지면 후속으로 정한다.
3. **기능별 빌드 게이트는 하한 안의 구형 OS에서 효과가 없는 힌트로 둔다.** 현재 코드는 `UNSUPPORTED` 오류를 내지 않는다.
   - `setRoundedCorners`: 빌드 22000 미만에서는 DWM이 속성을 몰라 `E_INVALIDARG`를 돌려주고 호스트는 이를 효과 없음으로 보고 호출을 성공시킨다. 22000 이상에서 같은 오류는 실제 거부로 보고한다(`cornerPreferenceIgnored`).
   - `setBackgroundMaterial`: 빌드 22621 미만에서는 DWM 호출을 건너뛰고 성공한다. `getBackgroundMaterial`은 요청한 값을 돌려준다.
   - 두 동작은 Electron의 버전 조건과 같은 방향(효과 없음, 오류 없음)이다. 이 결정에서는 동작을 바꾸지 않는다.
   - MSIX `unvirtualizedData`는 18362 미만 `minVersion`과 함께 쓰면 패키징 단계에서 거부한다.
4. **검증 환경 표를 이 결정이 소유한다.**

   | OS 빌드 | 확인하는 곳 | 확인하는 것 | 상태 |
   | --- | --- | --- | --- |
   | 20348 (Windows Server 2022) | CI `windows-2022` 러너 | 네이티브 통합, 빌드 22000 미만 경로(모서리 힌트 무시, 재질 건너뜀) | 자동 |
   | 26200 (Windows 11) | 개발용 실기 | 22000, 22621 이상 경로(모서리, 재질 적용), 실제 WebView2 | 수동, 기록은 `docs/architecture/` |
   | 17763 (하한) | 없음 | 설치 거부 경계, 하한 빌드에서의 Bun 실행 | 미검증 |
   | 22000 이상 22621 미만 | 없음 | 모서리는 적용되고 재질은 건너뛰는 중간 경로 | 빌드 번호를 입력으로 주는 단위 테스트만(`tests/api/window-corners.test.ts`, `tests/api/window-backdrop.test.ts`) |

   17763 환경은 GitHub 호스트 러너가 제공하지 않아 CI로 만들 수 없다. 자체 호스팅 러너나 가상 머신이 필요한데 이 저장소는 운영하지 않는다.
   패키징 쪽 하한(`minVersion` 거부, 매니페스트 값)은 문자열 입력을 바꾸는 단위 테스트(`tests/packaging/windows.test.ts`)로 확인되므로 OS 환경 없이 CI에서 검증된다.
   검증 가능한 환경이 생기면 같은 표를 갱신한다.

## 근거

- 하한을 정하는 요인(번들 Bun)이 따로 있고, 그 값이 바뀔 때 `WINDOWS_MIN_BUILD` 한 곳만 고치면 된다. 근거 없이 올리면 지원하지 않는 환경만 늘어난다.
- 기능별 게이트가 이미 Electron과 같은 방향으로 동작한다. 힌트 계열 API가 구형 OS에서 오류를 내면 앱이 모든 창 호출에 OS 분기를 넣어야 한다.
- 시작 시 진단과 효과 유무 조회는 코어 계약을 넓히는 일이라 쓰는 곳이 확인될 때 따로 정한다.

## 결과

- 코드, 공개 API, 권한과 보안 경계 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

## 알려진 제한과 후속 과제

- `docs/platform-support/README.md`의 지원 표를 이 결정에 맞춰 갱신해야 한다. 이 변경은 해당 파일을 바꾸지 않는다.
- 하한 빌드(17763)의 실행과 설치 거부 경계는 검증 환경이 없어 미검증이다.
- 설치 프로그램 없이 하한 아래에서 실행했을 때의 시작 진단은 정하지 않았다.
- 구형 OS에서 모서리와 재질 힌트가 적용되었는지 앱이 알 수 있는 조회는 없다.

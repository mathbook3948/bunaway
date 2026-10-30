---
status: accepted
---

# Windows ARM64는 x64 에뮬레이션을 지원 목표로 하고 네이티브 ARM64 빌드는 후속으로 둔다

결정일: 2026-10-26. 검토 기준: main `1efc15a3`.

## 배경

Windows on ARM 기기에서 앱 실행과 CLI 빌드가 어디까지 지원되는지 정해야 했다. 현재 저장소의 상태는 다음과 같다.

- 번들 Bun은 `runtime/build-manifests/windows-x64.json`의 `windows-x64-baseline` 한 가지이고 ARM64 manifest는 없다. 호스트와 네이티브 FFI 코드도 x64 산출물만 만든다.
- 패키징 계약의 `targetFor`는 `windows-x64`와 `macos-arm64`만 빌드 대상으로 돌려주고 그 밖의 조합은 오류로 거부한다.
- Inno Setup 스크립트는 `ArchitecturesAllowed=x64compatible`, `ArchitecturesInstallIn64BitMode=x64compatible`을 쓴다. Inno Setup 6.3의 `x64compatible`은 x64와, x64 에뮬레이션이 되는 ARM64 Windows를 모두 포함한다.
  따라서 x64 설치 파일은 ARM64 기기에서도 설치가 막히지 않는다.
- 오프라인 WebView2 설정은 `x64`와 `arm64` 설치 파일을 구분해 받고 PE 헤더의 `Machine` 값으로 아키텍처를 검사한다. 다만 빌드 대상은 x64뿐이다.
- 실행 검증은 `windows-2022` x64 러너에서만 한다. ARM64 기기나 `windows-11-arm` 러너에서 실행한 기록은 없다.
- Electron은 win32-arm64 빌드를, Tauri는 `aarch64-pc-windows-msvc` 타깃을 각각 제공한다. 둘 다 에뮬레이션에만 의존하지 않는다.
  bunaway는 Bun 런타임을 직접 pin하고 소스 revision, 실행 파일 해시와 라이선스를 manifest에 기록한다([PRD](../PRD.md)). 따라서 네이티브 ARM64는 manifest, FFI 구조체 크기 점검, CI 러너, 패키징 대상 확장이 함께 필요한 별도 작업이다.

## 결정

1. Windows 11 ARM64에서 x64 번들 Bun, x64 호스트와 WebView2를 x64 에뮬레이션으로 실행하는 것을 지원 목표로 한다. 이 PR은 에뮬레이션 실행을 검증하지 않았으므로 검증 전까지 동작을 보장하지 않고,
   문서에는 "지원 목표이며 실행 검증 전"이라고 쓴다. 검증 항목을 통과하면 문서를 지원 상태로 바꾼다.
2. 네이티브 ARM64 Bun 빌드(`windows-aarch64` manifest, 별도 pin과 해시)와 ARM64 패키징 대상은 지금 만들지 않는다. 빌드 대상은 `windows-x64`만 유지하고 `targetFor`는 바꾸지 않는다.
3. Windows 10 ARM64는 대상이 아니다. 이 환경의 에뮬레이션은 x86 프로세스만 다루므로 x64 산출물이 실행되지 않는다.
4. 검증은 후속 작업으로 분리한다. GitHub Actions `windows-11-arm` 러너에서 x64 산출물로 기존 windows-native 시험의 일부(호스트 기동, 메인 페이지 로드, IPC 왕복, 창 기본 동작, 종료)를 돌린다.
   러너를 쓸 수 없거나 WebView2가 에뮬레이션에서 기동하지 않으면 이 결정의 1번을 "지원하지 않음"으로 고친다.
5. 네이티브 ARM64 Bun 빌드는 4번의 결과와 앱의 요구(성능, 에뮬레이션 불가 환경)가 확인될 때 다시 제안한다. 그때 manifest, FFI 구조체 크기 점검, 패키징 대상, 러너 시험을 함께 정한다.
6. ARM64 기기에서 `bunaway package`로 앱을 빌드하는 것은 범위에 넣지 않는다. `currentTarget()`이 `windows-x64`가 아니면 패키징이 거부되고(`packages/cli/src/package.ts`), `targetFor`도 `windows-x64`만 돌려준다.
   x64 Bun을 에뮬레이션으로 실행할 때 `currentTarget()`이 `windows-x64`로 판정되는지도 4번의 검증 항목에 넣는다.
7. 앱 개발자용 문서(packaging 채널 문서의 Windows 요구 사항)에는 산출물이 x64이고 Windows 11 ARM64에서는 에뮬레이션으로 실행하는 것이 지원 목표이며 실행 검증 전이라고 한 줄로 쓴다.

## 근거

- 이 문서가 저장소 밖의 사실로 전제하는 것은 Inno Setup `x64compatible`이 ARM64 Windows를 포함한다는 점, Windows 10 ARM64가 x86 에뮬레이션만 한다는 점, WebView2 x64 런타임이 ARM64 Windows 11의 x64 에뮬레이션에서 기동한다는 점(4번에서 검증하며 기동하지 않으면 1번을 고친다), Electron과 Tauri가 ARM64 빌드를 제공한다는 점이다. 저장소에서 확인한 것은 `inno.ts`의 설정값과 `targetFor`, manifest 구성뿐이다. 실제 설치와 실행은 4번의 검증으로 확인한다.

- Electron과 Tauri가 모두 네이티브 ARM64를 내는 점은 같다. 그러나 bunaway는 런타임 pin과 해시 기록 구조 때문에 네이티브 지원이 코어 빌드 파이프라인 전체에 걸치는 규모다.
  실행해 본 적이 없는 상태에서 manifest와 대상만 추가하면 검증되지 않은 산출물을 지원처럼 보이게 한다.
- 설치 스크립트가 이미 ARM64 기기에서 x64 설치 파일을 허용하므로 에뮬레이션 사용자는 실제로 설치를 시도할 수 있다. 그 경우에 대한 문서상의 상태를 정해 두는 편이 보장 없는 암묵적 허용보다 낫다.
- 에뮬레이션 지원 목표는 코어 계약, 권한, 앱의 보안 경계를 바꾸지 않는다. 문서와 TODO만 바뀐다.

## 결과

- 코드, 스키마, 권한, 빌드 대상과 CI 변경은 없다. 지원 범위 표(`docs/platform-support/README.md`, 사이트의 지원 범위와 패키징 설정 문서)에는 Windows ARM64 상태와 `arm64` 선언 거부를 적는다.
- 이 결정은 에뮬레이션에서 실제로 동작함을 주장하지 않는다. 지원 상태로의 전환은 `windows-11-arm` 시험 결과를 근거로 한다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조하며, `windows-11-arm` 러너 시험과 네이티브 ARM64 Bun 빌드를 별도 항목으로 남긴다.

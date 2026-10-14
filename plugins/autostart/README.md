# @bunaway/plugin-autostart

`src/index.ts`는 계약과 플랫폼 선언을 조립하고 `defineNativePlugin` 결과를 바로 default export합니다.
`src/contract.ts`는 작업 스키마와 타입, 네이티브 호출 검증을 소유하고 `src/calls.ts`는 편의 호출을 담당합니다.
플랫폼 구현은 계약을 직접 읽으며 공개 진입점을 역으로 import하지 않습니다.

Windows 사용자별 로그인 자동 실행을 제공하는 선택 네이티브 플러그인입니다.
앱에 패키지를 설치하고 `autostart`을 등록합니다. 등록 변경에는
`autostart.enable`, `autostart.disable`, 조회에는 `autostart.getStatus` 권한이 필요합니다.

```ts
import autostart from "@bunaway/plugin-autostart";

// defineApp({ modules: [], plugins: [autostart] })으로 등록합니다.
await autostart.enableAutostart(["--login", "한글 값", '인용"값']);
const status = await autostart.getAutostartStatus();
await autostart.disableAutostart();
```

자동 실행 경로는 호스트가 정하며 호출자가 다른 실행 파일을 등록할 수 없습니다.
HKCU Run에 REG_SZ를 쓰고 작업 관리자의 활성 상태는 별도로 읽습니다.
반복 등록은 현재 경로와 인자로 갱신하지만 사용자가 비활성화한 선택을 바꾸지 않습니다.
전체 명령줄은 Windows가 문서화한 260 UTF-16 코드 단위 제한을 따릅니다.
개발과 배포 등록은 분리하며 MSIX StartupTask는 지원하지 않습니다.

[공개 계약, 경로와 갱신 규칙](../../docs/site/src/content/docs/reference/plugins/autostart.mdx),
[등록 방식 결정](../../docs/decisions/0016-windows-autostart.md)을 참고하세요.
`autostart.enableAutostart({ args: ["--sync"], hidden: true })`는 앱 정의에 `desktop.tray`가
있을 때 초기 창을 숨긴 상태로 시작하도록 등록합니다. `desktop.onOpen`의
`launchReason`은 `"autostart"`와 `"manual"`을 구분하며 `source`와 별개입니다.
이는 예약 실행 인자를 읽은 결과이며 Windows가 시작했다는 인증이나 권한이 아닙니다.
초기 SDK 준비도 숨김 창을 표시하지 않으며 트레이 Open과 수동 재실행으로 기존 세션을
복원합니다. perUser Inno 설치 프로그램은 선택하지 않은 opt-in 작업과 소유 등록의
갱신 및 제거를 제공합니다. 런타임과 설치 프로그램은 현재 사용자 SID와 전체 Run
값 이름의 전역 mutex를 공유하고 확인 및 변경을 잠금 안에서 수행합니다. 5초 안에
획득하지 못하면 변경 없이 BUSY로 거부합니다. 이전 버전과 외부 도구는 참여하지 않습니다.

## 검증

```powershell
mise exec bun@1.4.2 --command "bun test tests/api/autostart.test.ts"
mise exec bun@1.4.2 --command "bun test tests/lifecycle/windows-autostart.test.ts"
```

계약 테스트는 권한, 공개 helper, 길이와 인코딩을 검사합니다. Windows 테스트는 UUID로
만든 임시 앱 ID의 실제 사용자 Run 값을 등록, 조회, 갱신하고 해제합니다. 인자 검증은
저장 명령줄을 CreateProcessW에 그대로 전달해 compiled EXE와 개발 Bun의 실제 argv를
확인합니다. 비활성화 보존 검사는 임시 ID에만 StartupApproved 테스트 값을 씁니다.
`mise run host:windows`의 desktop 시나리오는 실제 WebView2에서 초기 숨김,
SDK 준비 뒤 표시 억제, 숨김 두 번째 실행 뒤 상태 유지, 수동 재실행의 복원과 세션 유지,
백엔드 타이머와 종료 정리를 검사합니다. CI 통과는 실제 작업 관리자 조작과 사용자
로그아웃, 로그인 실행 검증을 대신하지 않습니다.
`tests/packaging/windows-autostart.test.ts`는 실제 Inno 제거가 소유 확인을 마친 뒤
중지한 상태에서 런타임과 다른 설치 ID의 쓰기가 BUSY로 거부되는지 검사합니다.
잠금 해제 뒤의 새 등록과 비활성화 기록이 다른 제거에서 보존되는지도 확인합니다.
테스트 종료 시 임시 등록, 승인 테스트 값과 실행 파일을 삭제합니다.

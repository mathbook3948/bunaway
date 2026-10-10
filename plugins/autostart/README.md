# @bunaway/plugin-autostart

Windows 사용자별 로그인 자동 실행을 제공하는 선택 네이티브 플러그인입니다.
앱에 패키지를 설치하고 `autostartPlugin`을 등록합니다. 등록 변경에는
`autostart:configure`, 조회에는 `autostart:read` 권한이 필요합니다.

```ts
import { autostartPlugin, enableAutostart, getAutostartStatus, disableAutostart } from "@bunaway/plugin-autostart";

// defineApp({ modules: [], plugins: [autostartPlugin] })으로 등록합니다.
await enableAutostart(["--login", "한글 값", '인용"값']);
const status = await getAutostartStatus();
await disableAutostart();
```

자동 실행 경로는 호스트가 정하며 호출자가 다른 실행 파일을 등록할 수 없습니다.
HKCU Run에 REG_SZ를 쓰고 작업 관리자의 활성 상태는 별도로 읽습니다.
반복 등록은 현재 경로와 인자로 갱신하지만 사용자가 비활성화한 선택을 바꾸지 않습니다.
전체 명령줄은 Windows가 문서화한 260 UTF-16 코드 단위 제한을 따릅니다.
개발과 배포 등록은 분리하며 MSIX StartupTask는 지원하지 않습니다.

[공개 계약, 경로와 갱신 규칙](../../docs/site/src/content/docs/reference/plugins/autostart.mdx),
[등록 방식 결정](../../docs/decisions/0016-windows-autostart.md)을 참고하세요.
숨김 시작과 설치 프로그램 opt-in은 후속 작업입니다.

## 검증

```powershell
mise exec bun@1.4.2 --command "bun test tests/api/autostart.test.ts"
mise exec bun@1.4.2 --command "bun test tests/lifecycle/windows-autostart.test.ts"
```

계약 테스트는 권한, 공개 helper, 길이와 인코딩을 검사합니다. Windows 테스트는 UUID로
만든 임시 앱 ID의 실제 사용자 Run 값을 등록, 조회, 갱신하고 해제합니다. 인자 검증은
저장 명령줄을 CreateProcessW에 그대로 전달해 compiled EXE와 개발 Bun의 실제 argv를
확인합니다. 비활성화 보존 검사는 임시 ID에만 StartupApproved 테스트 값을 씁니다.
실제 작업 관리자 조작과 사용자 로그아웃, 로그인 실행 검증은 별도 대화형 검증입니다.
테스트 종료 시 임시 등록, 승인 테스트 값과 실행 파일을 삭제합니다.

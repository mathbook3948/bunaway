# @bunaway/plugin-opener

`@bunaway/plugin-opener`는 허용된 HTTP 또는 HTTPS 주소를 Windows 기본 브라우저로 엽니다. 앱에 패키지를 설치하고 `openerPlugin`을 등록한 다음, 호출 출처에 `opener:openUrl` 권한을 허용해야 합니다.

```ts
import { defineApp } from "@bunaway/backend";
import { openerPlugin } from "@bunaway/plugin-opener";

export default defineApp({ modules: [], plugins: [openerPlugin] });
```

화면과 백엔드에서 다음 함수를 사용합니다.

```ts
import { openUrl } from "@bunaway/plugin-opener";

await openUrl("https://example.com/search?q=한글 값");
```

## 계약과 구현

공개 함수의 입력은 절대 HTTP 또는 HTTPS URL 문자열 하나입니다. 입력 문자열과 URL 표준화 결과는 각각 8,192자를 넘을 수 없습니다. 제어 문자, 역슬래시, 앞뒤 공백, 호스트가 없는 주소, `file:`, `javascript:`와 커스텀 스킴은 거부합니다. 유효한 주소는 `URL.href` 형식으로 정규화합니다. 공백과 한글이 포함된 경로와 쿼리는 URL 규칙에 따라 인코딩됩니다.

작업 계약은 `opener.openUrl`, 입력 `{ url: string }`, 결과 `null`, 권한 `opener:openUrl`입니다. 주소 대상에 대한 별도 권한 범위는 없습니다. 권한을 허용하면 모든 HTTP 및 HTTPS 주소를 열 수 있습니다.

Windows 구현은 UI STA에서 `ShellExecuteExW`에 `SEE_MASK_NOASYNC`와 `SEE_MASK_FLAG_NO_UI`를 지정해 운영체제에 기본 브라우저 실행을 요청합니다. 셸 명령 문자열을 만들거나 브라우저 프로세스 핸들을 소유하지 않습니다. 성공은 운영체제가 실행 요청을 접수했다는 뜻이며, 브라우저 표시나 페이지 로딩 완료를 보장하지 않습니다. 플러그인 종료 시 DLL 핸들을 닫고 정리는 반복 호출해도 안전합니다.

현재 어댑터는 Windows만 제공합니다. 파일 열기, 휴지통, 딥링크 등록과 설치 프로그램 변경은 이 패키지의 범위가 아닙니다.

## 오류

- `INVALID_ARGUMENT`: URL 형식이나 길이가 허용 범위를 벗어났습니다.
- `PERMISSION_DENIED`: 호출 출처에 `opener:openUrl` 권한이 없습니다.
- `UNSUPPORTED`: 현재 플랫폼이나 실행 환경에 Windows UI 어댑터가 없습니다.
- `INTERNAL`: Windows가 브라우저 실행 요청을 접수하지 못했습니다.
- `CANCELLED`, `TIMEOUT`: 호출이 취소되었거나 기한을 넘겼습니다.

## 검증

저장소가 고정한 Bun 버전으로 실행하려면 `mise`를 사용합니다.

```powershell
mise exec bun@1.4.2 --command "bun run --cwd plugins/opener typecheck"
mise exec bun@1.4.2 --command "bun test tests/api/opener.test.ts"
mise exec bun@1.4.2 --command "bun test tests/lifecycle/windows-opener.test.ts"
```

Windows STA와 셸 호출 검증은 Windows에서 실행해야 합니다. 다른 운영체제에서는 해당 테스트가 건너뜁니다.

실제 브라우저 검증은 기본 브라우저가 loopback 서버를 요청하는지 확인합니다. 브라우저가 열리므로 폐기 가능한 Windows Sandbox에서만 두 환경 변수를 설정해 실행하세요.

```powershell
$env:BUNAWAY_OPENER_BROWSER_TEST = "1"
$env:BUNAWAY_OPENER_ISOLATED = "1"
mise exec bun@1.4.2 --command "bun tests/lifecycle/windows-opener-browser.ts"
```

이 검증은 기본 브라우저가 해당 loopback 요청을 서버에 보냈는지 확인합니다. 실제 실행 검증 결과는 실행 환경에서 테스트를 수행한 뒤 별도로 기록합니다. OS가 실행 요청을 접수한 뒤에는 브라우저 수명이 운영체제에 속하며, 플러그인은 브라우저를 닫거나 취소된 호출을 되돌리지 않습니다.

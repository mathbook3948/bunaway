# @bunaway/plugin-opener

`@bunaway/plugin-opener`는 HTTP 또는 HTTPS 주소를 Windows 기본 브라우저로 열고, 파일을 기본 연결 앱으로 열거나 Explorer에서 선택해 표시합니다. 앱에 패키지를 설치하고 `openerPlugin`을 등록한 다음, 호출 출처에 작업별 권한을 허용해야 합니다.

```ts
import { defineApp } from "@bunaway/backend";
import { openerPlugin } from "@bunaway/plugin-opener";

export default defineApp({ modules: [], plugins: [openerPlugin] });
```

화면과 백엔드에서 다음 함수를 사용합니다.

```ts
import { openFile, openUrl, revealFile } from "@bunaway/plugin-opener";

await openUrl("https://example.com/search?q=한글 값");
await openFile("C:/Users/me/Documents/한글 보고서.txt");
await revealFile("C:/Users/me/Documents/한글 보고서.txt");
```

## 계약과 구현

공개 함수의 입력은 절대 HTTP 또는 HTTPS URL 문자열 하나입니다. 입력 문자열과 URL 표준화 결과는 각각 8,192자를 넘을 수 없습니다. 제어 문자, 역슬래시, 앞뒤 공백, 호스트가 없는 주소, `file:`, `javascript:`와 커스텀 스킴은 거부합니다. 유효한 주소는 `URL.href` 형식으로 정규화합니다. 공백과 한글이 포함된 경로와 쿼리는 URL 규칙에 따라 인코딩됩니다.

작업 계약은 `opener.openUrl`, 입력 `{ url: string }`, 결과 `null`, 권한 `opener:openUrl`입니다. 주소 대상에 대한 별도 권한 범위는 없습니다. 권한을 허용하면 모든 HTTP 및 HTTPS 주소를 열 수 있습니다.

파일 함수는 `openFile(path: string, options?: NativeInvokeOptions): Promise<null>`과 `revealFile(path: string, options?: NativeInvokeOptions): Promise<null>`입니다. Host operation은 각각 `opener.openFile`, `opener.revealFile`이며 입력은 `{ path: string }`, 결과는 `null`입니다. 권한은 각각 `opener:openFile`, `opener:revealFile`입니다. 화면에서 직접 호출하려면 뷰의 `commands`에 `plugin.opener.openFile`, `plugin.opener.revealFile`도 허용합니다.

파일 권한에는 정확한 파일 하나를 나타내는 `{ path }` scope가 필요합니다. 아래는 해당 뷰의 `host` 설정이며, setup 등 백엔드 자체 호출은 같은 grants를 `backend.permissions`에 둡니다.

```json
{
  "permissions": [
    {
      "identifier": "opener:openFile",
      "allow": [{ "path": "C:/Users/me/Documents/한글 보고서.txt" }]
    },
    {
      "identifier": "opener:revealFile",
      "allow": [{ "path": "C:/Users/me/Documents/한글 보고서.txt" }]
    }
  ]
}
```

`deny`에도 같은 scope를 사용하며 deny가 allow보다 우선합니다. 단순 문자열 권한은 파일 접근을 허용하지 않습니다. 와일드카드와 하위 폴더 포함 규칙은 없습니다. `/`는 `\`로, 드라이브 문자는 대문자로 정규화한 뒤 나머지 경로는 대소문자를 구분해 일치해야 합니다. Windows의 대소문자 구분 디렉터리에서도 다른 파일을 허용하지 않도록 한 규칙입니다.

파일 경로는 `C:\folder\file.txt` 또는 `\\server\share\file.txt`와 같이 드라이브나 UNC 공유부터 지정한 절대 경로여야 합니다. 한글, Unicode와 파일명 중간의 공백, 쉼표를 보존합니다. 길이는 최대 259 UTF-16 코드 단위, 각 이름은 최대 255 단위이며 파일과 각 부모의 이름은 파일 시스템의 실제 표기와 일치해야 합니다. 상대 경로, 드라이브 상대 경로, `.`과 `..`, 중복 구분자, 제어 문자, 잘못된 Unicode, 예약 장치명, 끝의 공백이나 점, alternate data stream과 `\\?\`, `\\.\` 장치 경로는 거부합니다. 디렉터리는 입력으로 받지 않습니다.

권한 검사 뒤 파일과 부모 디렉터리를 확인합니다. 파일이 없으면 `INVALID_ARGUMENT`과 `details.reason: "FILE_NOT_FOUND"`, 읽기나 디렉터리 조회 접근이 거부되거나 공유 잠금과 충돌하면 `PERMISSION_DENIED`를 반환합니다. reparse point, junction, 심볼릭 링크, 하드 링크와 8.3 별칭도 거부합니다. OS 요청을 제출할 때까지 핸들을 유지해 경로 교체를 막으며 성공과 실패 모두에서 닫습니다. 파일 권한은 요청 대상만 제한합니다. 기본 연결 앱의 동작, 실행 파일이나 셸 바로가기의 실행 대상을 격리하지 않으므로 신뢰하는 파일에만 `openFile`을 허용해야 합니다.

Windows 구현은 UI STA에서 Explorer 데스크톱의 `Shell.Application`에 `ShellExecute`를 요청합니다. URL과 `open` 동작을 별도의 COM 인자로 전달하며 셸 명령 문자열을 만들지 않습니다. Explorer가 브라우저를 실행하므로 브라우저는 앱의 kill-on-close Job을 상속하지 않고, 앱 종료나 개발 재시작 뒤에도 유지됩니다. 성공은 Explorer가 실행 요청을 접수했다는 뜻이며 브라우저 표시나 페이지 로딩 완료를 보장하지 않습니다. 각 호출의 COM 참조와 문자열은 성공과 실패 모두에서 해제하며, 플러그인 종료 시 DLL 핸들을 닫습니다. 반복 정리는 안전합니다.

실행에는 접근 가능한 Windows Explorer 데스크톱이 필요합니다. Explorer를 찾거나 COM 요청을 전달하지 못하면 `INTERNAL`을 반환합니다. 앱 Job에서 브라우저를 직접 실행하는 대체 경로는 제공하지 않습니다.

`openFile`도 같은 Explorer `ShellExecute` 경로를 사용하고 기본 연결 앱을 바꾸지 않습니다. `revealFile`은 `SHParseDisplayName`으로 파일의 PIDL을 얻고 `SHOpenFolderAndSelectItems`로 부모 폴더에서 그 파일 하나를 선택하도록 요청합니다. 경로를 명령줄에 이어 붙이지 않으며 PIDL은 성공과 실패 모두에서 해제합니다. 파일에 대한 OS 요청이 동기적으로 접근 거부나 파일 소실을 반환하면 위의 파일 오류로 변환하고, 다른 요청 실패는 `INTERNAL`입니다.

세 함수 모두 성공은 요청 접수를 뜻합니다. 기본 앱의 실행 완료, 파일 읽기 완료나 Explorer 화면 표시와 선택 완료를 기다리지 않습니다. OS가 접수한 뒤 발생하는 파일 소실, 연결 앱 부재, 앱 내부 실패와 화면 변경은 결과에 포함되지 않습니다. 취소와 기한 초과는 이미 접수한 요청을 되돌리지 않습니다. 네이티브 호출 중에는 OS가 반환할 때까지 작업이 계속될 수 있으며 UNC 공유나 셸 확장의 응답이 느리면 UI STA도 기다릴 수 있습니다.

현재 어댑터는 Windows만 제공합니다. 지정 앱 열기, 커스텀 URL 스킴, 휴지통, 딥링크 등록과 설치 프로그램 변경은 이 패키지의 범위가 아닙니다.

## 오류

- `INVALID_ARGUMENT`: URL이나 파일 경로가 유효하지 않거나 파일이 없습니다. 파일 소실은 `details.reason`이 `FILE_NOT_FOUND`입니다.
- `PERMISSION_DENIED`: 작업 권한이나 파일 scope가 없거나, 파일 접근, 링크 또는 경로 별칭 검사를 통과하지 못했습니다.
- `UNSUPPORTED`: 현재 플랫폼이나 실행 환경에 Windows UI 어댑터가 없습니다.
- `INTERNAL`: 파일 검사 또는 Explorer의 OS 요청에 실패했습니다.
- `CANCELLED`, `TIMEOUT`: 호출이 취소되었거나 기한을 넘겼습니다.

## 검증

저장소가 고정한 Bun 버전으로 실행하려면 `mise`를 사용합니다.

```powershell
mise exec bun@1.4.2 --command "bun run --cwd plugins/opener typecheck"
mise exec bun@1.4.2 --command "bun test tests/api/opener.test.ts"
mise exec bun@1.4.2 --command "bun test tests/lifecycle/windows-opener.test.ts"
mise exec bun@1.4.2 --command "bun test tests/lifecycle/windows-opener-job.test.ts"
```

Windows STA와 셸 호출 검증은 Windows에서 실행해야 합니다. 다른 운영체제에서는 해당 테스트가 건너뜁니다.

`tests/cli/opener.test.ts`는 로컬 `.tgz`를 독립 프로젝트에 설치하고 카탈로그, scope evaluator와 브라우저 번들을 검증합니다. 아래 opt-in 검사는 설치한 플러그인을 compiled EXE로 실행하고, 한글과 공백이 있는 실행 파일이 기본 동작으로 시작되는지와 실제 Explorer 선택을 확인합니다. 사용자 파일 연결을 바꾸지 않고 해당 테스트 폴더의 Explorer 창을 정리합니다. 데스크톱이 있는 Windows에서 실행해야 합니다. 일반 문서에 연결된 편집기의 표시나 읽기 완료 검증과 구분합니다.

```powershell
$env:BUNAWAY_OPENER_FILES_TEST = "1"
mise exec bun@1.4.2 --command "bun test tests/cli/opener.test.ts"
Remove-Item Env:BUNAWAY_OPENER_FILES_TEST
```

이 compiled EXE 검사는 MSIX, Inno 설치 프로그램이나 서명된 배포 앱의 실행 검증이 아닙니다. 실행 결과는 [Windows 기록](../../docs/architecture/windows-bun-results.md)에 구분해 둡니다.

Job 회귀 검증은 테스트용 EXE를 Explorer로 실행하고, 앱 Job의 자손 수가 0이며 앱 종료 뒤에도 EXE가 살아 있는지 실제 프로세스 핸들로 확인합니다. 브라우저는 열지 않으며 테스트용 EXE는 검증 뒤 종료합니다. 이 검증은 Windows Explorer 데스크톱이 없는 세션에서도 건너뜁니다.

실제 브라우저 검증은 기본 브라우저가 loopback 서버를 요청하는지 확인합니다. 브라우저가 열리므로 폐기 가능한 Windows Sandbox에서만 두 환경 변수를 설정해 실행하세요.

```powershell
$env:BUNAWAY_OPENER_BROWSER_TEST = "1"
$env:BUNAWAY_OPENER_ISOLATED = "1"
mise exec bun@1.4.2 --command "bun tests/lifecycle/windows-opener-browser.ts"
```

이 검증은 기본 브라우저가 해당 loopback 요청을 서버에 보냈는지 확인합니다. 실제 실행 검증 결과는 실행 환경에서 테스트를 수행한 뒤 별도로 기록합니다. OS가 실행 요청을 접수한 뒤에는 브라우저 수명이 운영체제에 속하며, 플러그인은 브라우저를 닫거나 취소된 호출을 되돌리지 않습니다.

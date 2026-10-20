# @bunaway/plugin-opener

`src/index.ts`는 계약과 플랫폼 선언을 조립하고 `defineNativePlugin` 결과를 바로 default export합니다.
`src/contract.ts`는 작업 스키마와 네이티브 호출 검증, `src/calls.ts`는 편의 호출을 담당합니다.
플랫폼 구현은 계약을 직접 읽으며 공개 진입점을 역으로 import하지 않습니다.

`@bunaway/plugin-opener`는 HTTP 또는 HTTPS 주소를 기본 브라우저로 열고, Windows와 macOS에서 파일을 기본 연결 앱으로 열거나 Explorer와 Finder에 선택을 요청합니다. 앱에 패키지를 설치하고 `opener`를 등록한 다음, 호출 출처에 작업별 권한을 허용해야 합니다.

```ts
import { defineApp } from "@bunaway/backend";
import opener from "@bunaway/plugin-opener";

export default defineApp({ modules: [], plugins: [opener] });
```

화면과 백엔드에서 다음 함수를 사용합니다.

```ts
import opener from "@bunaway/plugin-opener";

await opener.openUrl("https://example.com/search?q=한글 값");
await opener.openFile("C:/Users/me/Documents/한글 보고서.txt");
await opener.revealFile("C:/Users/me/Documents/한글 보고서.txt");
await opener.trashFile("C:/Users/me/Documents/삭제할 파일.txt");
```

## 계약과 구현

`openUrl`의 입력은 절대 HTTP 또는 HTTPS URL 문자열 하나입니다. 입력 문자열과 URL 표준화 결과는 각각 8,192자를 넘을 수 없습니다. 제어 문자, 역슬래시, 앞뒤 공백, 호스트가 없는 주소, `file:`, `javascript:`와 커스텀 스킴은 거부합니다. 유효한 주소는 `URL.href` 형식으로 정규화합니다. 공백과 한글이 포함된 경로와 쿼리는 URL 규칙에 따라 인코딩됩니다.

작업 계약은 `opener.openUrl`, 입력 `{ url: string }`, 결과 `null`, 권한 `opener.openUrl`입니다. 주소 대상에 대한 별도 권한 범위는 없습니다. 권한을 허용하면 모든 HTTP 및 HTTPS 주소를 열 수 있습니다.

파일 함수는 `opener.openFile(path: string, options?: NativeInvokeOptions): Promise<null>`과 `opener.revealFile(path: string, options?: NativeInvokeOptions): Promise<null>`입니다. Host operation은 각각 `opener.openFile`, `opener.revealFile`이며 입력은 `{ path: string }`, 결과는 `null`입니다. 권한은 각각 `opener.openFile`, `opener.revealFile`입니다. 화면에서 직접 호출하려면 뷰의 `commands`에 `plugin.opener.openFile`, `plugin.opener.revealFile`도 허용합니다.

파일 작업은 각각의 작업 이름을 허용합니다. 아래는 해당 뷰의 `host` 설정이며, setup 등 백엔드 자체 호출은 같은 이름을 `backend.permissions`에 둡니다.

```json
{
  "permissions": [
    "opener.openFile",
    "opener.revealFile"
  ]
}
```

작업 권한은 유효한 파일 경로 전체에 적용합니다. 파일별 접근 제한은 앱 명령에서 검사하고 화면에는 그 명령만 허용합니다.

파일 경로는 `C:\folder\file.txt` 또는 `\\server\share\file.txt`와 같이 드라이브나 UNC 공유부터 지정한 절대 경로여야 합니다. 한글, Unicode와 파일명 중간의 공백, 쉼표를 보존합니다. 길이는 최대 259 UTF-16 코드 단위, 각 이름은 최대 255 단위입니다. 상대 경로, 드라이브 상대 경로, `.`과 `..`, 중복 구분자, 제어 문자, 잘못된 Unicode, 예약 장치명, 끝의 공백이나 점, alternate data stream과 `\\?\`, `\\.\` 장치 경로는 거부합니다. 디렉터리는 입력으로 받지 않습니다.

권한 검사 뒤 경로를 링크까지 풀어 실제 파일을 구하고 읽을 수 있는 일반 파일인지 확인합니다. 파일이 없으면 `INVALID_ARGUMENT`과 `details.reason: "FILE_NOT_FOUND"`, 디렉터리와 일반 파일이 아닌 대상은 `INVALID_ARGUMENT`, 읽기 접근이 거부되거나 공유 잠금과 충돌하면 `PERMISSION_DENIED`를 반환합니다. 링크는 거부하지 않고 따라가며, `openFile`과 확장자 검사는 링크의 이름이 아니라 풀린 경로를 씁니다([ADR 0024](../../docs/decisions/0024-plugin-path-responsibility.md)). 확인 뒤 OS 요청 전에 경로가 바뀌는 경쟁은 막지 않습니다. 기본 연결 앱의 동작, 실행 파일이나 셸 바로가기의 실행 대상을 격리하지 않으므로 앱 명령에서 신뢰하는 파일을 정해야 합니다.

Windows 구현은 I/O Worker에서 자체 COM STA를 초기화하고 Explorer 데스크톱의 `Shell.Application`에 `ShellExecute`를 요청합니다. URL과 `open` 동작을 별도의 COM 인자로 전달하며 셸 명령 문자열을 만들지 않습니다. Explorer가 브라우저를 실행하므로 브라우저는 앱의 kill-on-close Job을 상속하지 않고, 앱 종료나 개발 재시작 뒤에도 유지됩니다. 성공은 Explorer가 실행 요청을 접수했다는 뜻이며 브라우저 표시나 페이지 로딩 완료를 보장하지 않습니다. 각 호출의 COM 참조와 문자열은 성공과 실패 모두에서 해제하며, 플러그인 종료 시 DLL 핸들을 닫고 자체 COM 초기화를 해제합니다. 반복 정리는 안전합니다.

실행에는 접근 가능한 Windows Explorer 데스크톱이 필요합니다. Explorer를 찾거나 COM 요청을 전달하지 못하면 `INTERNAL`을 반환합니다. 앱 Job에서 브라우저를 직접 실행하는 대체 경로는 제공하지 않습니다.

`openFile`도 같은 Explorer `ShellExecute` 경로를 사용하고 기본 연결 앱을 바꾸지 않습니다. `revealFile`은 `SHParseDisplayName`으로 파일의 PIDL을 얻고 `SHOpenFolderAndSelectItems`로 부모 폴더에서 그 파일 하나를 선택하도록 요청합니다. 경로를 명령줄에 이어 붙이지 않으며 PIDL은 성공과 실패 모두에서 해제합니다. 파일에 대한 OS 요청이 동기적으로 접근 거부나 파일 소실을 반환하면 위의 파일 오류로 변환하고, 다른 요청 실패는 `INTERNAL`입니다.

세 함수 모두 성공은 요청 접수를 뜻합니다. 기본 앱의 실행 완료, 파일 읽기 완료나 Explorer 화면 표시와 선택 완료를 기다리지 않습니다. OS가 접수한 뒤 발생하는 파일 소실, 연결 앱 부재, 앱 내부 실패와 화면 변경은 결과에 포함되지 않습니다. 취소와 기한 초과는 이미 접수한 요청을 되돌리지 않습니다. 네이티브 호출 중에는 OS가 반환할 때까지 작업이 계속될 수 있으며 UNC 공유나 셸 확장의 응답이 느리면 I/O Worker의 후속 작업과 정리가 지연될 수 있습니다. 창과 WebView를 담당하는 UI Worker는 이 파일 검사나 셸 요청을 실행하지 않습니다. 호스트는 I/O 작업을 시작하기 직전에 현재 호출 컨텍스트와 작업 권한을 검사하며, 승인 전 취소된 작업은 실행하지 않습니다.

macOS 구현은 NSWorkspace로 파일과 URL을 열고 Finder 선택을 요청합니다. 파일은 절대
POSIX 경로이며 기존 259 UTF-16 코드 단위 예산과 이름별 255 UTF-8 바이트 제한을
따릅니다. 상대 경로, 중복 구분자, `.`과 `..`, 제어 문자와 잘못된 Unicode는 거부합니다.
읽을 수 있는 일반 파일만 허용하고 링크는 따라갑니다. FIFO와 장치 파일은 열기 전에 거부합니다.
확인과 NSWorkspace 요청 사이에 경로가 바뀌는 경쟁은 막지 않습니다.

공개 기본 파일 helper는 POSIX와 Windows 표기를 받으며 해당 OS 어댑터가 최종 검증합니다.
지정 `.exe` 앱은 Windows 전용이고 macOS 지원 목록에 포함하지 않습니다. macOS의 공통
I/O 연결은 PR #164에 의존합니다. 플랫폼별 바인딩과 네이티브 검증 범위는
[macOS opener 구현 기록](../../docs/architecture/macos-opener.md)을 참고하세요. 초기
macOS 요청 실패는 아직 조사 중이며 네이티브 CI 통과 전에는 실행 검증 완료로 보지 않습니다.
macOS 휴지통은 제공하지 않습니다. 설치 프로그램 변경은 이 패키지의 범위가 아닙니다. 커스텀 URL scheme의 런타임 등록은 아래 "URL scheme 등록"을 참고하세요.

## Windows 바로가기

`opener.readShortcutLink(path, options?)`는 Windows 바로가기 파일(`.lnk`)의 속성을 읽고, `opener.writeShortcutLink(path, details, operation = "create", options?)`는 바로가기를 만들거나 바꿉니다. Electron `shell.readShortcutLink`, `shell.writeShortcutLink`에 대응하며 Windows만 지원합니다(macOS는 `UNSUPPORTED`).

```ts
await opener.writeShortcutLink("C:\\Users\\me\\Desktop\\App.lnk", {
  target: "C:\\Program Files\\App\\app.exe",
  cwd: "C:\\Program Files\\App",
  args: "--start",
  description: "App",
  icon: "C:\\Program Files\\App\\app.ico",
  iconIndex: 0,
});
const link = await opener.readShortcutLink("C:\\Users\\me\\Desktop\\App.lnk");
```

속성은 `target`, `cwd`, `args`, `description`, `icon`, `iconIndex`입니다. 읽기 결과는 항상 여섯 속성을 모두 담고, 설정하지 않은 문자열은 빈 문자열, `iconIndex`는 0입니다. `target`, `cwd`, `icon`은 존재하지 않아도 되는 절대 Windows 경로이며(`%`로 시작하는 환경 변수 경로는 절대 경로가 아니라서 받지 않습니다), `args`는 2,048 UTF-16 코드 단위, `description`은 260 코드 단위(Shell이 보존하는 길이이며 더 긴 값은 조용히 잘리므로 거부합니다) 이하이고 제어 문자를 받지 않습니다. 읽기는 `GetPath(SLGP_RAWPATH)`로 저장된 경로를 그대로 반환하며 대상을 찾거나 실행하지 않습니다.

`operation`은 Electron과 같습니다. `create`(기본)는 새 바로가기를 쓰거나 같은 경로의 기존 바로가기를 덮어쓰고, `replace`는 기존 바로가기를 덮어쓰며 파일이 없으면 실패합니다. 두 작업은 빈 바로가기에서 시작하므로 `target`이 필요합니다. `update`는 기존 바로가기를 읽어 입력에 있는 속성만 바꿉니다(`cwd`와 `icon`에 빈 문자열을 주면 해당 속성을 비웁니다. `iconIndex`는 바뀌지 않으므로 함께 0으로 지정하세요. `target`은 비울 수 없고, 읽기 결과를 그대로 다시 쓰면 원시 경로나 빈 `target`이 검증에서 거부될 수 있습니다)(`icon`과 `iconIndex` 중 하나만 주면 다른 하나는 유지). AppUserModelID와 toast activator는 지원하지 않습니다.

경로는 `.lnk`로 끝나는 절대 경로여야 하고 부모 디렉터리는 만들지 않습니다. 기존 파일은 파일 작업과 같이 링크를 따라 풀고, 풀린 경로가 `.lnk`로 끝나지 않으면 `INVALID_ARGUMENT`입니다. 새 파일을 만드는 `create`는 부모 폴더가 있어야 하며 요청한 경로에 씁니다. 끊어진 링크가 이미 그 이름을 차지하고 있으면 `create`는 `details.reason` 없는 `INVALID_ARGUMENT`로 거부합니다(`replace`와 `update`는 `FILE_NOT_FOUND`). 없는 파일과 부모는 `INVALID_ARGUMENT`와 `details.reason: "FILE_NOT_FOUND"`, 바로가기가 아닌 파일은 `INVALID_ARGUMENT`와 `details.reason: "NOT_A_SHORTCUT"`입니다(바로가기가 아닌 파일은 덮어쓰기 전에 `update`에서 거부하지만, `create`와 `replace`는 검사 없이 `.lnk` 파일을 덮어씁니다). Shell이 거부한 쓰기는 `INTERNAL`입니다. 호출은 COM 호출이 끝날 때까지 동기로 실행하므로 취소는 시작 전에만 적용합니다.

권한은 `opener.readShortcutLink`와 `opener.writeShortcutLink`이며 서로, 그리고 `openFile` 계열 권한과 별개입니다. 입력은 각각 `{ path }`와 `{ path, operation, details }`이고 결과는 속성 객체와 `null`입니다. 쓰기는 사용자가 실행할 대상을 만드는 작업이므로 앱 명령에서 경로와 대상을 제한하세요. 화면 직접 호출에는 `plugin.opener.readShortcutLink`, `plugin.opener.writeShortcutLink` 명령도 허용합니다.

## URL 처리 앱 조회

`getUrlHandler(url: string, options?: NativeInvokeOptions): Promise<{ name: string; path: string } | null>`은
`openUrl`과 같은 URL 검증 뒤 scheme에 연결된 앱의 표시 이름과 실행 파일 경로를 반환하고, 처리 앱이 없으면
`null`입니다. 앱을 실행하거나 URL을 열지 않습니다. Host operation과 권한은 `opener.getUrlHandler`이며
경로가 노출되므로 `opener.openUrl`과 별개입니다. 화면의 직접 호출에는 `plugin.opener.getUrlHandler`
명령도 허용합니다. Windows는 `AssocQueryStringW(ASSOCF_IS_PROTOCOL)`로 조회하고 연결 없음
이름이나 경로 조회가 실패하거나, 빈 값이거나, 길이 상한(32,768 UTF-16 코드 단위)을 넘거나, 제어 문자를 포함하면
모두 `null`입니다. Electron과 Chromium처럼 실패 코드를 구분하지 않으며, 크기가 조회와 읽기 사이에 바뀌면 한 번
다시 시도합니다. 오류는 입력 검증의 `INVALID_ARGUMENT`와 종료 뒤 호출의 `CANCELLED`뿐입니다. 아이콘은
반환하지 않으며 macOS는 지원하지 않습니다.

## URL scheme 등록

`registerUrlScheme(scheme: string, options?): Promise<null>`, `unregisterUrlScheme(scheme, options?): Promise<boolean>`,
`isUrlSchemeRegistered(scheme, options?): Promise<boolean>`는 실행 중인 앱을 현재 사용자의 사용자 지정 URL scheme
처리 앱으로 등록, 해제하고 조회합니다(Windows만, macOS는 `UNSUPPORTED`). `HKCU\Software\Classes\<scheme>`에
`URL Protocol`과 `shell\open\command`(앱 실행 명령 + `"%1"`)를 쓰고 HKLM과 UserChoice는 건드리지 않습니다.
대상은 호스트가 알려 주는 실행 중인 앱뿐이며 호출자가 경로나 인자를 줄 수 없습니다. `http`, `file`, `javascript`,
`ms-*` 같은 예약 scheme은 `INVALID_ARGUMENT`입니다. 키의 `BunawayRegistration` 값과 명령이 모두 이 앱의 것일 때만
소유로 보고, 이미 있는 이름(HKLM 등록과 시스템 ProgId 포함)은 덮지 않으며 다른 앱의 `HKCU` 키는 지우지 않습니다. 권한은 작업 이름 세 개이며 각각 별개입니다.
링크로 받은 URL은 신뢰할 수 없는 입력이므로 앱이 검증해야 합니다. 자세한 규칙은 reference 문서를 참고하세요.

## 지정 앱

`openFileWith(path: string, app: string, options?: NativeInvokeOptions): Promise<null>`과
`openUrlWith(url: string, app: string, options?: NativeInvokeOptions): Promise<null>`은
절대 `.exe` 앱 경로와 대상 하나를 받습니다. Host operation과 권한은 각각
`opener.openFileWith`, `opener.openUrlWith`입니다. 화면의 직접 호출에는
`plugin.opener.openFileWith`, `plugin.opener.openUrlWith` 명령도 허용합니다.
입력은 각각 `{ path, app }`, `{ url, app }`이고 출력은 `null`입니다.
기존 `openFile`, `openUrl`과 `revealFile` 권한은 이 작업을 허용하지 않습니다.

실행 파일은 존재해야 하며 기존 파일 작업의 절대 경로 검사를 따르고, 링크를 풀어 얻은 경로가 `.exe`로 끝나야 합니다.
`.cmd`, `.bat`, `.lnk`, 셸 명령과 추가 실행 인자는 받지 않습니다. 파일 대상도 같은 검사를
거치고 URL은 HTTP/HTTPS 규칙을 따릅니다. 앱과 파일 대상은 풀린 경로로 요청합니다.
Explorer에 앱 경로와 단일 대상 인자를 별도로 전달하고 대상은 Windows argv 규칙으로
인코딩합니다. 연결 앱이나 기본 브라우저 설정은 변경하지 않습니다.

이 권한은 임의 실행 파일을 선택할 수 있으므로 앱 명령이 허용할 실행 파일과 대상을 정합니다.
실행 파일이 대상을 처리하는 방식은 해당 앱의 계약입니다. 성공은 Explorer의 요청 접수이며
프로세스 실행이나 표시 완료를 보장하지 않습니다. 지정 앱은 앱 종료용 Job을 상속하지 않습니다.
경로 검사, 실패와 취소는 기존 작업과 같은 계약을 사용합니다.

`tests/api/opener-selected-app.test.ts`는 입력, 작업별 권한, 호출 컨텍스트와 오류를 검사합니다.
Windows의 `tests/lifecycle/windows-opener-selected-app.test.ts`는 실제 파일과 앱 검사,
링크로 가리킨 앱의 확장자 검사를 확인합니다(파일 symlink를 만들 수 있는 러너에서만 실행). `windows-opener-job.test.ts`는 실제
Explorer와 compiled helper로 기존 기본 실행, 지정 앱의 파일과 URL argv, Unicode와 공백,
URL fragment 따옴표, 앱 Job 밖의 실행과 앱 종료 후 생존을 확인합니다.
`mise run host:windows`가 이 네이티브 검사를 실행합니다. Linux에서는 네이티브 검사를 건너뜁니다.

## 최근 문서

Windows에서 `opener.addRecentDocument(path)`는 기존 파일 하나를 사용자의 셸 최근 항목에 추가하고(`SHAddToRecentDocs(SHARD_PATHW)`), `opener.clearRecentDocuments()`는 `SHAddToRecentDocs(NULL)`로 **사용자의 셸 최근 항목 전체**를 지웁니다. 다른 앱과 사용자가 만든 항목도 지워지며 앱 범위로 제한할 수 없으므로 `opener.clearRecentDocuments` 권한은 신중히 허용하세요. 점프 목록 연결은 보장하지 않으며 AppUserModelID 설정 이후의 작업입니다. Host operation은 `opener.addRecentDocument`(입력 `{ path: string }`)와 `opener.clearRecentDocuments`(입력 `{}`)이며 권한 이름은 같고 결과는 `null`입니다. 추가는 다른 파일 작업과 같은 경로 확인을 적용하며, 셸이 이후에 파일을 읽을 때의 교체는 막지 못합니다. Electron과 같이 opener의 I/O STA에서 직접 호출하며(`windows-recent.ts`), 호출 뒤 프로세스에 MTA가 남을 수 있고 opener는 그 상태를 지원합니다. 전용 STA 스레드로 격리해도 셸이 MTA를 남겨서 그 방식은 쓰지 않습니다. 오류는 `INVALID_ARGUMENT`, `PERMISSION_DENIED`, dispose 뒤 호출과 시작 전에 이미 중단된 호출의 `CANCELLED`입니다. 호출은 동기이며 중단할 수 없어 취소와 기한 초과는 전달한 요청을 되돌리지 않습니다. 이 API는 결과를 반환하지 않으므로 성공은 요청 전달을 뜻합니다. 목록 조회는 공식 API가 없고 Recent 폴더의 `.lnk`가 앱별이 아니므로 지원하지 않습니다. macOS는 `UNSUPPORTED`입니다.

## 휴지통

`opener.trashFile(path: string, options?: NativeInvokeOptions): Promise<null>`은 기존 파일을 Windows 휴지통으로 보냅니다. Host operation과 권한은 `opener.trashFile`, 입력은 `{ path: string }`입니다. 화면 직접 호출은 뷰의 `commands`에 `plugin.opener.trashFile`도 허용합니다. 성공한 `null`은 OS가 휴지통의 새 항목을 반환했다는 뜻입니다. 복원 API는 제공하지 않습니다.

기존 파일 경로를 확인하되 링크는 풀지 않고 링크 자체를 휴지통으로 보내며, 로컬 고정 드라이브만 지원합니다. UNC 공유와 이동식 드라이브는 `UNSUPPORTED`입니다. I/O STA의 `IFileOperation`으로 파일 하나만 처리하고 HTML 파일의 연결된 `_files` 폴더는 삭제하지 않습니다. `FOFX_RECYCLEONDELETE`로 휴지통 이동을 요청하고 삭제 직전 콜백에 휴지통 플래그가 없으면 거부합니다. 프레임워크는 이동 실패를 일반 삭제로 재시도하지 않습니다. OS 오류, 중단 또는 휴지통 항목을 확인할 수 없는 결과는 실패로 반환합니다. 시스템의 영구 삭제 경고도 유지하므로 OS 설정에 따라 대화 상자가 표시될 수 있습니다. 콜백의 플래그는 가능한 경우 휴지통으로 이동하라는 요청이며 모든 OS 내부 실패 경로의 결과를 사전에 증명하지 않습니다. 휴지통 비활성화, 용량 초과와 경고 UI 동작은 아직 검증하지 않았습니다. 휴지통 항목이 없는 사후 결과를 거부하는 것만으로 이미 발생한 삭제를 복구할 수는 없습니다.

Windows 셸은 경로로 작업하므로 경로를 확인한 뒤 이동 요청 전에 다른 프로세스가 파일을 교체하는 경쟁은 막지 않습니다. 앱의 파일별 승인 검사는 이 API가 파일에 원자적으로 적용된다고 가정하면 안 됩니다. 성공한 휴지통 이동도 취소나 기한 초과로 되돌리지 않습니다.

## 오류

- `INVALID_ARGUMENT`: URL이나 파일 경로가 유효하지 않거나 파일이 없습니다. 파일 소실은 `details.reason`이 `FILE_NOT_FOUND`입니다.
- `PERMISSION_DENIED`: 작업 권한이 없거나 파일 접근이 거부되었거나 공유 잠금과 충돌했거나 링크가 순환해 풀 수 없습니다.
- `UNSUPPORTED`: 현재 플랫폼이나 실행 환경에 Windows 어댑터가 없습니다.
- `INTERNAL`: 파일 검사, Explorer의 OS 요청 또는 Shell의 바로가기 쓰기에 실패했습니다.
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

`tests/cli/opener.test.ts`는 로컬 `.tgz`를 독립 프로젝트에 설치하고 카탈로그, 작업 권한과 브라우저 번들을 검증하고 UI Worker에서 어댑터가 초기화되지 않는지 확인합니다. 아래 opt-in 검사는 설치한 플러그인을 compiled EXE로 실행하고, 한글과 공백이 있는 실행 파일이 기본 동작으로 시작되는지와 실제 Explorer 선택을 확인합니다. 사용자 파일 연결을 바꾸지 않고 해당 테스트 폴더의 Explorer 창을 정리합니다. 데스크톱이 있는 Windows에서 실행해야 합니다. 일반 문서에 연결된 편집기의 표시나 읽기 완료 검증과 구분합니다.

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

# @bunaway/plugin-clipboard

Windows 텍스트 클립보드를 제공하는 선택 패키지다. 설치 후 `clipboardPlugin`을 앱의 `plugins`에 등록하고 호출 출처에 작업별 권한을 허용한다. 화면과 백엔드 모두 같은 `clipboard`를 사용한다.

```ts
import { clipboard, clipboardPlugin } from "@bunaway/plugin-clipboard";

// 앱 정의의 plugins: [clipboardPlugin]
await clipboard.writeText({ text: "한글 😀" });
const text = await clipboard.readText(null);
await clipboard.clear(null);
```

공개 입력, 반환값, 권한, 오류와 취소 규칙은 [API 레퍼런스](../../docs/site/src/content/docs/reference/plugins/clipboard.mdx)에 둔다. Windows 이외의 어댑터, 이미지, HTML, RTF, 변경 이벤트는 제공하지 않는다.

## Windows 소유권과 수명

`plugin.json`의 UI 실행 경로를 사용한다. 공통 SDK가 입력과 결과를 검사하고 Windows UI 호스트와 어댑터가 권한을 검사한다. UI STA에서 숨은 `STATIC` 창과 DLL 바인딩을 만들며, 선언을 import하는 것만으로 네이티브 자원을 만들지 않는다.

`OpenClipboard`에는 해당 창을 전달한다. 점유 재시도 사이에는 메모리와 클립보드 핸들을 보유하지 않는다. 성공한 열기마다 `finally`에서 `CloseClipboard`를 호출한다. 읽기는 `CF_UNICODETEXT`의 빌린 `HGLOBAL`을 `GlobalSize`로 제한하고 `GlobalLock` 이후 NUL 종료를 확인한다. 잠금은 항상 해제하며 문자열을 복사한 뒤에만 클립보드를 닫는다. 빌린 핸들은 해제하지 않는다.

쓰기는 `GMEM_MOVEABLE` 메모리에 UTF-16LE와 종료 NUL을 준비한 다음 `EmptyClipboard`와 `SetClipboardData`를 호출한다. 등록 전에 실패하면 플러그인이 `GlobalFree`로 해제한다. 등록에 성공하면 Windows가 소유하므로 플러그인은 다시 쓰거나 해제하지 않는다. 앱 종료 뒤에도 등록한 텍스트는 유지된다. 비우기 이후 등록 실패는 이전 데이터를 복원하지 않는다.

어댑터 종료는 재시도를 취소하고 진행 중 작업의 정리를 기다린 다음 소유자 창과 DLL을 해제한다. 반복 종료는 안전하다. 취소와 기한은 동기 OS 호출의 실행을 중단하거나 이미 완료한 변경을 되돌리지 않는다.

Microsoft의 [SetClipboardData 소유권 규칙](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setclipboarddata)과 [클립보드 메모리 규칙](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-operations)을 따른다.

## 검증

```powershell
mise exec -- bun test tests/api/clipboard.test.ts tests/lifecycle/clipboard-resources.test.ts
$env:BUNAWAY_CLIPBOARD_NATIVE = "1"
mise exec -- bun test tests/lifecycle/windows-clipboard.test.ts
Remove-Item Env:BUNAWAY_CLIPBOARD_NATIVE
```

일반 검사는 실제 데스크톱 클립보드를 바꾸지 않는다. Win32 바인딩만 격리한 별도 프로세스에서 메모리 실패, UTF-16 경계, 소유권 이전, 점유 재시도, 취소와 종료를 검사한다. 실제 검사는 명시적으로 활성화한다. 공통 SDK, 실제 UI Worker와 Win32를 연결해 한글, 이모지, 빈 텍스트, 최대 길이, 비텍스트 형식, 지우기, 별도 프로세스의 점유와 취소를 검사한다. WebView2 페이지를 사용하는 검사는 아니다.

실제 검사는 데스크톱 클립보드를 변경한다. 이전 Unicode 텍스트를 마지막에 복원하지만 이미지 등 다른 형식은 복원하지 않는다. 검증 중 다른 앱의 복사 작업과 경쟁할 수 있다.

2026-10-10 로컬 Windows x64, Bun 1.4.2에서 실제 SDK/UI Worker 왕복 검사가 통과했다. 최소 Windows 버전과 다른 플랫폼은 검증하지 않았다.

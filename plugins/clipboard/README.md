# @bunaway/plugin-clipboard

`src/index.ts`는 계약과 플랫폼 선언을 조립하고 공개 API를 export한다.
`src/contract.ts`는 작업 스키마와 네이티브 호출 검증을 소유하며 텍스트 제한은 `src/text.ts`에서 공유한다.
플랫폼 구현은 계약을 직접 읽으며 공개 진입점을 역으로 import하지 않는다.

Windows와 macOS의 텍스트, HTML, RTF와 RGBA 이미지 클립보드를 제공하는 선택 패키지다. 파일 목록은 Windows에서만 제공한다. 설치 후 `clipboardPlugin`을 앱의 `plugins`에 등록하고 호출 출처에 작업별 권한을 허용한다. 화면과 백엔드 모두 같은 `clipboard`를 사용한다.

```ts
import { clipboard, clipboardPlugin } from "@bunaway/plugin-clipboard";

// 앱 정의의 plugins: [clipboardPlugin]
await clipboard.writeText({ text: "한글 😀" });
const text = await clipboard.readText(null);
await clipboard.clear(null);
```

공개 입력, 반환값, 권한, 오류와 취소 규칙은 [API 레퍼런스](../../docs/site/src/content/docs/reference/plugins/clipboard.mdx)에 둔다. bookmark, 임의 binary 형식과 변경 이벤트는 제공하지 않는다.

`readImage`와 `writeImage`는 크기와 base64 RGBA 픽셀을 전달한다. `readFormats`와 `writeFormats`는 지원 형식을 한 번의 열기 구간에서 읽거나 교체하며 `getFormats`와 `hasFormat`은 지원 형식의 가용성을 조회한다. 발견 결과에는 Windows가 변환해 제공할 수 있는 형식도 포함된다. 네이티브 이미지 ID나 별도 이미지 저장소는 만들지 않는다.

## Windows 소유권과 수명

`src/index.ts`의 platforms 선언에 UI 실행과 `src/platforms/windows.ts`에서 import한 팩터리를 지정한다. 공통 SDK가 입력과 결과를 검사하고 Windows UI 호스트와 어댑터가 권한을 검사한다. UI STA에서 숨은 `STATIC` 창과 DLL 바인딩을 만들며, 선언을 import하는 것만으로 네이티브 자원을 만들지 않는다. `bun run plugins:build`는 OS 구현을 제외한 공개 출력과 Windows 호스트 출력을 만든다.

`OpenClipboard`에는 해당 창을 전달한다. 점유 재시도 사이에는 메모리와 클립보드 핸들을 보유하지 않는다. 성공한 열기마다 `finally`에서 `CloseClipboard`를 호출한다. 읽기는 `CF_UNICODETEXT`의 빌린 `HGLOBAL`을 `GlobalSize`로 제한하고 `GlobalLock` 이후 NUL 종료를 확인한다. 잠금은 항상 해제하며 문자열을 복사한 뒤에만 클립보드를 닫는다. 빌린 핸들은 해제하지 않는다.

쓰기는 모든 형식의 `GMEM_MOVEABLE` 메모리를 준비한 다음 `EmptyClipboard`를 한 번 호출하고 `SetClipboardData`로 각각 등록한다. 준비 중 실패하면 기존 내용은 유지하고 준비된 모든 핸들을 `GlobalFree`로 해제한다. 등록에 성공한 핸들은 Windows가 소유하므로 플러그인은 다시 쓰거나 해제하지 않는다. 비우기 이후 일부 등록이 실패하면 이미 등록한 형식은 남고 나머지 핸들만 해제한다. 이전 데이터를 복원하거나 변경을 원자적으로 되돌리지 않는다. 등록한 데이터는 앱 종료 뒤에도 Windows가 소유한다.

이미지는 top-down sRGB `CF_DIBV5`에 BGRA 채널과 명시적인 alpha mask를 기록한다. 읽기는 `CF_DIBV5`를 우선하고 없으면 `CF_DIB`를 사용한다. 지원하는 24/32-bit DIB만 RGBA로 변환하며 compression, channel mask, row stride, 크기와 profile 경계를 검사한다. HTML은 `HTML Format`의 UTF-8 byte offset으로 fragment를 읽고 쓰며 RTF는 `Rich Text Format`의 ASCII byte stream을 사용한다. 파일 목록은 wide `CF_HDROP`의 `DROPFILES`와 이중 NUL 종료를 검사한다. 파일 목록을 복사하거나 읽는 작업은 파일을 열거나 저장소 권한을 추가하지 않는다.

어댑터 종료는 재시도를 취소하고 진행 중 작업의 정리를 기다린 다음 소유자 창과 DLL을 해제한다. 반복 종료는 안전하다. 취소와 기한은 동기 OS 호출의 실행을 중단하거나 이미 완료한 변경을 되돌리지 않는다.

Microsoft의 [SetClipboardData 소유권 규칙](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setclipboarddata), [클립보드 메모리 규칙](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-operations), [HTML 형식](https://learn.microsoft.com/en-us/windows/win32/dataxchg/html-clipboard-format)과 [BITMAPV5HEADER](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapv5header)를 따른다.

## 검증

`macos-clipboard-native.test.ts`는 고유 이름의 NSPasteboard로 fixture를 격리한다.
`macos-clipboard-webview.ts`는 실제 compiled host, WKWebView와 공개 SDK로 backend
setup, 호출 출처 권한, Unicode, 다중 형식과 RGBA를 검사한다. 일반 클립보드를 변경하므로
`BUNAWAY_CLIPBOARD_NATIVE=1`로 명시한 CI 데스크톱에서만 실행하고 종료 시 fixture
내용을 지운다. 결과는 `build/macos-clipboard-results.json`에 기록한다. macOS arm64 CI
통과 전에는 구현 범위를 검증 완료로 판단하지 않는다.

macOS 바인딩은 `src/macos-pasteboard.ts`, bounded TIFF codec은 `src/macos-tiff.ts`가
소유한다. 작업마다 autorelease pool을 해제하고 `NSData`는 길이 검사 뒤 복사한다.
Objective-C 객체는 tagged pointer까지 보존하는 64-bit 정수로 전달한다. 쓰기는 모든
형식을 하나의 `NSPasteboardItem`에 준비한 다음 교체하며 종료는 바인딩을 닫는다.
일반 클립보드의 내용은 앱 종료 뒤에도 남는다. TIFF 지원 범위와 파일 목록 거부는
API 레퍼런스의 macOS 형식과 제한을 따른다.

```sh
BUNAWAY_CLIPBOARD_NATIVE=1 mise exec -- bun --no-env-file test tests/lifecycle/macos-clipboard-native.test.ts
BUNAWAY_CLIPBOARD_NATIVE=1 mise exec -- bun --no-env-file tests/lifecycle/macos-clipboard-webview.ts
```

```powershell
mise exec -- bun test tests/api/clipboard.test.ts tests/lifecycle/clipboard-resources.test.ts
mise exec -- bun test tests/api/clipboard-formats.test.ts tests/lifecycle/clipboard-codecs.test.ts
$env:BUNAWAY_CLIPBOARD_NATIVE = "1"
mise exec -- bun test tests/lifecycle/windows-clipboard.test.ts
Remove-Item Env:BUNAWAY_CLIPBOARD_NATIVE
```

일반 검사는 실제 데스크톱 클립보드를 바꾸지 않는다. Win32 바인딩만 격리한 별도 프로세스에서 메모리 실패, UTF-16 경계, 다중 형식의 준비 실패와 부분 등록, 소유권 이전, 점유 재시도, 취소와 종료를 검사한다. 별도 codec 검사는 외부 DIB의 행 방향, padding과 alpha, 잘못된 mask, profile과 크기, CF_HTML의 Unicode byte offset과 UTF-8 오류, 잘못된 파일 목록을 검사한다.

실제 검사는 명시적으로 활성화하며 CI의 `mise run host:windows`에도 포함된다. 공통 SDK, 실제 UI Worker와 Win32를 연결해 한글, 이모지, 빈 텍스트, 최대 길이, 이미지 alpha, 다중 형식 왕복과 발견, 비텍스트 형식, 지우기, 별도 프로세스의 점유와 취소를 검사한다. WebView2 페이지, Explorer나 다른 앱에서의 붙여넣기 검증은 포함하지 않는다.

실제 검사는 데스크톱 클립보드를 변경한다. 이전 Unicode 텍스트를 마지막에 복원하지만 이미지 등 다른 형식은 복원하지 않는다. 검증 중 다른 앱의 복사 작업과 경쟁할 수 있다.

2026-10-10 로컬 Windows x64, Bun 1.4.2에서 기존 텍스트 SDK/UI Worker 왕복 검사가 통과했다. 새 형식의 실제 Windows 결과는 해당 PR의 정확한 head CI를 확인한다. 최소 Windows 버전과 다른 플랫폼, 다른 앱의 붙여넣기는 별도 검증이 필요하다.

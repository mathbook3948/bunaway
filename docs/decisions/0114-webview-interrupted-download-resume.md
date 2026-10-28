---
status: accepted
---

# WebView 중단 다운로드의 metadata 저장과 재시작 뒤 재개를 제공하지 않는다

결정일: 2026-10-28. 검토 기준: main `c5df26d4`, WebView2 SDK 1.0.4129.50.

## 배경

앱이 끊긴 WebView 다운로드의 URL, 부분 파일 경로, 받은 바이트, ETag, 마지막 수정 시각을 저장해 두었다가 앱을 다시 띄운 뒤
이어 받는 기능을 제공할지 정해야 했다. 지금은 같은 WebView 수명 안에서만 `windows.resumeDownload`로 재개하며(`getDownloads`의
`canResume`가 참일 때), 앱을 다시 띄우거나 창이 닫히면 다운로드 id가 사라진다.

- 아래 Electron, Tauri 서술은 공개 문서에 따른 것이며 기준 버전을 확인하지 않았고 이 저장소의 테스트로 검증하지 않았다.
  WebView2는 호스트가 고정한 SDK 1.0.4129.50의 `ICoreWebView2DownloadOperation` 기준이다(`native/windows/bun/README.md`).
- Electron은 `session.createInterruptedDownload({ path, urlChain, mimeType, offset, length, lastModified, eTag, startTime })`로
  앱이 저장해 둔 metadata에서 다운로드를 되살리게 한다. 이어 받기를 Chromium 다운로드 관리자가 `Range` 요청으로 처리한다는 것은
  추론이다.
- Tauri(wry)는 다운로드 시작 핸들러와 완료 핸들러만 있고 중단 다운로드를 되살리는 API가 없는 것으로 알고 있다.
- WebView2의 `ICoreWebView2DownloadOperation`은 같은 프로세스 안에서 `Pause`, `Resume`, `CanResume`, `InterruptReason`을
  제공한다. 공개 문서에서 metadata만으로 중단 다운로드를 새로 만드는 API는 찾지 못했다. 이 서술은 공개 문서에 따른 것이며
  이 저장소의 테스트로 검증하지 않았다.
- 이 저장소의 Windows 호스트(`native/windows/bun/webview-downloads.ts`)는 `DownloadStarting`을 가로채 승인 여부만 정하고,
  `DownloadOperation`의 pause, resume, cancel과 상태 조회를 노출한다. 저장 경로를 바꾸는 호출이 없고 파일 쓰기와 기본 저장 경로는
  브라우저가 소유한다(`native/windows/bun/README.md`). 호스트는 부분 파일을 직접 만들거나 지우지 않는다.
- 창이 닫히면 승인된 다운로드는 취소하고 참조를 정리한다. 부분 파일이 그 뒤 WebView2 쪽에서 남는지 지워지는지는 이 결정에서
  확인하지 않았다.
- `network.download`는 백엔드가 파일로 저장하는 별도 경로이며, 일부만 받은 본문을 완전한 파일로 저장하지 않도록 `Range`와
  `If-Range` header를 거부한다.

## 결정

1. 중단 다운로드의 metadata를 저장하는 연산, 그 metadata에서 다운로드를 되살리는 연산, 앱을 다시 띄운 뒤 이어 받는 연산을
   코어와 플러그인의 공개 연산, 이벤트, 설정으로 제공하지 않는다. 현재 범위인 같은 WebView 수명 안의
   `getDownloads`, `pauseDownload`, `resumeDownload`, `cancelDownload`를 그대로 확정한다.
2. 호스트와 계약, 권한은 바꾸지 않는다. 코드와 테스트 변경이 없다.
3. 앱이 쓸 수 있는 대체 경로는 다음과 같다.
   - 같은 WebView 수명 안에서는 `getDownloads`의 `canResume`를 보고 `resumeDownload`를 호출한다.
   - 앱을 다시 띄운 뒤에는 UI가 같은 URL의 다운로드를 다시 일으키고 `windows.approveDownload`로 새 다운로드로 받는다.
     백엔드가 `windows.navigateWebView`로 그 URL을 여는 방법도 있을 수 있으나(대상 뷰의 `origins` 안의 HTTP/HTTPS URL만 가능하고,
     응답이 첨부 파일이면 페이지가 유지되는지를 포함해) 이 흐름은 테스트로 확인하지 않았다.
     WebView 세션의 쿠키가 필요한 다운로드는 쿠키 API를 제공하지 않으므로([ADR 0076](./0076-webview-cookies.md))
     백엔드가 재현할 수 없다. 그래서 이 경로가 이런 다운로드를 받는 유일한 방법이라고 추정하지만 테스트로 확인하지 않았다.
   - WebView 세션의 쿠키가 필요 없는 파일은 백엔드가 `network.download`로 받을 수 있다. 앱이 `headers`로 `Authorization` 같은
     header를 직접 지정할 수 있다. 이 연산은 이어 받기를 제공하지 않고 처음부터 다시 받는다.
4. 호스트는 재시작 뒤 남은 부분 파일을 찾아 지우지 않는다. 호스트가 부분 파일을 직접 만들거나 지우지 않고 저장 경로도 앱이
   지정할 수 없으므로, 남는 임시 파일이 있는지, 있다면 위치와 수명이 어떤지는 이 결정에서 확인하지 않았다. 확인 결과 앱이
   정리해야 하는 파일이 있다면 후속 항목으로 다룬다.
5. 나중에 제공한다면 먼저 다음이 필요하다: 중단 다운로드를 metadata로 되살리는 WebView2 API 또는 백엔드가 `Range` 요청으로
   이어 받는 별도 다운로더, 서버 `Range` 지원 확인, 부분 파일을 신뢰하는 조건과 무결성 재확인, 덮어쓰기 규칙, 인증 상태를
   백엔드가 재현할 수 있는지 여부.
6. 이 결정은 redirect chain과 frame별 initiator 조회를 다루지 않는다.

## 근거

- Electron에는 이 API가 있고 Tauri에는 없는 것으로 알고 있으며 WebView2에서는 대응 API를 찾지 못했다. Electron의 계약은 Chromium 다운로드 관리자에
  기대는 것으로 보이므로 WebView2 위에서 같은 계약을 지킬 수 있는지 확인되지 않았다고 본다. Electron과 Tauri가 다르면 코어는 작게 두는 쪽을 택하므로
  코어에 넣지 않는다.
- 제공하려면 백엔드가 `Range` 요청으로 이어 받는 다운로더를 새로 만들어야 한다. 그 일은 `network.download`의 영역인데, 이 연산은
  부분 본문을 완전한 파일로 오인하지 않도록 `Range`를 거부한다. WebView 세션의 쿠키는 쿠키 API가 없어 백엔드가 재현할 수 없다.
- 이어 받기를 약속하면 서버 `Range` 지원, 부분 파일 신뢰, 무결성 재확인, 덮어쓰기 규칙을 코어가 정해야 한다. 이 기능을 요구하는 곳은 이 TODO 항목뿐이므로 이 비용을 코어에 넣지 않는다.
- 호스트는 부분 파일을 소유하지 않으므로 재시작 뒤 정리 책임을 호스트에 새로 만들지 않는다.

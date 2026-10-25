---
status: accepted
---

# WebView user agent, accept languages, proxy, incognito 옵션을 제공하지 않는다

결정일: 2026-10-25. 검토 기준: main `bb18c2f8`.

## 배경

아래 Electron과 Tauri 서술은 해당 프로젝트의 공개 문서와 소스 확인에 따른 것이며 이 저장소의 테스트로 검증한 것은 아니다.

앱이 WebView의 user agent, Accept-Language, proxy, 시크릿(incognito) 모드를 설정하는 옵션을 제공할지 정해야 했다.

- Electron은 `webContents.setUserAgent`, `loadURL`의 `userAgent` 옵션, `session.setUserAgent(userAgent, acceptLanguages)`,
  `session.setProxy`와 `--proxy-server`, `--lang` 스위치를 제공하고, 영속하지 않는 `partition`으로 임시 세션을 만든다.
- Tauri 2는 `WebviewWindowBuilder`에 `user_agent`, `proxy_url`, `incognito`를 두고 Windows에서는 WebView2 설정과
  브라우저 인자(`--proxy-server`)로 구현한다. Accept-Language 전용 옵션은 없다.
- WebView2는 `ICoreWebView2Settings::UserAgent`, 환경 옵션의 `Language`, 컨트롤러 옵션의 `IsInPrivateModeEnabled`,
  브라우저 인자 `--proxy-server`로 대응할 수 있다.
- 이 저장소의 호스트는 WebView2 환경을 만들 때 브라우저 인자와 환경 옵션을 넘기지 않으며 Chromium 스위치 API도
  제공하지 않기로 했다([ADR 0030](./0030-launch-arguments-and-environment.md) 결정 4). proxy 옵션은 이 결정을
  뒤집어야 구현할 수 있다.
- 각 선언 뷰는 앱 데이터 아래의 영속 프로필을 쓰고 재생성도 같은 프로필을 재사용한다([ADR 0016](./0016-window-creation-contract.md)).
  시크릿 모드는 이 프로필 모델과 쓰기 경로를 따로 정해야 하며, 프로필 디렉터리 선택과 삭제 항목과 함께 다뤄야 한다.
- 앱 백엔드의 HTTP 요청은 `network.request`가 헤더(`User-Agent`, `Accept-Language` 포함)를 요청마다 지정하고,
  `network.resolveProxy`가 Windows 시스템 proxy 설정을 조회한다. WebView 안의 페이지 요청은 WebView2 기본값대로
  OS 사용자 언어와 시스템 proxy를 따른다.

## 결정

1. WebView user agent, Accept-Language, proxy, 시크릿 모드 옵션과 API를 추가하지 않는다.
2. 앱 백엔드가 보내는 요청의 user agent와 언어는 `network.request`의 헤더로 지정한다. WebView 페이지의 요청은
   WebView2 기본 동작(OS 언어, 시스템 proxy)을 따른다.
3. proxy는 호스트가 브라우저 인자를 넘기지 않는 방침(ADR 0030 결정 4)을 유지하므로 제공하지 않는다.
4. 시크릿 모드는 프로필 디렉터리와 데이터 저장소 선택 항목이 정해질 때 그 결정에 포함해 다시 다룬다.
5. 쓰는 곳이 확인되면 별도 결정에서 다시 다룬다. 그때 user agent와 언어는 환경 옵션이 아니라 WebView2 설정으로
   대응하는 방안부터 검토한다.

## 근거

- 두 프레임워크 모두 제공한다. 그러나 이 저장소에서 쓰는 곳이 없고, 4개 중 proxy와 시크릿 모드는 기존 결정(브라우저
  인자 비전달, 뷰별 영속 프로필)과 부딪혀 코어 계약을 넓혀야 한다. 코어는 작게 두는 쪽을 따른다.
- user agent와 언어는 WebView 안의 페이지 동작을 앱 소유 값으로 바꾸는 옵션이라 서버 쪽 UA 분기와 맞물려 호환 문제를
  앱에 넘긴다. 앱 백엔드 요청은 이미 헤더로 지정할 수 있어 대체 수단이 있다.

## 결과

- 이벤트, 권한, 스키마, 네이티브 코드 변경은 없다.
- `docs/TODO-windows.md`의 해당 항목을 완료로 표시하고 이 결정을 참조한다.

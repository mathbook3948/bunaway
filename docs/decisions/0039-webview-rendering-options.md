---
status: accepted
---

# WebView 글꼴, encoding, 이미지 animation, textarea resize, preferred-size, focus-on-navigation 옵션은 제공하지 않는다

결정일: 2026-10-25.

## 배경

앱 정의에 WebView의 렌더링 설정 옵션을 둘지 정해야 했다. 대상은 기본 글꼴과 글꼴 크기, 문서 encoding,
이미지 animation 정책, textarea 크기 조절, preferred-size(콘텐츠 크기) 통지, 탐색 시 포커스 이동이다.
아래 외부 동작은 Electron v45.0.0, Tauri 2.12.5(wry 0.57.0), WebView2 SDK 1.0.4314.35 기준으로 확인한 것이며
이 저장소의 테스트로 실행한 것은 아니다.

Electron:

- `webPreferences`에 `defaultFontFamily`(standard, serif, sansSerif, monospace, cursive, fantasy, math),
  `defaultFontSize`(16), `defaultMonospaceFontSize`(13), `minimumFontSize`(0), `defaultEncoding`(ISO-8859-1),
  `textAreasAreResizable`(true), `focusOnNavigation`(true, 메인 프레임이고 BrowserWindow일 때만),
  `enablePreferredSizeMode`(false)가 있다. 대부분 Blink 설정으로 그대로 전달되며 플랫폼 분기가 없다.
- `enablePreferredSizeMode`를 켜면 로드 뒤 콘텐츠 크기가 바뀔 때 `preferred-size-changed`가 발생한다.
- 이미지 animation은 `webPreferences.imageAnimationPolicy` 또는 `webContents.setImageAnimationPolicy`로
  `animate`(기본), `animateOnce`, `noAnimation`을 고른다. 새로 불러오는 이미지에만 적용된다.

Tauri 2와 wry:

- 글꼴, encoding, textarea 크기 조절, 이미지 animation, preferred size에 해당하는 API가 없다.
- `focused`는 생성 시 포커스 여부만 정하며 macOS, Android, iOS에서는 지원하지 않는다.
- 네이티브 접근(`with_webview`)으로 Linux WebKitGTK `Settings`에서는 기본 글꼴, 최소 글꼴 크기, 기본 charset,
  textarea 크기 조절을 바꿀 수 있다. macOS `WKPreferences`는 `minimumFontSize`만 있고 Windows에는 없다.

WebView2:

- `ICoreWebView2Settings`부터 `Settings9`, `ICoreWebView2Controller`부터 `Controller4`, `ICoreWebView2_27`부터
  `_29`에서 글꼴, encoding, 이미지 animation, preferred size 통지에 해당하는 멤버를 찾지 못했다. `ICoreWebView2_2`부터
  `_26`까지는 전부 대조하지 않았다.
- 전용 설정이 없으면 호스트가 같은 효과를 내기 위해 검토한 경로는 문서에 CSS나 스크립트를 주입하는 것뿐이다. 호스트는 환경 생성 시 브라우저
  인자를 넘기지 않는다([ADR 0030](./0030-launch-arguments-and-environment.md)). 환경 변수로 앱 환경에서 브라우저 인자를 넘기는 경로는 열려 있지만 글꼴이나 encoding을 바꾼다는 근거를 찾지 못했다. DevTools
  프로토콜 호출 같은 다른 경로는 검토하지 않았다.

## 결정

1. 이 옵션들을 앱 정의, 창 플러그인 계약, 이벤트로 추가하지 않는다.
2. 비슷한 효과가 필요한 앱은 웹 표준으로 처리한다. 아래 방법은 근사이며 Electron 옵션과 의미가 같지 않다. 탐색 뒤 포커스는 대체 수단이 없다.

| 목적 | 앱이 쓰는 방법 |
| --- | --- |
| 기본 글꼴, 글꼴 크기 | 문서 CSS의 `font-family`와 `font-size`. 작성자 CSS보다 우선하는 `minimumFontSize`에 해당하는 설정은 없다 |
| textarea 크기 조절 | CSS `resize` |
| 문서 encoding | 응답의 `Content-Type` charset 또는 `<meta charset>` |
| 이미지 animation 중지 | 이미지 형식 선택, 또는 스크립트로 정지 이미지 표시 |
| 콘텐츠 크기 변화 통지 | `ResizeObserver`로 관찰해 앱 IPC로 전달한다. 어느 요소를 관찰하느냐와 문서 CSS에 따라 얻는 크기가 달라진다 |
| 탐색 뒤 포커스 | 없음. 문서 안 `element.focus()`는 요소만 고르며 키보드 포커스를 WebView로 옮기는 것은 보증하지 않는다 |

3. Electron의 `preferred-size-changed`에 해당하는 이벤트도 제공하지 않는다. TODO의 "title, favicon과
   preferred-size 변경 이벤트" 항목 중 preferred-size 부분은 이 결정으로 닫고, title과 favicon 이벤트는 그 항목에서
   별도로 다룬다.

## 근거

- Electron은 이 옵션들을 제공하므로 이 결정은 Electron과 다르다. Tauri는 글꼴, encoding, textarea 크기 조절, 이미지 animation, preferred size 옵션을 Windows에서 제공하지 않는다.
- WebView2에서 대응하는 네이티브 설정을 찾지 못했다. 옵션을 두면 호스트가 문서에 CSS나 스크립트를
  주입해 흉내 내야 한다. 주입은 탐색, 프레임, 사용자 스타일과 겹쳐 결과가 Electron의 Blink 설정과 달라지고(예: encoding은
  이미 파싱된 문서에는 적용되지 않는다) 같은 이름의 옵션이 다른 의미를 갖게 된다.
- 글꼴, textarea, encoding, 크기 관찰은 웹 표준으로 근사할 수 있고 이미지 animation은 형식 선택이나 스크립트 정지로 근사한다. 근사로 충분하다고 판단했으며 호스트가 대신하면 앱 정의 설정이 늘고
  코어가 커지는 데 비해 얻는 것이 없다.
- 2026-10-25 기준 `gh issue list`의 열린 이슈 목록과 저장소 검색(docs, plugins, native)에 이 옵션을 쓰거나 요구하는 곳이 없다.
- 탐색 뒤 포커스는 Electron의 `focusOnNavigation`처럼 탐색마다 자동으로 옮기는 동작을 제공하지 않으며 같은 효과의
  대체 수단도 정하지 않았다. 호스트의 로드 완료와 탐색 이벤트 항목과 WebView 키보드 포커스 제어가 생기면 다시 다룬다.
- 이 결정은 Windows 기준이다. macOS WKWebView의 `minimumFontSize` 같은 플랫폼 설정을 나중에 추가하더라도
  플랫폼별로 다른 의미의 옵션이 되지 않도록 별도 결정으로 다룬다.

## 열린 질문

실제 앱 요구가 확인되면 다음을 먼저 정해야 한다.

- WebView2가 네이티브 설정을 제공하게 되는지, 아니면 주입이나 DevTools 프로토콜로 흉내 낼 때 적용 시점과 탐색 뒤 재적용 규칙.
- preferred-size 통지가 필요하면 `ResizeObserver` 기반 도우미를 플러그인이나 클라이언트 SDK에 두는 방식.

## 결과

- 코드, 스키마, 권한, 이벤트 변경은 없다.
- `docs/TODO-windows.md`의 글꼴, encoding, 이미지 animation 항목과 textarea, preferred-size, focus-on-navigation 항목을 결정 완료로 바꾸고, title과 favicon 이벤트 항목에서 preferred-size를 제외하며 이 ADR을 가리킨다.
- Windows 창 문서에 해당 옵션이 없다는 사실과 대체 방법을 적는다.

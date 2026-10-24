---
status: accepted
---

# 실행 인자는 앱 인자만 전달하고 환경 변수와 Chromium command-line switch를 다루는 API를 두지 않는다

결정일: 2026-10-25

Electron은 `app.commandLine`의 `appendSwitch`, `appendArgument`, `hasSwitch`, `getSwitchValue`,
`removeSwitch`로 Chromium command-line switch와 인자를 앱 코드에서 바꾸고 조회한다. 이 값은
`process.argv`를 바꾸지 않으며, Electron 문서는 `ready` 전에 메인 스크립트에서 호출하라고 안내한다.
이와 같은 설정 API, 환경 변수 선언, 개발 옵션과 배포 옵션의 적용 범위를 정한다.
이 결정은 Windows 호스트 기준이다. macOS 호스트는 앱 실행 인자를 받지 않는다.

## 결정

1. 앱 인자는 `OpenRequest`(`argv`와 이를 해석한 `files`, `urls`)로 전달한다. 앱 정의에 실행 인자를 선언하거나 바꾸는 필드를 두지 않는다.
2. 개발 옵션 `--devtools`와 `--dev-url <url>`은 컴파일하지 않은 개발 실행에서만 떼어낸다. 각 옵션은 그
   시점의 맨 앞 인자일 때만 떼어내며 순서는 `--devtools`, `--dev-url`이다(`--dev-url <url> --devtools`
   순서면 `--devtools`가 `argv`에 남는다).
   컴파일한 배포 앱은 두 문자열을 해석하지 않고 다른 인자와 같이 `argv`에 그대로 전달한다.
3. 환경 변수를 선언하거나 설정하는 앱 정의 필드와 API를 두지 않는다. 앱 코드는 Bun의 `process.env`를
   직접 읽는다. 호스트를 직접 실행한 Windows 앱의 `relaunch()`는 새 프로세스에 시작 시점의 환경을 주며
   이후 앱이 바꾼 값은 전달하지 않는다. `bunaway dev`에서는 CLI가 새 프로세스를 시작하며, 개발 실행의
   호스트에는 CLI가 고른 시스템 변수 일부만 전달하고 `PATH`는 System32로 바꿔 넣으며 사용자 셸의 나머지
   변수는 전달하지 않는다.
4. Chromium command-line switch와 인자의 추가, 조회, 존재 확인, 제거 API를 두지 않는다. 호스트는
   WebView2 환경을 만들 때 브라우저 인자를 넘기지 않는다. WebView2는 환경을 만들 때 호스트 프로세스의
   환경 변수 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`, `WEBVIEW2_USER_DATA_FOLDER`,
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, `WEBVIEW2_CHANNEL_SEARCH_KIND`, `WEBVIEW2_RELEASE_CHANNELS`를
   읽는다. 실행 파일 폴더와 사용자 데이터 폴더는 환경 변수가 호출 인자를 대체하고, 추가 브라우저 인자는
   호출 인자 뒤에 덧붙는다. 호스트는 배포 앱의 프로세스 환경 변수를 걸러내지 않으며 이 값들의 효과를
   검증하지 않는다. 따라서 `WEBVIEW2_USER_DATA_FOLDER`는 호스트가 넘기는 프로필 폴더를 대체할 수 있고,
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`는 배포 앱에서 그대로 유효하다. `bunaway dev`의 호스트는 결정 3처럼
   시스템 변수 일부만 전달하므로 이 변수들을 받지 않아 개발 실행과 배포 앱이 다르게 동작한다. 이 경로의 제한은
   이 결정의 범위 밖이다.

## 근거

- Electron은 `app.commandLine`으로 앱 코드가 브라우저 프로세스의 switch를 바꾸게 한다. 렌더러에는 모든
  switch가 전달되지 않고 Chromium과 Electron이 정한 허용 목록의 switch만 전달된다. Tauri v2에는 앱 전역
  switch API가 없고, Windows에서만 창(웹뷰) 단위의 `additional_browser_args`(설정 `additionalBrowserArgs`)로
  WebView2 브라우저 인자를 준다. 인자를 지정하면 wry의 기본 `--disable-features` 값을 대체하고, 인자가 다른
  웹뷰는 데이터 디렉터리도 달라야 한다. 이 호스트는 둘 다 따르지 않고 앱 정의에 실행 인자, 환경 변수,
  switch 필드를 두지 않아 코어를 작게 둔다. 앱 인자는 `OpenRequest.argv`로 앱이 직접 읽는다.
- switch 값은 WebView 경계(origin 정책, 권한, 탐색 제한)와 같은 보안 설정을 바꿀 수 있고, 이 경계는 호스트가
  정한다. 앱 코드가 런타임에 이를 바꾸는 API는 계약과 맞지 않는다. 배포 앱의 프로세스 환경 변수를 통한
  경로는 막지 않으며, 그 처리는 필요해질 때 별도로 결정한다. 호스트는 항상 같은 프로필과 옵션을 넘기므로
  같은 사용자 데이터 폴더의 옵션 불일치(WebView2의 `ERROR_INVALID_STATE`)는 환경 변수를 따로 지정했을 때만
  생기며, 호스트는 환경 생성 실패를 오류로 보고한다(오류 문자열은 이 저장소에서 검증하지 않았다).
- WebView2 환경은 프로필마다 하나이며 그 프로필의 첫 창을 만들 때 만들고, 프로필의 창이 모두 닫히면 사라진다.
  앱의 `onReady` 이후에 지정한 값은 이미 만든 환경에 적용되지 않으므로 선언 방식이 필요하면 호스트가
  첫 창을 만들기 전에 읽어야 하며, 이는 앱 정의 필드를 새로 만들어야 하는 별도 결정이다. 현재 이 값을 쓰는
  곳이 없다.
- 컴파일한 앱이 `--devtools`, `--dev-url`을 떼어내지 않는 것은 개발 도구가 배포 앱에서 켜지지 않는
  기존 동작이다([개발 실행 helper](../site/src/content/docs/reference/tooling/core-and-runtime.mdx)).
  배포 앱의 `argv`에서 이 문자열이 사라지면 앱이 받은 인자와 사용자가 입력한 인자가 달라진다.
- 환경 변수는 앱 코드가 직접 읽을 수 있고 설정은 실행하는 쪽(셸, 설치 프로그램, 바로 가기)의 책임이다.
  앱 정의에 선언을 받으면 사용자 환경과 앱 선언이 충돌하는 경우의 우선순위를 정해야 한다.

## 호환성

공개 API, 권한, 호스트 이벤트, 오류 코드의 변경이 없다. 쓰는 곳이 생기면 앱 정의의 선언 필드로 별도 결정한다.

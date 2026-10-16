---
status: accepted
---

# 앱 정보는 Core가 제공하는 `ctx.app`으로 노출한다

결정일: 2026-10-16

앱 이름, 버전, 식별자와 Bun, WebView, 프레임워크 버전을 백엔드에서 조회할 방법이 없었다.
앱이 `package.json`을 직접 읽으면 패키지된 앱에서 경로가 달라지고, WebView 버전은 호스트만 알 수 있다.

## 결정

1. 앱 정보는 선택 네이티브 플러그인이 아니라 Core가 제공하는 `CommandContext.app`(`AppInfo`)이다.
   [ADR 0013](./0013-optional-native-plugins.md)과 [ADR 0014](./0014-optional-plugin-packages.md)의 선택 플러그인은
   운영체제 기능에 접근하는 선택 기능을 대상으로 한다. 앱 정보는 앱 자신의 메타데이터이며 네이티브 접근이나
   권한이 없으므로 이 결정의 예외다. 운영체제 정보는 계속 `plugin-os`가 제공한다.
   Tauri도 앱 정보를 코어의 `@tauri-apps/api/app`에 두고 OS 정보를 `plugin-os`로 분리하며,
   Electron의 `app` 모듈도 코어에 있다.
2. `ctx.app`은 동결된 단일 객체이며 모든 명령과 플러그인 setup 컨텍스트가 공유한다. 권한이 필요 없다.
3. 호스트가 `CoreServices.app`으로 값을 넘기고 Core는 시작할 때 한 번 검증해 복사본을 동결한다.
   필드는 비어 있지 않은 문자열이며 길이는 `APP_INFO_MAX_LENGTH`(1024 UTF-16 코드 유닛) 이하여야 한다.
   한도는 단일 창 앱에서 `name`이 되는 창 제목의 기존 상한과 같아서, 이미 만든 패키지의 제목이 시작을 막지 않는다.
   `version`, `runtime.framework`, `runtime.webview`만 `null`을 허용한다. 위반하면 Core 시작이
   `INVALID_ARGUMENT`로 실패한다. 이는 호스트와 Core 사이의 내부 계약이다.
4. `NativeEnvironment`는 바꾸지 않는다. 플러그인은 setup 컨텍스트의 `ctx.app`으로 값을 받으며
   WebView2Loader 경로 같은 호스트 내부 값은 플러그인에 노출하지 않는다.

## 필드의 출처

| 필드 | 출처 |
| --- | --- |
| `name` | 앱 설정의 `title`. 매니페스트에 `title`이 없는 이전 패키지는 `appId`를 쓴다. |
| `identifier` | 앱 설정의 `appId`. 런타임 앱 ID이며 패키징의 `bundle.identifier`가 아니다. |
| `version` | 빌드가 패키지 `manifest.json`의 `app.version`에 기록한 앱 `package.json`의 버전. 필드가 없으면 `null`. Windows에서는 패키지 `manifest.json` 파일 자체가 없어도 `null` |
| `runtime.framework` | 빌드가 `framework.version`에 기록한 프레임워크 버전. 필드가 없으면 `null`. 빌드는 앱이나 프레임워크 `package.json`에 `version`이 없으면 해당 필드를 생략한다. |
| `runtime.bun` | `Bun.version` |
| `runtime.webview` | 아래 플랫폼별 규칙. 알 수 없으면 `null` |

`bundle.release.version`은 설치 프로그램 버전만 바꾸며 `version`은 앱 `package.json`에서 오므로 달라지지 않는다.
모바일은 백엔드에 패키지 manifest가 없으므로 CLI가 같은 출처의 이름, 식별자, 버전, 프레임워크 버전을
번들할 때 상수로 포함한다.

호환성과 검증 규칙은 다음과 같다.

- 이 기능 이전에 만든 패키지와 도구가 직접 구성한 패키지는 패키지 `manifest.json`이나 `title`이 없을 수 있다.
  Windows 호스트는 `manifest.json` 파일이 없을 때(`ENOENT`)만 `version`과 `framework`를 `null`로 둔다.
  macOS 호스트는 기존처럼 `manifest.json`이 반드시 있어야 하며 없으면 시작이 실패한다. 두 호스트 모두
  `app.version`이나 `framework.version` 필드가 없으면 `null`로 두고 `title`이 없으면 `name`을 `appId`로
  대신한다. 다른 읽기 오류와 값이 있는데 잘못된 경우에는 시작이 실패한다.
- 빌드는 같은 한도를 먼저 검사한다. `bunaway.json`의 `app.title`과 앱, 프레임워크 `package.json`의 `version`
  (있을 때)이 비어 있지 않은 문자열이 아니거나 한도를 넘으면 설정 로드나 빌드가 실패한다.
  모든 검사는 `@bunaway/runtime-bun/app-metadata`의 `isAppInfoText`를 쓴다.

## WebView 버전

- Windows: 시작할 때 `WebView2Loader`의 `GetAvailableCoreWebView2BrowserVersionString`으로 설치된 WebView2 런타임
  버전을 조회한다. WebView 생성과 같은 기본 위치를 사용한다.
- macOS: 시스템 WebKit 번들(`com.apple.WebKit`)의 `CFBundleShortVersionString`을 읽고 없으면 `CFBundleVersion`을 쓴다.
  Objective-C 접근은 메인 스레드에서 해야 하므로 `entry.ts`가 백엔드 Worker를 시작하기 전에 조회해 Worker에 넘긴다.
- Android, iOS와 프로세스 런타임(`runBunApp`): 호스트가 보고하는 WebView 엔진 버전이 없으므로 `null`이다.

버전은 정보 제공용이므로 조회 실패는 앱 시작을 막지 않는다. 호스트 로그에 `webview-version-unavailable`을
남기고 값을 `null`로 둔다. 값은 Core 시작 시점에 한 번 정해지며 실행 중의 WebView2 업데이트는 반영하지 않는다.

## 백엔드 전용

내장 UI 명령은 만들지 않는다. UI에서 필요하면 앱이 `ctx.app`을 반환하는 명령을 직접 정의하고 뷰 정책에 허용한다.
내장 명령은 프레임워크 예약 명령 이름 공간과 권한 표면을 새로 만든다. 현재 Core에는 둘 다 없으며
앱마다 노출할 필드가 다를 수 있으므로 앱이 선택하게 한다.

## 검증 범위

계약 테스트는 필드 검증, 동결과 플러그인 setup 전달, 패키지 manifest 해석, 모바일 번들의 상수를 검사한다.
Windows의 WebView2 버전 조회는 `tests/lifecycle/windows-webview-version.test.ts`가 실제 로더 호출로 검증하고,
`mise run host:windows`의 호스트 fixture가 네 부분 버전 형식을 확인한다. macOS의 WebKit 조회는
`mise run host:macos`의 호스트 fixture가 비어 있지 않은 문자열인지 확인한다.

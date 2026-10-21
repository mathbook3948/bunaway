---
status: accepted
---

# 선택 플러그인은 `bunaway.json`의 `plugins` 절과 앱 버전을 `NativeEnvironment`로 받는다

결정일: 2026-10-21

앱 업데이트 확인(`updater.check`)은 앱이 고정한 엔드포인트와 앱 자신의 버전이 있어야 동작한다.
선택 네이티브 플러그인은 어댑터를 만들 때 `NativeEnvironment`만 받는데, 거기에는 앱 버전도 앱이 플러그인마다
고정하는 설정도 없었다. 호출 인자로 엔드포인트를 받으면 WebView가 임의 URL 요청을 일으킬 수 있으므로,
값은 신뢰된 쪽(앱 설정)에서 호스트를 거쳐 플러그인에 전달되어야 한다.

## 결정

1. `NativeEnvironment.app`에 `version: string | null`을 추가한다. 값은 [ADR 0022](./0022-app-info-context.md)의
   `ctx.app.version`과 같은 출처(패키지 `manifest.json`의 `app.version`, 없으면 `null`)이며 호스트가 같은 계산에서
   넘긴다. 새로운 출처를 만들지 않는다. 호스트가 만들지 않은 환경(테스트 등)에서는 필드가 없을 수 있고 `null`과 같게 읽는다.
   ADR 0022 결정 4("`NativeEnvironment`는 바꾸지 않는다")는 이 결정으로 개정한다. 플러그인 setup 컨텍스트가
   `ctx.app`을 받는다는 부분과 호스트 내부 경로를 노출하지 않는다는 부분은 그대로다.
2. `bunaway.json`에 최상위 `plugins` 절을 둔다. 키는 설치된 플러그인 이름, 값은 JSON 객체다.
   ```json
   { "plugins": { "updater": { "endpoint": "https://example.com/{{target}}/{{arch}}/{{current_version}}" } } }
   ```
3. 검증은 두 단계다. 코어(CLI 빌드와 호스트 시작)는 모양만 검사한다: 객체의 객체, 설치되지 않은 플러그인 이름 거부,
   직렬화한 JSON 합계 `PLUGIN_SETTINGS_MAX_BYTES`(16 KiB) 이하. 내용은 해당 플러그인이 어댑터를 만들 때
   검증하며 잘못되면 어댑터 생성이 실패한다. 코어는 플러그인 설정의 의미를 알지 못하므로 플러그인이 늘어도
   코어가 커지지 않는다. 검사 함수는 `@bunaway/runtime-bun/app-metadata`의 `parsePluginSettings` 하나를 CLI와 호스트가 같이 쓴다.
4. 호스트는 검증한 절을 `NativeEnvironment.app.pluginSettings`(플러그인 이름을 키로 하는 읽기 전용 객체)로 전달한다.
   `app`은 신뢰된 앱 정체성을 담는 자리이며 같은 신뢰 수준의 값이다. WebView와 명령 입력은 이 값을 바꿀 수 없다.
5. 새 권한, 호스트 이벤트, 오류 코드는 없다. 플러그인 연산의 권한은 기존대로 연산 이름(`updater.check`)이다.

## 근거

Tauri는 업데이트 엔드포인트와 공개키를 `tauri.conf.json`의 `plugins.updater`에 두고 플러그인이 시작할 때 읽는다.
Electron의 `autoUpdater.setFeedURL`과 electron-updater의 설정 파일도 렌더러가 아닌 메인 프로세스나 빌드 산출물이
정한다. 같은 모양으로 설정 파일의 `plugins.<이름>` 절을 쓰고, 코어는 전달만 맡는다.

## 호환성

`plugins` 절이 없는 앱은 변하지 않는다. `version`은 모든 호스트가 이미 계산하는 값이고 플러그인이 읽지 않으면 영향이 없다.
기존 플러그인은 새 필드를 읽지 않는다.

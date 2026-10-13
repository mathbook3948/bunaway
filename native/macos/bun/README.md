# macOS Bun FFI 호스트

앱 진입점과 백엔드를 Bun에서 실행한다. AppKit와 WKWebView는 macOS의 시스템
Objective-C 런타임을 Bun FFI로 직접 호출한다. 프레임워크에서 C/ObjC++ 어댑터,
별도 네이티브 호스트 실행 파일이나 dylib를 컴파일하지 않는다.

AppKit는 메인 스레드에서 실행하고 앱 정의는 같은 프로세스의 Bun Worker에서
실행한다. UI 스레드는 5ms마다 비차단 CoreFoundation 이벤트와 최대 64개의
AppKit 이벤트를 처리하고 Bun 이벤트 루프에 제어를 돌려준다. Worker 연결은
Windows와 같은 검증, 수신 확인, 용량 제한을 사용한다.
등록한 `execution: "io"` 어댑터는 별도 I/O Worker에서 초기화하고 실행한다. `executeUI`가 있는 I/O 어댑터에도 같은 요청 ID, 권한,
취소 신호와 실행 직전 검사를 전달한다. SDK 파싱은 한 번만 수행한다.
`config.ts`가 검증한 패키지의 `appId`와 실제 호스트 실행 파일, 재시작 인자를
`NativeEnvironment.app`으로 I/O Worker에 전달한다. 작업 입력으로 identity를 바꾸지 않는다.
`app.id`는 앱 namespace이며 Keychain의 OS 접근 identity는 실제 실행 파일이다.
메인 스레드는 파싱 전과 실행 직전의 정책과 살아 있는 문서를 확인한다.
취소와 문서 폐기는 큐와 대기 중 파서를 해제하고 늦은 응답을 버린다.
이미 시작한 동기 I/O의 부수 효과는 되돌리지 않는다. 기능 지원 목록은 등록 계약과
패키지의 해당 플랫폼 작업 목록을 사용하며 지원과 정책 허용을 구분한다.
UI 초기화가 실패해도 백엔드에 종료를 요청하고 플러그인 정리와 Worker 종료를 기다린다.
시작 중 종료하면 대기 중인 Host API 호출을 `CANCELLED`로 끝내고, 완료된 setup의 정리 훅을 실행한다.
종료 요청은 진행 중인 I/O 호출의 취소를 먼저 전달해 코어 정리 훅이 네이티브
취소 완료를 기다릴 수 있게 한다. 코어 정리 훅 뒤에 I/O 어댑터를 폐기하고 두 Worker의 실제 종료를 기다린다.
UI 이벤트 처리 여부와 관계없이 종료 요청부터 5초가 지나면 두 Worker를 강제 종료한다.
호스트는 전용 프로세스 그룹과 시스템 `/bin/sh` 감시 프로세스로 하위 프로세스를 소유한다.
플러그인 정리 후 남은 하위 프로세스를 종료하고, 호스트가 강제 종료되면 pipe EOF로
그룹 전체를 정리한다. `unref()`는 그룹에서 분리하지 않으므로 같은 정리 대상이다.
앱이 새 세션이나 그룹으로 분리한 프로세스는 관리하지 않는다.

WebKit 메시지는 네이티브 JSON 직렬화 전에 변환 가능 여부를 검사한다.
최상위 값이나 중첩 값에 `Date` 등 JSON으로 변환할 수 없는 객체가 있으면 거부한다.
응답 전달과 URL 조회 등 UI 타이머 밖의 Cocoa 호출도 임시 객체를 정리한다.
창 정리 후에는 콜백이 잡고 있던 JavaScript 상태를 해제한다. 등록된 네이티브 함수와
늦게 실행되는 WebKit block의 주소는 프로세스 수명 동안 유효하게 유지한다.
각 창은 초기 크기를 최소, 최대 제약으로 보정하고 사용자 크기 변경에도 같은
제약을 적용한다. 카메라와 마이크 요청은 WKWebView의 UI delegate에서 거부한다.
리소스 규칙은 앱과 뷰에 고정된 식별자로 저장해 재실행 때 기존 항목을 교체한다.

배포 앱은 Bun compiled 실행 파일을 `Contents/MacOS/bunaway-host`에 넣는다.
웹 자산과 정책은 `Contents/Resources`에 둔다. 별도 Bun 설치, C 컴파일러나
WebView를 위한 추가 네이티브 바이너리는 필요하지 않다.
`with { type: "file" }`로 가져온 파일은 compiled 실행 파일에 포함하며,
`Bun.file(new URL(file, import.meta.url))`로 읽는다.

현재 대상은 macOS arm64다. 다중 창, 명령과 이벤트, 뷰별 정책과 세션, 사용자 지정
자산 스킴, 렌더러 복구와 종료를 제공한다. `app.windows`와 `startup: false`를 지원한다.
`@bunaway/plugin-windows`는 목록, 생성과 재생성, show/hide/focus/close 및 표시와
포커스 조회를 제공한다. 다른 창 작업은 `UNSUPPORTED`다. `desktop`, 저장, 로그와
opener 어댑터는 지원하지 않는다.

창마다 임시 `WKWebsiteDataStore`를 따로 만들고 같은 뷰의 재생성에서 유지한다.
앱 실행이 끝나면 데이터는 남기지 않는다. 보조 창을 닫으면 해당 세션과 창만 정리하며,
마지막 창을 닫으면 앱을 종료한다. 재생성 중에는 마지막 창 자동 종료를 보류한다.
생성 완료는 WebView 설정과 리소스 규칙 준비이며 문서나 SDK 준비를 보장하지 않는다.

## 파일별 책임

`boot.ts`는 실행 인자를 읽고, `config.ts`는 패키지 설정과 정책을 검증한다.
`entry.ts`는 UI, Host API와 백엔드 및 I/O Worker의 시작과 종료를 조정하고, `backend.ts`는 앱과 코어를 실행한다.
`host-operations.ts`는 Windows와 공유하는 `native/host-api/bun/io-worker.ts`의 큐와 어댑터 수명을 사용한다.
`windows.ts`는 창별 세션 경계와 지연 생성, 재생성 및 개별 정리를 소유한다.
`process-group.ts`는 하위 프로세스의 종료와 호스트 비정상 종료 감시를 소유한다.
`application.ts`는 앱 delegate와 모든 창이 공유하는 이벤트 루프를 소유한다.
`objc.ts`는 Objective-C FFI 바인딩과 콜백을, `webview.ts`는 개별 AppKit 창과 WKWebView를 소유한다.
개별 창 정리는 앱 delegate나 이벤트 루프를 해제하지 않는다.
카탈로그와 플러그인 검증, 응답 변환은 `native/host-api/bun`에서 Windows와 공유한다.
Worker 통신과 뷰 경계는 `packages/runtime-bun`의 공통 구현을 사용한다.

## 실행

```sh
mise run host:macos
mise exec -- bun --no-env-file tests/lifecycle/run-native.ts --skip-tests
mise exec -- bun --no-env-file tests/lifecycle/run-native.ts --app
```

`package.ts`는 회귀 패키지와 선택한 `.app`을 빌드하고, 공통 Bun 실행기는 빌드 후 실제
WKWebView와 배포 스크립트 검사를 실행한다. 테스트 설정과 리소스 경계 페이지는
`tests/fixtures/desktop/host/macos-app.json`과 `macos-web/`에 둔다.
Bun 1.4.2, macOS arm64와 GUI 세션이 필요하다. `--skip-tests`는 빌드만 실행하고,
`--app`은 ad-hoc 서명한 `build/Bunaway.app`을 만들어 서명된 앱의 회귀도 검사한다.
Xcode CLT와 C 컴파일러는 필요하지 않다. 독립 POSIX 프로세스 probe는 제거했으며 이전 실행 기록만 유지한다.

현재 결과와 제약은 [Bun FFI 실행 기록](../../../docs/architecture/macos-bun-results.md)과
[지원 표](../../../docs/platform-support/README.md)를 따른다.

I/O 기반 회귀 `tests/lifecycle/macos-io-host.ts`는 실제 compiled WKWebView 앱에서
백엔드 setup과 웹 호출의 출처, 정책 거부, 기능 지원 목록, 동기 작업 중 UI 왕복,
입력 파싱 취소와 문서 폐기, 초기화 실패 및 종료 기한을 검사한다.
`run-native.ts`에서 실행하며 CI는 `build/macos-io-results.json`을 보관한다.
개별 image, clipboard, storage, log/capabilities와 opener 어댑터와 그 fixture의
통합은 별도 PR에서 검증한다. 이 기반 변경만으로 해당 기능의 지원을 선언하지 않는다.

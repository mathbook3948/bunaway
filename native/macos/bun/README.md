# macOS Bun FFI 호스트

앱 진입점과 백엔드를 Bun에서 실행한다. AppKit와 WKWebView는 macOS의 시스템
Objective-C 런타임을 Bun FFI로 직접 호출한다. 프레임워크에서 C/ObjC++ 어댑터,
별도 네이티브 호스트 실행 파일이나 dylib를 컴파일하지 않는다.

AppKit는 메인 스레드에서 실행하고 앱 정의는 같은 프로세스의 Bun Worker에서
실행한다. UI 스레드는 5ms마다 비차단 CoreFoundation 이벤트와 최대 64개의
AppKit 이벤트를 처리하고 Bun 이벤트 루프에 제어를 돌려준다. Worker 연결은
Windows와 같은 검증, 수신 확인, 용량 제한을 사용한다.
UI 초기화가 실패해도 백엔드에 종료를 요청하고 플러그인 정리와 Worker 종료를 기다린다.
UI 이벤트 처리 여부와 관계없이 종료 요청부터 5초가 지나면 Worker를 강제 종료한다.

WebKit 메시지는 네이티브 JSON 직렬화 전에 변환 가능 여부를 검사한다.
최상위 값이나 중첩 값에 `Date` 등 JSON으로 변환할 수 없는 객체가 있으면 거부한다.
응답 전달과 URL 조회 등 UI 타이머 밖의 Cocoa 호출도 임시 객체를 정리한다.
단일 창은 초기 크기를 최소, 최대 제약으로 보정하고 사용자 크기 변경에도 같은
제약을 적용한다. 카메라와 마이크 요청은 WKWebView의 UI delegate에서 거부한다.
리소스 규칙은 앱과 뷰에 고정된 식별자로 저장해 재실행 때 기존 항목을 교체한다.

배포 앱은 Bun compiled 실행 파일을 `Contents/MacOS/bunaway-host`에 넣는다.
웹 자산과 정책은 `Contents/Resources`에 둔다. 별도 Bun 설치, C 컴파일러나
WebView를 위한 추가 네이티브 바이너리는 필요하지 않다.

현재 대상은 macOS arm64다. 단일 창, 명령과 이벤트, 뷰 정책, 사용자 지정 자산
스킴, 렌더러 복구와 종료를 제공한다. 다중 창, 데스크톱 종료 설정과 네이티브
플러그인 어댑터는 지원하지 않는다.

## 파일별 책임

`boot.ts`는 실행 인자를 읽고, `config.ts`는 패키지 설정과 정책을 검증한다.
`entry.ts`는 UI와 백엔드 Worker의 시작과 종료를 조정하고, `backend.ts`는 앱과 코어를 실행한다.
`objc.ts`는 Objective-C FFI 바인딩과 콜백을, `webview.ts`는 AppKit 창과 WKWebView를 소유한다.
Worker 통신과 뷰 경계는 `packages/runtime-bun`의 공통 구현을 사용한다.

## 실행

```sh
mise run host:macos
mise exec -- zsh native/macos/bun/run.sh --skip-tests
mise exec -- zsh native/macos/bun/run.sh --app
```

`package.ts`는 회귀 패키지와 선택한 `.app`을 빌드하고, `run.sh`는 빌드 후 실제
WKWebView와 배포 스크립트 검사를 실행한다. 테스트 설정과 리소스 경계 페이지는
`tests/fixtures/desktop/host/macos-app.json`과 `macos-web/`에 둔다.
Bun 1.4.2, macOS arm64와 GUI 세션이 필요하다. `--skip-tests`는 빌드만 실행하고,
`--app`은 ad-hoc 서명한 `build/Bunaway.app`을 만들어 서명된 앱의 회귀도 검사한다.
Xcode CLT와 C 컴파일러는 필요하지 않다. 이전 POSIX 프로세스 probe는 별도 실험이다.

현재 결과와 제약은 [Bun FFI 실행 기록](../../../docs/architecture/macos-bun-results.md)과
[지원 표](../../../docs/platform-support/README.md)를 따른다.

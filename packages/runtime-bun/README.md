# Bun 런타임 어댑터

`runBunApp(app, { app, input?, output?, platform? })`은 stdin/stdout으로 코어를 네이티브 호스트의 프로세스 IPC에 연결하는 어댑터다.
이 함수는 프로세스 probe와 계약 테스트에서 사용한다. Windows와 macOS 제품 호스트는
같은 앱 정의를 Bun에서 직접 실행한다. 앱 개발자는 `build.app`에 지정한 파일에서
AppDefinition을 default export한다.
코어의 플랫폼은 `process.platform`에서 읽어 공통 Platform 값으로 변환한다.

`@bunaway/runtime-bun/app-manifest`는 CLI와 Windows/macOS 호스트가 공유하는 실행 manifest
계약이다. `parseAppManifest`는 생성 데이터를 검증하고 `readAppManifest`는 실행 자산의
`manifest.json`을 읽어 검증한다. 앱 설정, 정책, 플러그인 계약과 개발 SDK 모듈 목록을
담으며 플러그인 코드를 불러오거나 네이티브 자원을 초기화하지 않는다.

`@bunaway/runtime-bun/app-metadata`는 `ctx.app`의 원천 데이터 계약이다. 호스트와 CLI가 앱 설정의 이름과 식별자,
패키지 manifest의 앱과 프레임워크 버전을 `AppMetadata`로 모으고 `toAppInfo`가 Bun과 WebView 버전을 더해 `AppInfo`를 만든다.
`runBunApp`은 이 `AppMetadata`를 `connection.app`으로 받는다.
`appName(title, identifier)`은 `title`이 없으면 식별자를 이름으로 쓰고, `readPackageVersions`는 패키지 `manifest.json`이
없으면 버전을 `null`로 둔다. `isAppInfoText`는 CLI와 호스트가 함께 쓰는 문자열 규칙(비어 있지 않고 1024자 이하)이다.

호스트가 보낸 boot의 정책, 백엔드 컨텍스트, 런타임 세대로 `createCore`를 만들고
플러그인 초기화와 hello 협상 뒤 ready를 보낸다. 초기화 중에도 Host API 요청을
발행하고 stdin에서 응답을 처리한다. stdout은 크기, 큐 상한을 가진 NDJSON 전용이므로
앱 로그에 `console.log`를 사용하지 않고 Host API `log.write` 또는 stderr를 사용한다.
명령 핸들러의 예기치 않은 예외는 명령 이름과 원래 오류, 스택을 stderr에 기록한다.
WebView에는 기존 `INTERNAL: Command failed.` 응답만 전달한다.

- `session-open`은 호스트 컨텍스트와 뷰 정책으로 코어 세션을 만든다.
- `web`은 해당 세션에 전달하고 코어 응답, 이벤트를 같은 컨텍스트로 중계한다.
- Host API는 요청 ID와 컨텍스트를 모두 대조한다. 취소는 `host-cancel`을 보내며
  대기 항목, abort 리스너를 해제한다. 취소, 폐기 뒤 응답은 버린다.
- `revoke`는 세션을 먼저 라우팅에서 제거하고 요청, 구독, Host API를 정리한다.
- `shutdown`은 새 작업과 Web 출력을 막고 코어, 플러그인을 종료한 뒤 stopping을
  보내고 stdin을 닫는다. 실제 프로세스 종료와 자손 정리는 네이티브 호스트가 확인한다.

부팅 전, 플러그인 초기화 중 종료도 처리한다. 잘못된 방향, 세대, 프레임, 예상 밖 EOF는
실패로 종료한다. [런타임 API](../../docs/site/src/content/docs/reference/tooling/core-and-runtime.mdx)와
[macOS 실행 기록](../../docs/architecture/macos-native-results.md)을 참고한다.

iOS 내장 Bun의 백엔드 Worker는 `runBunApp(app, { app: appMetadata, input, output, platform: "ios" })`를 사용한다.
입력은 런타임이 종료하고 출력 스트림은 호출자가 소유한다. Bun entry는 Worker 종료 뒤에도 유지된다.

Android와 iOS의 직접 문서 연결은 같은 `LoopbackChannel`을 사용한다.
HTTPS 정책 출처의 권한을 확인하고, iOS에서는 자산 scheme에 대응하는 `bunaway://` Origin으로
연결을 검사한다. Host 검사와 일회용 토큰, 입력 검증, 큐 제한 및 세션 회수는 공통이다.

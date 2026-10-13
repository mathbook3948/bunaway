# iOS 내장 Bun 호스트

Swift 메인 스레드는 UIKit과 WKWebView를 소유한다. `BunEmbedInitialize()`와
`BunEmbedStart()`로 Bun entry를 한 번 시작하며 백엔드는 교체 가능한 Worker에서 실행한다.
공통 AppDefinition, Core와 클라이언트 SDK를 사용한다.
구조와 수명은 [ADR 0018](../../docs/decisions/0018-ios-embedded-bun-worker.md),
앱 개발과 Xcode 사용은 [iOS CLI 문서](../../docs/site/src/content/docs/reference/cli/ios.mdx)를 따른다.

- `entry.ts`: Bun 수명을 유지하고 Worker의 입력, 출력과 종료를 관찰한다.
- `backend.ts`: MessagePort를 공통 런타임 스트림으로 연결하며 플랫폼을 `ios`로 지정한다.
- `host/`: Swift 단일 뷰 호스트가 Darwin API로 파이프를 만들고 Bun embedding API를 직접 호출한다.
  별도 C 소스는 없으며 런타임의 `embedding.h`만 Swift 브리징 헤더로 사용한다.
- `bridge.js`: Swift 문서 nonce와 네이티브 콜백을 공통 모바일 브리지에 연결한다.
- `../mobile/bridge.js`: Android와 공유하는 WebSocket 연결, fallback, 큐 제한과 SDK 전달이다.
- `project.pbxproj`, `app/`: 앱이 수정할 Xcode 프로젝트와 Swift 초기 파일이다.

`BunawayViewController`는 설정 읽기, WebView 구성, Bun 연결 순서로 초기화한다.
같은 클래스에서 백엔드 세대와 문서 세션의 전환을 관리하며, 파이프는 앱 수명 동안 유지한다.
제어 파이프는 시작 인자로 전달한 전용 디스크립터를 사용하며 프로세스 stdio를 바꾸지 않는다.
기본 명령과 이벤트는 WKWebView에서 백엔드 Worker의 IPv4 loopback WebSocket으로 직접 전달한다.
Swift는 main frame, 자산 출처와 문서 nonce를 확인하고 일회용 연결 주소를 전달한다.
제어 파이프와 entry는 세션 생성, 회수와 Worker 수명을 계속 관리한다.
공통 런타임은 HTTPS 정책 출처를 확인한 뒤 iOS WebKit의 `bunaway://` Origin과 Host를 정확히 검사한다.
연결 주소는 한 번만 사용할 수 있으며 문서 교체, background 전환과 Worker 종료 때 회수한다.
서버 시작 또는 최초 WebSocket 연결 실패는 Swift 브리지로 전환한다.
주소 전달 후 연결에 실패한 경우 기존 권한을 회수하고 새 세션을 만든다.
WebSocket이 열린 뒤의 실패는 세션만 닫고 메시지를 재전송하지 않는다.

fallback 문서 입력은 공통 메시지 스키마로 검증하며 잘못된 필드와 메시지 및 제어 프레임의 크기, 깊이 초과는 해당 세션만 닫는다.
슬래시는 그대로 직렬화한다. 이전 문서 메시지와 이미 끝났거나 교체된 탐색의 오류는 버린다.
해시 이동은 연결을 유지하고 캐시 복원은 페이지를 다시 로드해 새 세션을 만든다.
현재 탐색의 취소와 실패는 home으로 한 번 복구하며 home도 실패하면 재시도 화면을 표시한다.
fallback 응답은 읽기 배치마다 한 WebKit 호출로 전달하고 완료될 때까지 파이프 읽기를 기다린다.
문서의 입력 큐 포화는 해당 세션만 닫으며 앱을 종료하지 않는다.

Bun iOS beta.1 ZIP, 기기와 Simulator dylib 해시는 런타임 manifest에 고정했다.
Xcode가 XCFramework slice를 선택하며 앱의 Frameworks에 Embed & Sign으로 복사한다.

## 검증

```sh
mise run host:ios -- <booted Simulator UUID>
```

실행 fixture는 설치된 CLI 배포물로 앱을 만들고 직접 WebSocket과 강제 fallback을 각각 실행한다.
직접 연결에서 SDK hello가 Swift를 거치지 않는지, fallback에서는 Swift로 전달되는지 확인한다. UIKit과 WKWebView에서 공통 SDK를 사용해
Core 명령, 이벤트와 권한 거부, 요청 취소, 서브프레임 차단, 큰 UTF-8 응답 및 backend 파일 import를 확인한다.
Swift에서 두 번 백엔드를 재시작하고 세 Worker 세대의 상태 초기화를 검사한다.
Swift 로그, 폐기된 문서 입력, 문서 오류와 탐색 실패 후 재연결 및 Xcode bundle ID 변경도 검사한다.
해시와 링크 이동, 실제 캐시 복원 후 재연결, 느린 WebView의 이벤트 순서,
입력 큐 포화와 home 실패 후 재시도도 실제 호스트로 검사한다.
600KB 슬래시 문자열 왕복, 잘못된 메시지 10종과 폐기 후 후속 입력도 검사한다.
실제 provisional 탐색을 취소한 뒤 SDK가 다시 연결되는지, 후속 탐색은 보존하는지 확인한다.
이전 탐색의 취소와 오류 콜백은 새 문서 연결 후 fixture에서 직접 전달한다.
결과는 `build/ios-host/results.json`, 생성 프로젝트는 `build/ios-host/app/ios/`에 남는다.

CLI 계약 검사는 `tests/cli/ios.test.ts`에서 프로젝트 보존과 거부 조건, 실제 Bun Worker
교체를 확인한다. 환경과 결과는 [iOS 실행 기록](../../docs/architecture/ios-host-results.md)에 정리했다.
Simulator 결과는 기기 실행이나 배포 서명, App Store 검증을 대신하지 않는다.

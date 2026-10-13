---
status: accepted
---

# iOS는 내장 Bun entry를 유지하고 백엔드를 Worker에서 실행한다

결정일: 2026-10-13

## 배경

[ADR 0010](./0010-windows-first-platform-model.md)의 공통 앱 정의를 iOS에도 사용한다.
[Bun iOS beta.1](https://github.com/mathbook3948/bun/releases/tag/bun-v1.4.2-beta.1)은
기기와 Simulator의 arm64용 `Bun.xcframework`와 C embedding API를 제공한다.
iOS에서 자식 프로세스를 실행할 수 없으며 `BunEmbedStart`는 한 번만 호출할 수 있다.

## 결정

Swift 앱의 메인 스레드는 UIKit과 WKWebView를 소유한다. 같은 메인 스레드에서
`BunEmbedInitialize()`를 호출한 뒤 `BunEmbedStart()`로 프레임워크의 `entry.js`를
한 번 시작한다. 파이프와 환경 변수 설정, embedding 호출은 Swift의 Darwin API로 처리한다.
별도 C 소스는 작성하지 않으며 XCFramework의 `embedding.h`만 Swift 브리징 헤더로 사용한다.
Bun은 전용 스레드에서 실행하며 entry는 앱 수명 동안 유지한다.
앱 개발자가 작성하는 파일은 기존 `app.ts` 하나다.

entry는 `backend.js` Worker를 만들고 호스트가 보낸 부팅, 세션과 종료 메시지를 전달한다.
Worker는 공통 `runBunApp`과 Core를 사용한다. 플랫폼은 명시적으로 `ios`를 전달한다.
Swift와 entry는 같은 프로세스의 전용 파이프를 사용한다. Swift가 Bun 시작 인자로
파일 디스크립터를 전달하고 entry가 해당 스트림을 소유한다. 프로세스 stdin/stdout은 변경하지 않으며,
entry와 Worker는 수신 확인이 있는 MessagePort로 연결한다.
백엔드 stdout 로그는 stderr로 보낸다. Swift와 네이티브 SDK의 stdout 로그는 제어 파이프에 섞이지 않는다.

명령과 이벤트의 기본 전달 경로는 WKWebView와 백엔드 Worker 사이의 직접 WebSocket이다.
Android와 공통 `LoopbackChannel` 및 모바일 브리지의 연결, fallback, 큐 제한 로직을 공유한다.
Swift는 실제 main frame과 자산 출처, 문서 nonce를 검증한 뒤 제어 파이프로 세션과
일회용 연결 권한을 요청한다. 서버는 `127.0.0.1`의 임의 포트만 사용하며 토큰을 한 번만 받는다.
공통 HTTPS 정책 출처의 권한을 확인한 뒤 WebSocket의 실제 `bunaway://` Origin과 Host를
정확히 비교한다. 불투명 출처인 `null`은 허용하지 않는다.
Swift와 entry는 일반 메시지 전달에서 빠지지만 문서와 Worker의 수명을 계속 소유한다.
서버를 열지 못하면 기존 세션으로, 주소 전달 후 최초 연결에 실패하면 기존 권한을 회수하고
새 세션으로 Swift fallback을 연결한다. 아직 전송하지 않은 SDK 입력만 순서대로 전달한다.
WebSocket open 이후의 실패는 세션을 닫고 자동 재연결이나 요청 재전송을 하지 않는다.


`restartBackend()`는 문서 세션을 회수하고 Core 종료를 기다린다. Worker 스레드가 종료된
뒤 새 런타임 세대로 Worker를 만들고 화면을 다시 연결한다. Bun 전체를 재시작하지 않는다.
백엔드 상태는 새 Core에서 초기화되며 앱이 정상 작업 중 저장한 파일은 유지된다.

WKWebView는 `bunaway://` 자산 scheme으로 패키지의 웹 파일을 읽는다.
설정과 정책은 공통 HTTPS home을 유지하며 Swift가 같은 host와 경로를 자산 scheme으로
바꾼다. 발신 WebView, main frame과 실제 scheme, host를 네이티브 콜백에서 확인하고
뷰와 호출 컨텍스트를 호스트가 지정한다. Swift는 main frame에서
새 문서의 provisional 탐색이 시작될 때 nonce를 bridge에 넣는다. 같은 문서의 해시 이동은
연결을 유지한다. 뒤로 가기로 캐시 문서를 복원하면 bridge가 해당 페이지를 다시 로드해 새 세션을 만든다.
복원된 페이지의 JS 메모리 상태는 유지하지 않는다. 이전 nonce의 메시지는 JSON 파싱 전에 버리며,
응답도 현재 nonce에만 전달한다.
외부 탐색과 서브프레임의 bridge 호출은 허용하지 않는다. Core는 기존 입력 검증과
명령, 이벤트 정책을 적용한다. fallback 경로의 Swift는 같은 패키지의 공통 메시지 스키마로 필수 필드,
타입과 추가 필드 등을 검사한다. 이해하지 못하는 스키마 규칙은 부팅에서 거부한다.
메시지를 제어 프레임으로 직렬화한 뒤의 크기와 깊이 제한도 문서 오류로 처리한다.
슬래시를 불필요하게 이스케이프하지 않는다. 네이티브 플러그인 권한은 동기화 시 거부한다.

background 전환은 문서 세션을 회수하지만 Bun이나 Core를 종료하지 않는다.
foreground 복귀와 WebView 렌더러 재생성은 새 문서를 연결한다.
iOS의 suspend 동안 JS 실행을 보장하지 않는다. SIGKILL에는 JS 종료 훅이 실행되지 않는다.
entry 종료, `process.exit()` 또는 처리되지 않은 JS 오류는 앱 프로세스도 종료한다.
Bun 시작 뒤 복구할 수 없는 제어 파이프 실패도 앱을 종료한다. 잘못된 문서 메시지와
현재 문서의 전달 오류는 해당 세션만 회수한다. 완료되거나 교체된 탐색의 오류는 무시한다.
현재 탐색이 취소되거나 실패하면 문서를 회수하고 home을 한 번 다시 로드한다.
취소 때도 이미 회수된 이전 문서의 브리지는 복원할 수 없으므로 새 문서가 필요하다. 복구도 실패하면
재시도 화면을 표시하며 자동 탐색을 멈춘다. 앱과 Bun은 유지한다. 자산 요청의 `/`는 `index.html`로 연결한다.

fallback 경로에서 Swift는 파이프에서 읽은 응답을 한 번의 WebKit 호출로 전달하고 완료 콜백까지 다음 읽기를 기다린다.
이 대기는 UIKit 메인 스레드를 막지 않으며, 느린 WebView에 대한 backpressure를 파이프에 전달한다.
문서 입력이 쓰기 큐 상한에 가까워지면 해당 세션만 회수하고 revoke와 종료 제어 프레임의 공간을 남긴다.
entry는 호스트의 shutdown 요청과 Worker 종료 코드를 확인하며 별도 stopped 메시지의 도착 순서에 의존하지 않는다.

## 네이티브 프로젝트와 검증 범위

`ios sync`는 앱의 `ios/Bunaway.xcodeproj`와 `AppDelegate.swift`를 처음에만 만든다.
이후에는 `ios/.bunaway/`의 호스트, 앱 번들, 정책과 고정된 XCFramework만 원자적으로
교체한다. Xcode 설정과 사용자 Swift 코드는 보존한다. Xcode는 기기 또는 Simulator용
slice를 선택하고 Embed & Sign 단계에 `libBun.dylib`를 넣는다.
런타임 ZIP과 두 dylib의 SHA-256은 `runtime/build-manifests/ios-arm64.json`에 고정한다.

최초 CLI는 macOS arm64의 동기화와 arm64 Simulator debug 빌드, 설치 및 실행을 제공한다.
CLI 빌드는 `ARCHS=arm64`를 지정해 일반 Simulator 대상에서도 x86_64 링크를 시도하지 않는다.
iOS 16 이상 arm64 기기용 빌드는 Xcode에서 팀과 서명을 설정해 진행한다.
기기 실행, 배포 서명과 App Store 제출은 별도 검증이 필요하다.

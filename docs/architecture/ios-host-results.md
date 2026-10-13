# iOS 내장 Bun 실행 결과

검증일: 2026-10-13. macOS arm64, Xcode 27.0 (27A266a), iOS 26.5의
arm64 iPhone 17 Pro Simulator에서 실행했다. 런타임은
[Bun iOS beta.1](https://github.com/mathbook3948/bun/releases/tag/bun-v1.4.2-beta.1)의
일반 `bun-ios-aarch64.zip`이며 두 slice와 ZIP의 고정 해시를 검사했다.

## 실제 Simulator 실행

```sh
mise run --tool node@22.22.3 host:ios -- 81965A44-6B4F-4071-8FA6-B22D38AE00B7
```

설치된 CLI 배포물로 공통 `app.ts`와 웹 UI를 번들하고 Xcode 프로젝트를 생성했다.
Xcode가 Simulator slice를 선택해 앱의 Frameworks에 `libBun.dylib`를 넣었다.
Swift UIKit 메인 스레드에서 Bun embedding API를 호출하고 WKWebView의 실제 SDK를 실행했다.

직접 WebSocket과 최초 연결을 강제로 거부한 Swift fallback을 각각 실행했다.
각 경로의 세 Worker 세대에서 다음 검사가 모두 통과했다.

- 명령 왕복과 명시적 오류, 등록됐지만 허용되지 않은 명령의 `PERMISSION_DENIED`
- 이벤트 구독, 전달과 구독 해제, 요청 취소
- 서브프레임이 보낸 위조 hello 거부 후 정상 main frame 연결
- 한글과 이모지 229,376바이트 응답의 보존
- backend 파일 import를 원본 프로젝트 경로 없이 앱 번들에서 읽기
- backend stdout 로그가 호스트 제어 프레임을 손상시키지 않는지 확인
- Swift의 두 번의 `restartBackend()`와 각 새 Worker의 `count === 1`
- Swift `print()`를 시작과 Worker 교체 때 실행해 전용 제어 파이프와 분리되는지 확인
- 현재 문서의 잘못된 JSON과 폐기된 문서의 후속 입력을 보낸 뒤 정상 문서로 재연결
- 새 문서에 이전 nonce의 잘못된 JSON을 보내도 SDK 연결을 유지하는지 확인
- 없는 패키지 경로의 실제 탐색 실패 후 호스트가 home을 복구하고 SDK를 다시 연결
- 별도 `/` 탐색에서 `index.html` 자산 매핑 확인
- 새 문서가 연결된 뒤 이전 탐색의 취소와 오류 콜백을 fixture에서 직접 전달
- 실제 provisional 탐색을 `stopLoading()`으로 취소한 뒤 home 복구와 새 SDK 연결 확인
- 후속 탐색이 이전 탐색을 취소한 경우 후속 목적지를 보존하는지 확인
- `/` 600,000개가 든 정상 문자열의 왕복으로 불필요한 이스케이프와 크기 초과 회귀 확인
- 필수 필드 누락, 잘못된 타입, 추가 필드, 잘못된 식별자와 길이, 소수와 안전 범위 밖 정수,
  중복 feature, 메시지의 깊이와 UTF-8 크기 초과 등 10종 입력이 문서만 닫는지 확인
- 잘못된 입력 바로 뒤의 후속 입력을 버리고 새 문서에서 같은 Core를 계속 쓰는지 확인
- Xcode에서 bundle ID를 `dev.bunaway.ios.fixture.native`로 바꾼 뒤 설치와 실행
- `location.hash`와 해시 링크 이동 뒤 같은 SDK 클라이언트로 명령 왕복
- `pageshow.persisted === true`인 실제 캐시 복원 후 bridge의 재로드와 새 SDK 연결
- WebView JS를 2초간 점유하면서 1ms 간격 이벤트 160개의 순서와 명령 응답 보존
- 백엔드를 2초간 점유하고 16KiB 입력 200개를 보내 입력 큐 포화 시 문서만 닫히는지 확인
- 문서 입력 포화 후 새 문서를 연결하고 같은 Bun과 Core에서 명령 왕복
- 일반 Simulator 대상의 `ios build`가 `ARCHS=arm64`로 빌드되는지 확인

없는 home을 설정한 별도 unsigned fixture도 실행했다. 최초 탐색과 한 번의 복구가 실패하면
재시도 화면을 표시했다. 실제 UIKit 버튼을 눌러 다시 탐색과 복구를 시도하고,
네 번째 실패 뒤 자동 탐색이 멈추고 앱이 유지되는지 확인했다.
이 검사는 fixture가 호스트의 탐색 실패를 직접 복구하지 않는다.
이벤트 검사는 회귀 재현용이며 처리량이나 응답 지연의 성능 벤치마크는 아니다.

현재 탐색의 취소와 후속 탐색으로 인한 취소는 실제 WebKit 탐색으로 확인했다.
이미 교체된 탐색의 늦은 오류는 delegate 콜백 계약 검사다.
탐색 취소 타이밍을 반복 발생시키는 부하 검사는 아니다.

실행 보고서는 `build/ios-host/results.json`에 남는다. fixture는 이전 보고서와
앱 상태가 결과에 섞이지 않도록 자신이 설치한 테스트 앱을 먼저 제거한다.
완료와 검사 실패 시 실행한 fixture 프로세스를 종료한다.

## 직접 WebSocket과 공통 모바일 브리지

WKWebView가 내장 Bun Worker의 `Bun.serve()`에 실제 연결했다. 별도의 ATS 예외 없이
iOS 26.5 Simulator에서 `ws://127.0.0.1`로 연결했고 Origin은
`bunaway://app.bunaway.local`이었다. 이는 다른 OS 버전이나 실기기 검증을 대신하지 않는다.

Swift는 문서와 일회용 연결 권한을 확인하고 공통 런타임이 토큰, Origin과 Host를 검사했다.
직접 연결 실행에서는 Swift로 전달된 SDK hello가 0개였고 WebSocket open을 확인했다.
fallback 실행에서는 브라우저 생성자를 의도적으로 실패시킨 뒤 Swift를 통한 SDK hello를 확인했다.
두 경로 모두 앞의 SDK와 문서 수명 검사를 통과했다. 보고서의 `transports`가 각 결과를 구분한다.
단위 검사에서는 최초 연결 실패, 연결 후 비정상 종료와 버퍼 초과, 재전송 방지 및 오래된
문서 알림을 검사한다. Bun Worker 계약 검사에서는 HTTPS 정책과 iOS 자산 Origin을
구분하고, 잘못된 출처의 연결 거부와 올바른 출처의 연결 및 권한 회수를 확인했다.

## 기기용 빌드

```sh
xcodebuild -project build/ios-host/app/ios/Bunaway.xcodeproj \
  -scheme Bunaway -configuration Debug -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/bunaway-ios-device-derived \
  CODE_SIGNING_ALLOWED=NO build
```

기기용 arm64 slice 선택과 Swift 컴파일, dylib 링크 및 앱 자산 복사가 통과했다.
이 결과는 실제 기기 설치, 실행이나 배포 서명 검증이 아니다.

## 계약과 문서 검사

`tests/cli/ios.test.ts`는 설정 거부, 사용자가 수정한 Swift/Xcode 파일 보존,
생성 영역의 링크 거부 및 실제 Bun에서 세 Worker 세대를 검사한다.
`tests/lifecycle/ios-bridge.test.ts`는 실제 bridge와 SDK transport의 nonce 격리,
한 번만 발생하는 닫힘과 캐시 복원의 재로드를 검사한다.
전체 `mise run check`와 문서 coverage, 타입, 빌드 및 내부 링크 검사를 실행했다.
문서 도구는 Node 22 이상이 필요해 설치된 Node 22.22.3을 선택했다.

최소 지원 OS인 iOS 16의 실행, 실기기와 배포 서명, App Store 제출,
background/foreground 전환과 renderer 프로세스 강제 재생성은 이번 실제 실행 검사에 포함하지 않았다.
Worker 재시작의 장시간 메모리 변화와 성능은 측정하지 않았다.

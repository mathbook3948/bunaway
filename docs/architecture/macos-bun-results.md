# macOS Bun FFI 전환 검증

기준일: 2026-10-10. Bun 1.4.2, macOS 26.7.1 arm64 로컬 GUI 세션에서 확인했다.
이 문서는 이전 [별도 프로세스 기록](./macos-native-results.md)과 구분한다.

## 실행 구조

`native/macos/bun/boot.ts`가 앱을 시작한다. AppKit와 WKWebView는 Bun FFI가
시스템 프레임워크와 Objective-C 런타임을 호출해 구성한다. 앱 코어는 같은 PID의
Bun Worker에서 실행한다. `.mm`, 사용자 정의 dylib와 C 컴파일러는 제품 빌드에 없다.

Objective-C의 tagged object는 64비트 bigint를 그대로 전달한다. arm64 NSRect는
네 double을 부동소수점 레지스터로 전달하는 ABI를 사용한다. WebKit completion과
탐색 결정은 Blocks ABI로 연결하며 delegate callback과 시스템 라이브러리는
프로세스 수명 동안 유지한다. 창 종료에서는 delegate를 분리하고 UI 객체를 해제한다.

## 검증 방법과 범위

```sh
mise run host:macos
mise exec -- zsh native/macos/bun/run.sh --app
mise exec -- bun test tests/lifecycle/macos-bun.test.ts
mise exec -- bun tests/lifecycle/macos-webview-regressions.ts
```

실제 WKWebView 회귀 7개가 통과했다. 공통 페이지에서 명령과 이벤트, 입력 오류,
정책 거부, 취소, History API의 세션 유지, 문서 교체와 구독 정리를 확인한다.
리소스 테스트는 서로 다른 포트의 실제 HTTP 서버로 script, image와 fetch의 허용과
차단을 확인한다. 개발 URL과 websocket 갱신, WebContent 종료 뒤 세션 재생성,
Bun 앱 강제 종료와 읽기 전용 자산에서의 시작도 확인했다.

`host-started`의 `hostPid`와 `backendPid`가 같은지, `guardPid`가 발급되는지 검사한다.
정상 종료에서는 Worker 정리와 실제 종료를 기다리고 `forced: false`를 요구한다.
ad-hoc 서명한 `.app`에서도 같은 회귀 7개가 통과했으며 배포 스크립트 검사 16개가 통과했다.
`mac-direct` hardened runtime 서명 후에도 실제 WKWebView 보고서와 정상 종료를 확인했다.
Worker 계약 테스트는 명령 결과, 세션 폐기, 종료 수신 확인과 플러그인 정리 파일을
실제 Bun Worker로 확인한다. macOS native 플러그인 권한은 백엔드 시작 전에 거부한다.

하위 프로세스 회귀는 백엔드에서 shell과 그 자식 `sleep`을 실행한다. 일반 실행과
`unref()` 실행, 플러그인 종료 훅의 무한 루프, 호스트 SIGKILL의 네 경로에서
하위 프로세스와 감시 프로세스가 남지 않고 다른 그룹의 프로세스는 유지되는지 확인했다.
정상 종료의 `activeProcesses: 0`은 그룹 정리 완료 후 기록하며,
`forced`는 실제 Worker 강제 종료 여부다. 앱이 새 세션이나 그룹으로 분리한
프로세스는 이 관리 범위에 포함하지 않는다.

추가 네이티브 회귀는 실제 창에서 최소 1200x700, 최대 1300x900과 초기 크기 보정,
제약의 `null`과 생략에 따른 제한 해제를 확인한다. 카메라와 마이크 거부는 설치된
`WKUIDelegate`에 네이티브 decision block을 전달해 한 번의 거부 결과를 확인하며,
실제 카메라와 마이크를 열지 않는다.

브리지에는 최상위 `Date`, 객체와 배열 내부의 `Date`를 전달해 네이티브 JSON 직렬화
전에 거부되는지 확인한다. 거부 뒤에도 같은 페이지의 정상 메시지가 수신된다.
UI 초기화 실패 회귀는 UI 의존성만 대체한 별도 프로세스에서 실제 Bun Worker를 사용한다.
UI 타이머가 없어도 비동기 플러그인 정리가 완료되고, 종료 훅의 무한 루프는 5초 기한
뒤 강제 종료되는지 확인한다. 제품의 프로세스 어댑터 번들링은 제거했으며, 이전 IPC
계약 검증용 번들링은 템플릿 테스트 안에서만 수행한다.

응답 전달은 UI 타이머 밖에서도 autorelease pool을 사용한다. 4KB payload를 가진
응답 4,000개씩 여섯 번, 총 24,000개를 페이지에 전달하고 매번 수신 완료를 기다린다.
첫 배치 이후 호스트 RSS는 160.0MB에서 192.3MB로 증가했으며 후반 배치에서는
증가 폭이 줄었다. 회귀 검사의 허용 증가량은 64MiB다. 이 결과는 해당 입력 규모의
객체 정리를 확인하며 다른 입력 규모나 처리량을 보장하지 않는다.
리소스 규칙은 앱과 뷰에 고정된 식별자를 사용한다. 런타임 세대를 바꿔 다시 창을
만들어도 저장된 규칙이 같은 식별자의 한 항목으로 유지되는지 확인한다.

UI는 5ms 타이머에서 비차단 run loop를 처리하며 한 번에 최대 64개 이벤트를 처리한다.
실제 GUI 회귀의 입력 규모와 시간은 `build/macos-host-results.json`에 기록한다.
idle 프로파일은 `mise exec -- bun scripts/macos-runloop-profile.ts`로 재현한다.
800x600 WKWebView 하나에서 500ms 준비 후 3초 동안 536개 turn을 관찰했다.
처리 간격 p50은 5.63ms, p95는 5.74ms, 최대는 11.12ms였고 해당 Bun 프로세스의
CPU 시간은 84.43ms였다. 단일 로컬 idle 측정이며 다른 입력 규모의 처리량이나
성능 향상을 의미하지 않는다. 이 타이머는
AppKit와 Bun의 이벤트 루프를 함께 진행하기 위한 비용이며 처리 간격의 보장은 아니다.

새 구현으로 GitHub Actions를 실행한 결과, 최소 macOS 버전과 Intel 실행 결과는 없다.
네이티브 저장 플러그인, 다중 창, `desktop`, Developer ID, 공증과 설치 검증도 남아 있다.

전체 검사 `mise run -t node@22.22.3 check`는 668개 통과, 플랫폼 조건 23개 건너뛰기와 실패 0개를 기록했다.
Windows 실제 GUI와 설치 도구 회귀는 이 macOS 실행에서 수행하지 않았다.
문서 타입 검사와 69페이지 렌더링, 내부 링크 5,880개 검사도 통과했다.

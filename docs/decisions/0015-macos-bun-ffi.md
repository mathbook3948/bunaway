---
status: accepted
---

# macOS도 Bun을 앱 진입점으로 사용하고 시스템 API를 직접 FFI로 호출한다

결정일: 2026-10-10

## 결정

[ADR 0010](./0010-windows-first-platform-model.md)의 macOS 전환을 구현한다.
Windows와 macOS 모두 앱 정의 하나를 프레임워크가 import하고 번들 Bun에서 실행한다.
macOS 제품 경로는 별도 C/ObjC++ 호스트, 사용자 정의 dylib나 C 컴파일러에 의존하지 않는다.
AppKit와 WKWebView는 시스템 Objective-C 런타임을 Bun FFI로 직접 호출한다.

AppKit는 메인 스레드가 필요하므로 UI를 Bun 메인 스레드에 두고 앱 백엔드는 같은
프로세스의 Bun Worker에서 실행한다. Windows의 UI Worker 배치를 그대로 복제하지 않는다.
메인 스레드는 5ms마다 비차단 CoreFoundation 처리와 최대 64개의 AppKit 이벤트를
처리하고 Bun 이벤트 루프에 제어를 돌려준다. 이 방식은 타이머 호출 비용을 가지며,
UI 처리 기한은 운영체제 스케줄링의 영향을 받는다. 측정과 재현 방법은
[실행 기록](../architecture/macos-bun-results.md)에 둔다.

Worker 연결의 검증, 수신 확인과 용량 제한, 뷰 세션 경계는 Windows와 공유한다.
종료 요청은 새 작업을 막고 세션과 코어를 정리한 뒤 Worker의 실제 종료를 확인한다.
5초 안에 Worker가 정리되지 않으면 Worker를 강제 종료하고 앱을 실패로 끝낸다.
별도 Bun 자식 프로세스와 guard는 생성하지 않는다.

배포 실행 파일은 `Contents/MacOS/bunaway-host`의 Bun compiled 실행 파일이다.
웹 자산, 정책과 무결성 목록은 `Contents/Resources`에 둔다. 실행 파일 이름은 기존
앱 번들 계약을 유지하며 별도 `Resources/runtime/bun`은 배포하지 않는다.
Bun JIT와 FFI 실행 메모리 권한은 앱 실행 파일에 서명한다.

현재 범위는 macOS arm64의 단일 창, 명령과 이벤트, 정책, 탐색, 리소스 경계,
렌더러 복구와 종료다. 다중 창, `desktop`과 네이티브 플러그인 어댑터는 후속 작업이다.
Developer ID, 공증과 스토어 제출 적합성은 별도 검증이 필요하다.

## 기존 결정과 기록

ADR 0001의 macOS 별도 프로세스 구조는 이 결정으로 대체한다.
POSIX 프로세스 probe와 이전 실행 기록은 실험 자료로 유지하며 제품 실행의 대안으로
선택하지 않는다. 기존 C/ObjC++ 제품 호스트와 전용 native 테스트는 삭제한다.

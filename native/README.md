# Native hosts

- `host-api/`: 호스트 호출·렌더러·생성된 정책의 네이티브 경계와 이전 C ABI 기록.
- `windows/`: Win32·WebView2 호스트.
- `macos/`: AppKit·WKWebView 호스트.
- `linux/`: GTK·WebKitGTK 호스트.
- `android/`: Kotlin 수명주기·WebView, Bun 실행·배포 경로 별도 검증.
- `ios/`: Swift 수명주기·WKWebView, Bun 실행·배포 경로 별도 검증.

Windows 호스트는 앱에 번들된 Bun을 자식 프로세스로 실행하고 전용 파이프로 통신한다.
`host-api/bunaway.h`와 [ABI 문서](../docs/architecture/native-abi.md)는 이전 동일 프로세스
설계의 기록이며 현행 런타임 연결에 사용하지 않는다. `host-api/generated/`의 공통
IPC·정책 JSON Schema는 계속 사용한다. 실제 호스트와 네이티브 검증기는 미구현이다.
[B 단계 계획](../docs/architecture/runtime-feasibility.md)을 참고한다. 언어·빌드 도구의 버전은
실제 호스트 구현과 함께 고정한다. 공통 TypeScript 코어는 이 디렉터리의 구현을
직접 import하지 않는다.

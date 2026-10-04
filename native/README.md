# Native hosts

- `host-api/`: 호스트 호출·렌더러·생성된 정책의 네이티브 경계와 이전 C ABI 기록.
- `windows/`: Win32·WebView2 제품 호스트와 WebView 없는 실험 호스트 구현.
- `macos/`: AppKit·WKWebView 호스트 예정 영역, 미구현.
- `linux/`: GTK·WebKitGTK 호스트 예정 영역, 미구현.
- `android/`: Kotlin 수명주기·WebView 예정 영역, 미구현. Bun 실행·배포 경로 미검증.
- `ios/`: Swift 수명주기·WKWebView 예정 영역, 미구현. Bun 실행·배포 경로 미검증.

Windows 호스트는 앱에 번들된 Bun을 자식 프로세스로 실행하고 전용 파이프로 통신한다.
`host-api/bunaway.h`와 [ABI 문서](../docs/architecture/native-abi.md)는 이전 동일 프로세스
설계의 기록이며 현행 런타임 연결에 사용하지 않는다. `host-api/generated/`의 공통
IPC·정책 JSON Schema는 계속 사용한다. `windows/probe/`에 WebView 없는 C++ 실험 호스트와
생성 스키마를 읽는 네이티브 검증기, Bun 백엔드와 빌드 스크립트를 구현했다.
[Windows B 결과](../docs/architecture/windows-probe-results.md)는 실험 호스트 기록이다.
`windows/host/`는 실제 SDK·코어·Host API를 연결한 제품 호스트다. origin·frame·세션·
정책·저장 범위와 메모 앱을 [Windows 단일 창/뷰에서 검증](../docs/architecture/windows-host-results.md)했다.
다중 창/뷰·다른 플랫폼·설치 프로그램·서명·배포는 이 결과에 포함하지 않는다.
[B 단계 계획](../docs/architecture/runtime-feasibility.md)을 참고한다. 언어·빌드 도구의 버전은
실행 결과에 기록한다. 공통 TypeScript 코어는 이 디렉터리의 구현을
직접 import하지 않는다.

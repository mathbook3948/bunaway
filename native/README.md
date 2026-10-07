# Native hosts

- `host-api/`: 호스트 호출, 렌더러, 생성된 정책의 네이티브 경계와 이전 C ABI 기록.
- `windows/`: Bun 직접 FFI Win32, WebView2 제품 호스트와 최소 FFI 실험.
- `macos/`: AppKit, WKWebView 단일 창/뷰 제품 호스트와 POSIX probe 구현(arm64).
- `linux/`: GTK, WebKitGTK 호스트 예정 영역, 미구현.
- `android/`: Kotlin 수명주기, WebView 예정 영역, 미구현. Bun 실행, 배포 경로 미검증.
- `ios/`: Swift 수명주기, WKWebView 예정 영역, 미구현. Bun 실행, 배포 경로 미검증.

Windows는 번들 Bun이 진입점이고 같은 프로세스의 UI Worker가 직접 FFI로 Win32,
WebView2를 소유한다. `windows/bun/`에서 실제 SDK, 코어, Host API, 정책, 파일 경계, 다중 창을
[검증](../docs/architecture/windows-bun-results.md)한다. 기존 Windows C++ 호스트, probe, CMake와
전용 실행기는 삭제했다. 공용 데이터는 `tests/fixtures/desktop/host/`에 있다.
`windows/ffi-probe/`는 직접 FFI 최소 실험이며 제품 진입점이 아니다.
`host-api/generated/`의 공통 IPC, 정책 JSON Schema는 macOS 등 프로세스 플랫폼이 사용한다.
macOS는 [별도 단일 창/뷰 검증](../docs/architecture/macos-native-results.md)과 native CI를 갖는다.
공유 Bun 캐시 초기화 때문에 macOS probe→host는 직렬 실행한다. `.app` 생성, ad-hoc 서명은
Developer ID, 공증, 설치 검증이 아니다. [플랫폼 지원 범위](../docs/platform-support/README.md)를 따른다.
[B 단계 계획](../docs/architecture/runtime-feasibility.md)을 참고한다. 언어, 빌드 도구의 버전은
실행 결과에 기록한다. 공통 TypeScript 코어는 이 디렉터리의 구현을
직접 import하지 않는다.

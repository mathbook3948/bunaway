# Native hosts

- `host-api/`: 호스트 호출·렌더러·C ABI와 생성된 정책의 네이티브 경계.
- `windows/`: Win32·WebView2 호스트.
- `macos/`: AppKit·WKWebView 호스트.
- `linux/`: GTK·WebKitGTK 호스트.
- `android/`: Kotlin 수명주기·WebView·JNI 연결.
- `ios/`: Swift 수명주기·WKWebView·C ABI 연결.

`host-api/bunaway.h`에 내부 C ABI 초안이 있고 `host-api/generated/`에는 공통 정의에서
생성한 IPC·정책 JSON Schema가 있다. 실제 호스트와 네이티브 검증기는 미구현이다.
[ABI 계약](../docs/architecture/native-abi.md)을 참고한다. 언어·빌드 도구의 버전은
실제 호스트 구현과 함께 고정한다. 공통 TypeScript 코어는 이 디렉터리의 구현을
직접 import하지 않는다.

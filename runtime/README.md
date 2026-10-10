# Bundled Bun

- `bun-bundle/`: 앱에 포함할 플랫폼별 Bun 실행 파일과 배포 자산 영역.
- `patches/`: 공식 배포물로 해결할 수 없어 실제로 필요한 경우의 패치.
- `build-manifests/`: 버전, 소스 revision, 배포 URL, 아카이브, 실행 파일 해시,
  OS, CPU, 라이선스와 필요한 경우의 빌드 정보.

Windows는 패키지의 Bun을 앱 진입점으로 실행하고 같은 프로세스의 UI Worker가 Win32와 WebView2를 소유한다.
macOS도 Bun이 앱 진입점이며 메인 스레드가 직접 FFI로 AppKit, WKWebView를 소유하고
같은 프로세스의 Worker가 앱 백엔드를 실행한다.
양쪽 모두 번들 Bun의 절대 경로를 사용하며 사용자의 별도 Bun 설치나 PATH에 의존하지 않는다.
현재 실행 구조는 [ADR 0010](../docs/decisions/0010-windows-first-platform-model.md)을 따른다.

mise의 Bun 1.4.2는 개발, 번들, 검사용 CLI다. 공식 Windows x64 baseline 1.4.2 실행 파일의
revision, 아카이브, 실행 파일, 라이선스 해시를 [manifest](./build-manifests/windows-x64.json)에
고정했다. 소스 패치는 없다. [Windows B 실험](../docs/architecture/windows-probe-results.md)에서
사용자 Bun이 없는 PATH, 한글, 공백 경로와 다른 cwd의 패키지 실행을 검증했다.

macOS arm64 공식 배포물은 [darwin-aarch64 manifest](./build-manifests/darwin-aarch64.json)에
같은 Bun 버전과 별도의 ZIP, 실행 파일, 라이선스 해시로 고정했다. macOS 제품 빌드는
고정 Bun의 실행 파일 해시와 버전을 검사해 compiled 앱을 만든다.
독립 프로세스 probe는 제거했으며 이전 실행 기록만 유지한다. Intel macOS 배포물/pin은 없다.
[macOS 실행 기록](../docs/architecture/macos-native-results.md)과
[플랫폼 지원 표](../docs/platform-support/README.md)를 참고한다.

이전 DLL 실험은 중단하고 실험용 코드, 소스 변경을 제거했다. 무시되는
`bun-embed/vendor/` 소스와 이전 실험 도구는 제품 의존성으로 사용하지 않는다.
현재 제품의 검증된 런타임 다운로드는 `build/cache/bun/`에서 관리한다.
[B 단계 계획](../docs/architecture/runtime-feasibility.md)을 따른다.

# Bun 런타임 내장 실현성

확인일: 2026-10-04 · 범위: PRD 단계 A 후보 정리와 단계 B 준비

이 기록은 공식 문서·고정 후보 링크와 현재 Windows 개발 도구를 확인한 결과다. 저장소를 내려받거나 설치·빌드하지 않았고, 앱 프로세스 내 Bun 실행이나 기기 실행은 검증하지 않았다. `bun run`이나 `bun build --compile` 성공은 네이티브 앱 내부에서 Bun VM을 실행했다는 증거가 아니다.

## 후보와 근거

| 후보와 고정 기준 | 이번에 확인한 사실 | 상태와 미확인 항목 |
| --- | --- | --- |
| 공식 Bun `bun-v1.4.0` 태그. PRD에는 Bun 소스 전체 SHA가 따로 고정돼 있지 않다. | [공식 릴리스](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.0)는 태그와 짧은 revision `34cbb9a`를 표시한다. [v1.4 발표](https://bun.com/blog/bun-v1.4#experimental-android-support)는 Android aarch64·x64 빌드를 experimental로 소개한다. [실행 파일 문서](https://bun.com/docs/bundler/executables)는 `--compile` 결과에 Bun 런타임을 포함하지만, 지원 타깃 표는 Windows·macOS·Linux다. | Android용 CLI 빌드와 데스크톱 독립 실행 파일의 근거다. 이 자료만으로 앱 프로세스 내 Android 실행, Windows 런타임 DLL, 공개 C embedding API는 확인되지 않는다. 태그의 전체 SHA와 빌드 재현성은 별도 고정해야 한다. |
| Android 참고 구현 `skal-multiplatform/skal@7edb44aceb8c69ac1abd76549e2c09cf6cdc8a57` | PRD는 이 커밋을 VM 큐·타이머 연결 후보로 들며 singleton, 빈 dispose 구현과 링크 설정도 기록한다. 이번 웹 확인에서는 [고정 소스 링크](https://github.com/skal-multiplatform/skal/tree/7edb44aceb8c69ac1abd76549e2c09cf6cdc8a57)를 열지 못했다. | SHA는 PRD의 후보 그대로 보존한다. 위 구현 세부는 이번에 독립 재확인하지 못한 PRD 기록이며, 코드 검토나 APK·기기 실행 증거로 취급하지 않는다. 의존성 채택 여부도 미결이다. |
| iOS 참고 구현 `dannote/bun@a3f7a71a950b81109c39a755dca3a018ea121e1c` | [고정 문서](https://github.com/dannote/bun/blob/a3f7a71a950b81109c39a755dca3a018ea121e1c/docs/guides/runtime/ios-embedding.mdx)는 정적 라이브러리와 `bun_start`·`bun_eval`·`bun_run` C API, 전용 스레드 실행을 설명한다. 같은 문서는 iOS 17+, Xcode/iOS SDK, CMake 3.20+, Zig 0.13+를 적고, JIT·FFI/TCC·프로세스 생성 제약을 든다. | 고정 커밋의 문서가 제시하는 접근 방식은 확인했다. 실제 코드 빌드, 시뮬레이터·기기 실행, 앱 수명주기, 서명·스토어 배포는 확인하지 않았다. 제3자 포크의 문서는 플랫폼 승인이나 유지보수 보증이 아니다. |
| Tauri 구조 비교 | [Tauri 아키텍처 문서](https://v2.tauri.app/concept/architecture/)는 웹 프런트엔드와 네이티브 백엔드를 분리하는 구조 참고 자료다. | Bun 내장 경로나 API 근거는 아니다. |

공식 Bun 자료에서 확인한 것은 Bun을 포함한 독립 실행 파일과 실험적 Android 빌드다. Windows 앱 안에서 같은 프로세스로 Bun VM을 시작하는 공식 C ABI는 이번에 확인한 문서에 나오지 않는다. 이는 확인한 문서 범위의 공백이며, Bun 전체 소스에 그런 내부 진입점이 없다는 증명은 아니다.

패치 후보는 아직 적용하거나 확정하지 않았다. Windows는 Bun 내부에서 호스트가 소유하는 `start`·작업 전달·`stop` C ABI를 노출할 수 있는지 최소 DLL 실험으로 판정한다. Android는 Skal 고정 커밋을 다시 읽은 뒤 JNI와 라이브러리 링크 경로, singleton·종료 처리만 실제 코드에서 패치 대상으로 확정한다. iOS는 고정 포크의 C ABI 문서와 실제 구현을 대조하고 종료·콜백 수명을 확인한다. 확인하지 못한 linker flag나 `dispose` 구현을 패치 요구사항으로 옮기지 않는다.

## 현재 Windows 도구

프로젝트의 `mise exec -- bun --version`은 `1.4.2`이고 이번 계약 검사는 이 런타임으로 실행했다.
기본 PATH의 Bun은 별도로 `1.3.9` (`cf6cdbbbadd50604bc17f21ed5d0612c920a5d9a`)가 있어
프로젝트 작업에는 직접 `bun` 명령을 사용하지 않는다. 둘 다 개발 CLI이며 내장 Bun 검증 결과가 아니다.
MSVC `14.50.35717`의 x64 `cl.exe`, Windows SDK `10.0.26100.0`, CMake `4.3.1`, Rust `1.94.0`
(`x86_64-pc-windows-msvc`), Java `17.0.12`도 확인했다. `cl.exe`는 Visual Studio Build Tools의
전체 경로에서 찾았고 기본 PATH에는 없다.

`zig`, `adb`, `sdkmanager`, `ndk-build`, `gradle`, `kotlinc`, `swift`, `xcodebuild` 명령은 찾지 못했다. 이 결과는 현재 PATH에서 실행 파일을 찾지 못했다는 뜻이며, Android SDK 전체가 없다는 뜻으로 확대하지 않는다. iOS 빌드와 Apple 시뮬레이터는 Xcode가 필요하므로 이 Windows 환경에서 수행할 수 없다.

## 가장 작은 Windows 내장 실험

첫 실험은 WebView 없는 Win32 x64 콘솔 호스트 하나로 제한한다. PRD의 Bun 후보를 전체 SHA로 고정한 뒤, 해당 소스에서 실험용 DLL과 최소 C ABI를 만든다. 호스트는 `LoadLibrary`/`GetProcAddress`로 DLL의 `start`, 비동기 `eval`/메시지 전달, `stop`만 호출하고 Bun VM은 전용 작업 스레드에서 실행한다. 별도 Bun 프로세스를 시작하는 코드는 넣지 않는다.

통과 증거는 네이티브 호스트 PID와 Bun 안의 `process.pid`가 같고, `2 + 2` 결과·Promise와 타이머 완료·JS 오류 전달·정상 종료를 받는 것이다. 실제 GUI를 붙이기 전에 DLL 링크 가능성, 재진입 없는 시작/종료, 콜백 수명만 본다. upstream 내부를 광범위하게 바꾸거나 프로세스 실행으로 우회해야만 성공한다면 그 비용을 단계 B의 차단 사유로 기록한다. 이 실험은 구현 제안이며 아직 수행하지 않았다.

## 모바일 실험에 필요한 조건과 공백

Android에서는 공식 Bun 1.4 Android 빌드를 CLI 기준선으로 삼을 수 있지만, 이를 Activity에서 실행하는 것으로 앱 프로세스 내장 조건을 통과하지 않는다. 최소 호스트는 Kotlin Activity와 JNI를 가진 앱이고, Bun C ABI 구현은 NDK로 빌드해 APK에 포함해야 한다. [Android NDK CMake 안내](https://developer.android.com/ndk/guides/cmake)는 NDK와 CMake를 통한 네이티브 라이브러리 빌드 흐름을 문서화한다. 개발·기기 확인에는 JDK, Android SDK/플랫폼 도구, NDK, Gradle과 ARM64 Android 기기가 필요하다. APK 안에서 JNI 호출로 런타임을 시작하고, Java와 Bun 양쪽 PID 일치 및 산술·비동기 작업·임시 파일·로그·오류 전달을 확인해야 한다. 현재 조사한 셸에서는 Java와 CMake만 확인했고 Android 명령 도구와 기기 실행은 확인하지 못했다. Skal 후보의 고정 소스 내용도 다시 열어 검증해야 한다.

iOS의 고정 포크 문서는 Xcode/iOS SDK 17+, CMake, Zig로 정적 라이브러리를 만들고 Swift에서 C API를 호출하는 경로를 제시한다. 최소 증거는 시뮬레이터 컴파일과 실제 iPhone 앱 프로세스 내 실행을 따로 남기는 것이다. 해당 문서의 interpreter-only, 파일 샌드박스, FFI/TCC·`spawn` 제약을 API 지원표에 반영해야 한다. 이 Windows 호스트에는 Xcode와 Zig가 발견되지 않아 iOS 빌드 준비가 되어 있지 않다. 소스 문서만으로 앱스토어 배포 가능성을 판단할 수 없다.

---
status: accepted
---

# Android Activity가 번들 Bun과 WebView의 수명을 소유한다

결정일: 2026-10-10

Android는 APK의 Activity에서 시작하므로 Java 호스트가 번들 Bun 자식 프로세스와
WebView를 소유한다. 앱 개발자는 [ADR 0010](./0010-windows-first-platform-model.md)의
공통 `app.ts`를 그대로 작성한다. 프레임워크가 기존 `runBunApp` 부팅 코드를 생성하고
Core, SDK와 프로세스 IPC 계약을 재사용한다. Windows의 Worker 배치를 Android에 복제하거나
앱 개발자에게 Android 전용 백엔드 진입점을 요구하지 않는다.

Android 10 이후 쓰기 가능한 앱 홈에서 실행 파일을 시작할 수 없으므로 공식 Android Bun을
APK의 `lib/<abi>/libbun.so`로 포함한다. 설치기가 추출한 읽기 전용 `nativeLibraryDir`에서
실행하고 앱 코드와 데이터는 사설 데이터 영역에 둔다. 현재는 공식 experimental Bun 1.4.2의
x64 baseline과 arm64 배포물을 고정한다. 자체 Bun VM 내장이나 JNI 포팅은 이 실행 검증에
필요하지 않아 도입하지 않는다.

`BunProcess`는 부팅, 프로토콜 협상, 파이프와 실제 프로세스 종료를 담당한다.
`Renderer`는 패키지 웹 자산, 출처, main frame과 문서 세션을 담당한다.
`BunawayActivity`는 두 소유자를 화면 수명주기에 연결한다. 화면 회전으로 Activity를
재생성할 때 Bun과 Core는 유지하고 기존 뷰 컨텍스트를 철회한 뒤 새 문서 세션을 연다.
Activity 종료는 shutdown과 실제 자식 종료를 요구하며 기한 초과에는 강제 종료한다.
앱 코드 실행 전에 `toybox setsid`로 별도 그룹을 만들고 PID, 부모, 그룹과 세션을 검증한
뒤 시작을 승인한다. 정상 Bun 종료와 기한 초과, 부팅 및 renderer 실패에서 상속된 그룹의
하위 프로세스를 정리하고 파이프를 닫는다. 별도 그룹이나 세션으로 분리한 자식의 수명은
앱이 소유한다. 그룹 정리는 파이프 읽기와 독립된 스레드에서 수행한다.
닫힌 Bun 세대에 새 Activity가 붙으면 ready 상태와 관계없이 오류 화면을 표시한다.
TMPDIR는 앱 cacheDir, HOME은 filesDir로 설정한다. 현재 여러 Activity의 동시 실행은
지원하지 않으며 기본 launchMode에서 각 인스턴스가 같은 백엔드 코드 경로를 쓸 수 있다.
백그라운드 서비스, 저메모리 종료 이후의 상태 복원은 현재 계약에 포함하지 않는다.

브리지는 AndroidX WebKit의 origin-matched listener와 document-start script를 사용한다.
발신 origin과 main frame은 네이티브 콜백에서 확인하며, 응답은 원래 문서에 결합된
reply proxy로 전달한다. Web 프로토콜과 호스트 전용 프로세스 envelope를 섞지 않는다.
네이티브 측 검증도 protocol 패키지가 생성한 JSON Schema와 제한을 사용한다.

첫 구현은 단일 뷰, 패키지 HTTPS 자산과 debug APK를 지원한다. 네이티브 권한이 있는
정책은 빌드와 부팅에서 거부하며 Host operation 요청은 `UNSUPPORTED`로 응답한다.
저장, 로그 등 선택 플러그인은 [ADR 0014](./0014-optional-plugin-packages.md)의
개별 Android 어댑터로 추가한다. 현재 기본 생성 템플릿의 저장 플러그인 동작을
Android 지원으로 간주하지 않는다. CLI는 `android sync`, `android build`, `android run`을 별도로 제공하며
기존 데스크톱 `build`, `dev`, 배포 채널은 유지한다.

## 앱이 소유하는 네이티브 프로젝트

`android sync`는 공통 앱 정의와 웹 UI를 번들하고 앱의 `android/`에 유지되는 Gradle
프로젝트를 만든다. 앱 모듈의 `MainActivity.java`는 Java `BunawayActivity`를 상속하며
앱이 Android 수명주기와 리소스를 직접 추가할 수 있다. 호스트 내부도 Java로 작성하고
초기 Gradle 설정은 Groovy를 사용한다. Kotlin 컴파일 플러그인은 적용하지 않는다.
백엔드 번들에는 JS 진입점과 파일 import 자산을 함께 보존한다. APK의 backend 트리를
상대 경로 그대로 앱 전용 실행 디렉터리에 추출해 원본 프로젝트 없이 읽을 수 있게 한다.

루트 빌드 설정, Wrapper와 `app/`은 최초에만 생성한다. 이후 sync는 프레임워크 library
모듈과 APK 입력이 있는 `android/.bunaway/`만 원자적으로 교체한다.
앱 모듈은 `.bunaway/app.gradle`, settings는 `.bunaway/settings.gradle`을 연결한다.
프레임워크의 내부 입력 경로, library 자산과 APK 패키징 요구는 관리 영역에 둔다.
프로젝트 표식은 `bunaway-project.json`의 `format: 1`이다.
사용자 소스, Manifest, Gradle 의존성과 로컬 SDK 경로는 보존한다. 기존의 무관한 Android 프로젝트와 생성 영역의
링크는 거부한다. CLI의 build와 run은 같은 sync를 먼저 실행하고 네이티브 프로젝트를 빌드한다.
IDE에서 Java만 수정한 경우 Gradle을 직접 실행할 수 있다. IDE 빌드와 sync의 동시 실행은
지원하지 않는다. 네이티브 플러그인의 TypeScript 호출 및 자동 등록은 별도 구현이 필요하다.

# Android 호스트

Java Activity와 Android WebView, APK에 포함한 Bun 1.4.2를 연결한다.
공통 `AppDefinition`, Core, Client SDK와 프로세스 IPC를 재사용한다.
구조와 소유권은 [ADR 0015](../../docs/decisions/0015-android-bundled-process-host.md)를 따른다.

| 파일 | 책임 |
| --- | --- |
| `host/src/main/java/dev/bunaway/host/BunProcess.java` | 부팅, 협상, 파이프 입출력, 정상 종료와 기한 초과 처리 |
| `FrameReader.java` | 프레임 크기를 먼저 제한하고 UTF-8 파이프 청크를 묶음으로 복사 |
| `Renderer.java` | 패키지 자산, 출처와 main frame 검사, 문서별 컨텍스트와 응답 |
| `BunawayActivity.java` | 화면 회전과 Activity 종료의 소유권 |
| `AppAssets.java`, `Protocol.java` | APK 입력과 생성된 스키마 검증 |
| `app/` | 사용자가 수정하는 Java Activity, Manifest와 Gradle 초기 템플릿 |
| `bridge.js` | 기존 기본 Client SDK가 사용하는 WebViewBridge 구현 |
| `../../packages/cli/src/native-build.ts` | 공통 Bun 도구로 Android x64, arm64 아카이브, 실행 파일과 라이선스 해시 검증 |
| `run.ts` | 공통 SDK fixture 빌드와 실제 기기 검사 |

`sync`는 최초에 앱의 `android/`에 루트 Gradle 파일과 Wrapper, `app/`을 생성한다.
프레임워크의 `host/`는 Android library 모듈로 `android/.bunaway/host/`에 복사하며
자산과 Bun, 생성 Java 상수는 `.bunaway/inputs/`에 둔다. 재동기화는 이 생성 영역만 교체한다.
앱 모듈에는 `.bunaway/app.gradle` 연결만 두고 SDK 기본값, applicationId와 APK 패키징은
관리 스크립트로 옮긴다. assets, jniLibs와 res는 library 호스트가 소유하며 APK에 병합된다.
settings도 `.bunaway/settings.gradle`을 연결해 내부 호스트 경로를 앱 파일에 복제하지 않는다.
프로젝트 표식은 `bunaway-project.json`의 `format: 1`이다.
앱 모듈과 루트 Gradle 파일, Wrapper, `local.properties`는 앱 소유이며 덮어쓰지 않는다.
초기 Gradle 파일은 Groovy이며 Kotlin 컴파일 플러그인을 적용하지 않는다.

Java 소스는 `mise run format:java`로 포맷하며 `mise run check`가 포맷을 검사한다.

## 실제 실행 검사

Windows, mise Bun 1.4.2, JDK 17 이상, Android SDK API 36과 Build Tools 36.1.0이 필요하다.
`ANDROID_HOME`, `JAVA_HOME`을 설정하고 선택한 기기를 먼저 부팅하거나 연결한다.
표준 Gradle Wrapper는 8.14.3이며 공식 배포 SHA-256을 고정한다.
Android Gradle Plugin 8.13.2, WebKit 1.14.0과 Gson 2.13.2를 사용한다.
JSON 파서는 strict 모드이며 프로토콜 검증을 우회하는 관대한 JSON 구문을 허용하지 않는다.
AppAssets는 application context로 한 번 읽어 Bun과 회전 후 Activity가 공유한다.
WebView는 현재 Activity context를 사용하며 기능 지원은 초기화 때 검사한다.
백엔드 ready 이후에 WebView를 생성하고 문서를 로드한다. 생성이나 부팅이 실패하면
두 소유자를 함께 닫는다.
들어온 IPC는 중첩 웹 메시지까지 한 번 파싱하고 검증한다. 호스트가 만든 송신 객체는
스키마, 크기와 깊이, Unicode를 검사해 직렬화하며 JSON을 다시 파싱하지 않는다.
수신 청크는 줄바꿈 사이의 바이트를 묶음으로 복사한다. 복사 전에 공유 프레임 크기 제한을
검사하며 잘못된 UTF-8과 미완성 EOF를 거부한다. 프레임별 UI 전달 완료를 기다려
백엔드가 보낸 응답이나 이벤트가 UI 큐에 무한히 쌓이지 않도록 한다.

```powershell
$env:ANDROID_SERIAL = 'emulator-5554'
mise run host:android
```

명령, 이벤트와 구독 해제, 오류와 정책 거부, 취소, 자산 경계와 subframe 거부를 검사한다.
큰 한글 및 이모지 응답이 여러 파이프 청크를 거쳐도 원문 그대로 도착하는지 검사한다.
화면 회전으로 문서 세션이 바뀌어도 Bun PID와 Core 상태가 유지되는지 확인하고,
뒤로가기로 Activity를 닫은 뒤 Bun PID가 사라지는지 검사한다.
검사는 기기 회전 설정을 원래 값으로 복원하고 fixture 앱을 종료한다.
런처 MAIN/LAUNCHER intent에서 뒤로가기 종료를 확인하고, renderer 실패 뒤 화면 회전이
닫힌 런타임에 WebView를 연결하지 않는지 검사한다. TMPDIR는 cacheDir, HOME은 filesDir이며
실제 `os.tmpdir()`의 파일 생성, 읽기와 제거를 검사한다.
APK와 실행 보고서는 `build/android-host/`에 남는다. Java 스키마 단위 검사와 Android lint도 실행한다.

앱 개발용 명령과 현재 제약은 [Android CLI 문서](../../docs/site/src/content/docs/reference/cli/android.mdx)에 있다.
Android 최소 API 29는 선언이며 현재 실제 실행 근거는 API 36 x86_64 에뮬레이터다.
ARM64 런타임은 APK에 포함하고 해시를 검사했지만 실기기 실행은 별도 검증이 필요하다.
release APK, AAB, 스토어, 외부 개발 서버와 네이티브 플러그인 어댑터는 미구현이다.

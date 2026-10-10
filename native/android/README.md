# Android 호스트

Java Activity와 Android WebView, APK에 포함한 Bun 1.4.2를 연결한다.
공통 `AppDefinition`, Core, Client SDK와 프로세스 IPC를 재사용한다.
구조와 소유권은 [ADR 0015](../../docs/decisions/0015-android-bundled-process-host.md)를 따른다.

| 파일 | 책임 |
| --- | --- |
| `host/src/main/java/dev/bunaway/host/BunProcess.java` | 부팅, 협상, 파이프 입출력, 정상 종료와 기한 초과 처리 |
| `FrameReader.java` | 프레임 크기를 먼저 제한하고 UTF-8 파이프 청크를 묶음으로 복사 |
| `FrameDispatcher.java` | 읽기 스레드의 순차 전달과 독립된 완료 기한 감시 |
| `WebViewChannel.java` | fallback 문서 전용 MessagePort의 입력, 응답과 회수 |
| `ProcessGroup.java` | 앱 코드 실행 전 그룹 격리, 시작 취소와 종료 후 자손 정리, 파이프 해제 |
| `Renderer.java` | 패키지 자산, 출처와 main frame 검사, 문서별 컨텍스트와 응답 |
| `WebViewSession.java` | 문서별 hello 상태, 입력 방향 검사와 대기 중 요청 취소 |
| `BunawayActivity.java` | 화면 회전과 Activity 종료의 소유권 |
| `AppAssets.java`, `Protocol.java` | APK 입력과 생성된 스키마 검증 |
| `BackendAssets.java` | 시작 전 백엔드 추출 트리 교체와 이전 APK 파일 정리 |
| `app/` | 사용자가 수정하는 Java Activity, Manifest와 Gradle 초기 템플릿 |
| `bridge.js` | 기존 기본 Client SDK가 사용하는 WebViewBridge 구현 |
| `../../packages/runtime-bun/src/loopback-channel.ts` | 일회용 문서 연결, 입력 검증과 순서, 크기 제한 및 회수 |
| `host/src/main/res/xml/bunaway_network_security.xml` | IPv4 loopback 연결만 cleartext 허용 |
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
RPC 변경과 비교 측정은 [성능 기록](../../docs/architecture/android-rpc-performance.md)에 정리했다.

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
시스템 뒤로가기는 Activity를 명시적으로 종료한다. Android 13 이상은 시스템 Back 콜백을,
이전 버전은 `onBackPressed`를 사용한다. 홈 버튼은 종료로 처리하지 않는다.
기본 앱 메시지는 WebView에서 `127.0.0.1`의 Bun WebSocket으로 직접 보낸다.
Java가 확인한 main frame과 origin에만 일회용 주소를 전달하며, Bun은 정확한 Origin과
Host를 검사하고 토큰을 한 번만 사용한다. 제어 파이프에서 연 Core 세션에 연결하므로
SDK의 계약과 Core의 정책, 입력 및 출력 검증은 그대로 적용된다. 문서 교체 시 Java가
기존 세션과 연결을 회수하고 프로세스 종료 시 listener를 닫는다. 연결하지 않은 주소는
10초 뒤 만료한다. 이미 연결된 문서에서 SDK를 나중에 초기화하는 것은 허용한다.
입력은 1MiB와 대기 128개, 양쪽 출력 버퍼는 각각 2MiB로 제한하며 초과 시 세션을 닫는다.
압축이나 묶음 전송은 사용하지 않는다. 연결 실패는 SDK의 진행 중 호출에도 전달한다.
직접 연결의 비정상 종료, 입력 위반과 송수신 버퍼 초과는 해당 문서의 연결과 Core 세션만
닫고 요청과 구독을 정리한다. Bun 프로세스, 앱 상태와 다른 세션은 유지한다.
자동 재연결은 하지 않으며 새 문서를 열면 새 권한과 세션으로 연결한다.
호스트 제어 파이프의 EOF나 잘못된 제어 프레임, 세션 정리 자체의 실패는 런타임 전체 실패로
처리한다. Android가 보고한 renderer 프로세스 종료와 기존 Java 브리지의 잘못된 입력도
기존 Activity 실패 처리를 유지한다. WebSocket의 비정상 종료만으로 이 경로에 들어가지는 않는다.

호스트 library는 INTERNET 권한과 loopback 전용 network security 설정을 포함한다.
앱이 loopback 연결을 금지하거나 Bun listener를 시작할 수 없으면 아래 MessagePort 경로를
사용한다. 직접 연결을 선택한 뒤 발생한 실패는 세션을 닫으며 요청을 다시 보내지 않는다.
앱 소유 설정의 변경 방법은 [Android CLI 문서](../../docs/site/src/content/docs/reference/cli/android.mdx)를 따른다.

fallback 경로의 IPC는 읽기 스레드에서 중첩 웹 메시지까지 파싱하고 검증하며 WebView에 보낼
payload 원문을 잘라 전달한다. UI에서 출처와 main frame을 확인한 최초 요청으로 문서 전용
MessagePort를 연결한다. 문서별 nonce로 이전 문서에 대한 포트 전달을 거부하고,
포트 입력은 전용 callback 스레드에서 기존 쓰기 큐에 넣는다. 쓰기 스레드가 순서대로
JSON, UTF-8 크기, 스키마, 방향과 최초 hello를
검사하고 호스트 소유 envelope에 넣는다. 화면 전환과 종료는 이전 문서를 즉시 취소하므로
아직 시작하지 않은 요청은 파싱 없이 버린다. 유효한 hello 전이나 문서 종료 후에는
응답을 전달하지 않는다. 검증한 트리와 원문을 함께 보관하며 envelope의 전체 스키마,
추가 중첩 깊이와 UTF-8 크기를 확인하되 payload를 다시 순회하거나 직렬화하지 않는다.
JSON Lines 전달 전에 토큰 사이의 CR과 LF를 제거하며 문자열 안의 이스케이프는 보존한다.
다른 송신 객체는 쓰기 스레드에서 검증하고 직렬화한다. 읽기 스레드는 검증한 응답을
현재 문서의 MessagePort로 직접 보낸다. 포트 API를 지원하지 않는 WebView에서는
기존 UI 스레드의 reply proxy 경로를 사용한다. 문서 교체와 종료 시 양쪽 포트를 닫는다.
수신 청크 안에 프레임이 완성되면 중간 복사 없이 디코딩하고, 나뉜 프레임만 묶음으로 복사한다.
복사 전에 공유 프레임 크기 제한을
검사하며 잘못된 UTF-8과 미완성 EOF를 거부한다. 제어 프레임은 UI 적용이 끝나야
다음 프레임을 처리하므로 응답이 ready나 fatal을 앞지르지 않는다. 전달은 기존 협상
제한 시간 안에 끝나야 한다. 별도 타이머가 추가 입력이 없어도 기한 초과를 감지한다.
완료한 호출마다 타이머를 취소하고 생성하지 않고 가장 오래된 미완료 기한을 따라간다.
유휴 상태에서는 남은 타이머가 한 번 만료된 뒤 사라지며 종료 시 즉시 해제한다.
Android 브리지는 SDK가 사용하는 내부 텍스트 채널을 제공한다. SDK에서 JSON을 객체로
바꿨다가 브리지에서 다시 문자열로 만드는 과정을 없앴으며, 기존 structured-value
브리지 메서드와 이전 SDK의 연결 방식은 유지한다.

```powershell
$env:ANDROID_SERIAL = 'emulator-5554'
mise run host:android
```

명령, 이벤트와 구독 해제, 오류와 정책 거부, 취소, 자산 경계와 subframe 거부를 검사한다.
큰 한글 및 이모지 응답이 원문 그대로 도착하는지 검사한다.
WebView의 localStorage와 sessionStorage에 값을 저장하고 읽은 뒤 제거하는지도 검사한다.
화면 회전으로 문서 세션이 바뀌어도 Bun PID와 Core 상태가 유지되는지 확인하고,
뒤로가기로 Activity를 닫은 뒤 Bun PID가 사라지는지 검사한다.
백엔드의 파일 import를 APK에서 추출한 뒤 읽고, 번들에서 만든 자식과 손자 프로세스가
화면 회전 동안 유지되며 뒤로가기와 renderer 실패 후 모두 사라지는지도 검사한다.
검사는 기기 회전 설정을 원래 값으로 복원하고 fixture 앱을 종료한다.
홈 런처의 앱 아이콘을 눌러 실행하고 호출 주체와 root task를 확인한다. 홈 이동 후 복귀와
뒤로가기 종료를 구분해 검사하며, renderer 실패 뒤 화면 회전이
닫힌 런타임에 WebView를 연결하지 않는지 검사한다. TMPDIR는 cacheDir, HOME은 filesDir이며
실제 `os.tmpdir()`의 파일 생성, 읽기와 제거를 검사한다.
APK와 실행 보고서는 `build/android-host/`에 남는다. Java 스키마 단위 검사와 Android lint도 실행한다.

앱 개발용 명령과 현재 제약은 [Android CLI 문서](../../docs/site/src/content/docs/reference/cli/android.mdx)에 있다.
Android 최소 API 29는 선언이며 현재 실제 실행 근거는 API 36 x86_64 에뮬레이터다.
ARM64 런타임은 APK에 포함하고 해시를 검사했지만 실기기 실행은 별도 검증이 필요하다.
release APK, AAB, 스토어, 외부 개발 서버와 네이티브 플러그인 어댑터는 미구현이다.

백엔드를 시작할 때 `noBackupFilesDir/bunaway-runtime/`의 이전 추출 트리를 지운 뒤
현재 APK의 번들과 파일 import, Bun 설정을 다시 추출한다. 제거하거나 해시가 바뀐 파일은
남지 않는다. 기존 트리의 심볼릭 링크는 대상 파일을 따라가지 않고 링크만 제거한다.
이 디렉터리는 프레임워크 입력 전용이며 앱 데이터는 filesDir 등 별도 디렉터리에 저장한다.
추출이 실패하면 Bun을 시작하지 않으며 다음 시작에서 불완전한 트리를 지우고 다시 시도한다.

`toybox setsid`로 Android 호스트와 다른 세션 및 프로세스 그룹을 만든다. 셸은 PID를
알린 뒤 호스트의 시작 승인을 기다리므로, 그룹 검증 전이나 시작 취소 후에는 앱 코드를
실행하지 않는다. 정상 Bun 종료 후에도 그룹을 정리하며 종료 기한 초과와 실패에서는
그룹 전체에 SIGKILL을 보낸다. 정리는 파이프 I/O와 독립된 스레드에서 수행하고 살아 있는
그룹 구성원이 사라진 뒤 파이프를 닫는다. 별도 그룹이나 세션으로 분리한 자식은 앱이
직접 종료해야 한다. `lifecycle/android-process-group.test.ts`는 Linux와 JDK 17 이상에서
같은 Java 소유자로 시작 취소, 정상 종료, 실패와 강제 종료, 손자 정리와 다른 그룹의 보존을
검사한다. 이 계약 검사는 Android 기기의 실행 검증과 구분한다.

# Android 단일 뷰 호스트 실행 결과

검증일: 2026-10-10. Windows에서 APK를 빌드하고 기존 Pixel 8, Android 16 API 36
x86_64 에뮬레이터에서 실행했다. Android용 공식 Bun 1.4.2는 experimental 배포물이며
두 ABI의 아카이브, 실행 파일과 라이선스 핀은 `runtime/build-manifests/android-*.json`에 있다.

검증 명령은 `ANDROID_HOME`, `JAVA_HOME`, `ANDROID_SERIAL`을 설정한 뒤
`mise run host:android`다. 재현 경로와 소유권은 [Android README](../../native/android/README.md)와
[ADR 0015](../decisions/0015-android-bundled-process-host.md)를 따른다.
앱 개발자의 앱 정의는 `tests/fixtures/android/app.ts`이며, 프레임워크가 기존
`runBunApp` 진입점을 생성해 Core와 연결한다. UI는 기존 기본 Client SDK를 사용한다.

| 검사 | 관찰 결과 |
| --- | --- |
| APK 실행 | 설치기가 추출한 libbun.so를 앱 자식으로 실행. 기기의 ps에서 PID와 부모 관계 확인 |
| 공통 SDK와 Core | hello, 명령 응답과 상태 변경, 이벤트 및 구독 해제 |
| 실패와 취소 | 정책 밖 명령 PERMISSION_DENIED, 예상 밖 예외 INTERNAL, UI 취소가 backend에 도착 |
| 웹 자산 | backend.js와 host.json 접근 실패, 패키지 origin 밖 네트워크 차단 |
| subframe | 같은 origin의 iframe이 호스트 전용 shutdown을 시도해도 main 문서와 Core 유지 |
| 화면 회전 | 문서 재생성 뒤 같은 Bun PID에서 Core 카운터 2가 유지되고 다음 호출로 4가 됨 |
| renderer 실패 뒤 회전 | 준비된 Core에서 잘못된 WebView 메시지로 실패를 만든 뒤 회전. 닫힌 Bun에 WebView를 붙이지 않고 오류 화면 유지 |
| 런타임 환경 | TMPDIR=cacheDir, HOME=filesDir. os.tmpdir()에서 임시 파일 생성, 읽기와 제거 성공 |
| Activity 종료 | 뒤로가기로 화면을 닫은 뒤 Bun PID가 사라짐 |
| 스키마 | 생성된 message schema를 Java에서 검사. 잘못된 JSON, 추가 필드, envelope 위장, 크기와 깊이, Unicode 거부 |

빌드 및 실제 결과는 `build/android-host/result.json`과 Android Gradle의 단위 검사,
lint 보고서에 생성된다. 호스트는 Java이며 앱 모듈은 별도 library 호스트에 의존한다.
Windows Job으로 관리한 빌드 도구는 종료 후 자식 정리 완료를 요구한다.
Gradle의 프로토콜 단위 검사와 lint를 통과했다.
경고는 WebView 기능 검사 인식, 의존성 갱신, 백업 규칙과 앱 아이콘에 관한 것이다.
별도로 framework tarball을 설치한 독립 프로젝트의 `android build`와 설치 파일 무결성
재검증을 통과했고, 그 APK에서도 같은 기기 수명주기 검사를 통과했다.

Java 전환 뒤 같은 기기의 Core/SDK, 화면 회전과 종료 검사를 다시 통과했다.
독립 CLI 설치 앱에서 SDK/JDK 환경 변수 없이 `android sync`를 두 번 실행하고
앱의 `MainActivity.java`와 Gradle 수정이 보존되는지 확인했다. 이어서 `android build`로
만든 APK에서 추가한 Java `onCreate` 코드가 실제로 실행됐고 기존 수명주기 검사도 통과했다.
프레임워크 설치 입력의 무결성 재검증을 통과했다. 보고서는 `build/android-sync-check/`에 남는다.
동기화한 프로젝트는 CLI 전용 빌드 인자 없이 일반 Gradle로도 debug APK와 Java 단위 검사를 통과했다.

앱 Gradle 파일은 관리 스크립트만 연결한다. library 호스트의 웹 자산, 리소스와
두 ABI의 Bun을 APK로 병합한 뒤 같은 Core/SDK 검사를 통과했다.
APK에서 추출한 두 ABI의 Bun SHA-256은 원본 런타임 핀과 일치했다.
뒤로가기 검사는 `am start -n` 대신 `monkey -p dev.bunaway.fixture -c android.intent.category.LAUNCHER 1`로
시작한다. API 36에서 MAIN/LAUNCHER intent와 rootOfTask=true를 확인했고 뒤로가기 후 Bun PID가
사라졌다. 이 결과를 다른 Android 버전의 뒤로가기 정책으로 일반화하지 않는다.

Windows에서 생성 디렉터리를 게시하는 rename이 간헐적으로 `EPERM`으로 실패했다.
이 경우 이전 생성 영역은 복구됐으며 동일 규모의 복사 및 이동에서도 오류를 재현했다.
잠금 소유 프로세스는 확인하지 못했다. 이후 빌드 성공은 원인 해결을 뜻하지 않으며
재시도를 근본 해결로 추가하지 않았다.

현재 실제 실행 근거는 x86_64 API 36이다. ARM64는 공식 런타임의 해시 검증과 APK 포함만
확인했고 실기기에서 실행하지 않았다. 최소 API 29는 선언이며 해당 OS에서 검증하지 않았다.
선택 네이티브 플러그인, 외부 UI 개발 서버, WebView 장애 복구, 저메모리나 백그라운드 종료
이후 상태 복원, release APK/AAB와 Store 배포는 이 실행 결과에 포함하지 않는다.

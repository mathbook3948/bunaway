# Tests

초기 `maximized`와 `fullscreen`은 `windows-bun-window-api.ts`에서 일반 복원 영역과
표시 상태를 검사합니다. 이 실행기는 실제 WebView2와 WinEvent를 사용하는 숨김 준비 fixture도
네 옵션 조합으로 실행하므로 `mise run host:windows`에서 일시적인 표시와 활성화, 포커스를 검사합니다.
실제 다중 물리 모니터와 혼합 DPI 수동 검증을 대신하지 않습니다.

`api/webview-print-ui.test.ts`는 인쇄 UI의 개별 권한, browser 기본값과 system 선택,
경로와 silent 입력 거부, 취소와 닫힌 창 및 플랫폼 서비스 부재를 확인한다.
`lifecycle/windows-webview-print-ui.ts`는 `mise run host:windows`에서 실제 Win32와
WebView2 문서에 browser 인쇄 UI를 요청하고 반복 요청 및 종료 뒤 native 자원 정리를
확인한다. 실제 COM ABI의 E_NOINTERFACE도 optional 조회와 required 조회로 구분한다.
결과는 `build/windows-webview-print-ui-results.json`에 기록한다.
system UI 사용자 선택과 물리 프린터 출력은 별도 검증이며 테스트가 인쇄 제출을 하지 않는다.

`lifecycle/macos-log-capabilities.test.ts`는 생성한 macOS export와 실제 임시 파일로
JSON 줄의 순서와 출처, 새 파일 권한, 반복 회전, 기록과 회전 실패 후 복구,
입력과 작업 권한, 폐기 및 호스트가 정한 지원 목록을 검사한다.
`macos-log-capabilities-compiled.test.ts`는 현재 OS에서 macOS 어댑터 probe를 Bun으로
compile하고 원본 파일을 제거한 뒤 실행한다. 실제 macOS native CI에도 포함하며
호스트의 전체 실행 경로를 대신하지 않는다.
`macos-log-capabilities.ts`는 ad-hoc 서명한 compiled 앱과 실제 WKWebView에서 백엔드 및
뷰 기록, 권한 거부, 쓰기 실패 후 복구, 회전, manifest의 등록한 작업과 기능 목록의 일치
및 정상 종료를 검사한다. `run-native.ts`에 포함하며 결과와 앱 데이터 진단은
`build/macos-log-capabilities-results.json`과 `build/macos-log-capabilities-diagnostics/`에 남긴다.
앱과 화면의 코드는 `fixtures/macos-log-capabilities/`의 타입 검사 대상이며 실행 전
정책 권한 이름도 실제 설치된 플러그인 계약으로 검사한다.

다운로드 UI-loop regression은 생성된 worker 경계에서 전용 `windows-download-cleanup/ui.ts`를
번들하고 실제 승인 transfer의 cancel 자원만 일시적으로 실패시킨다. 소유 창을 닫는 동안
다른 창의 SDK 응답과 세 번째 창의 native cleanup이 진행하고, 소유자의 재시도도 복구되는지
확인한다. 운영 worker와 다른 테스트 프로세스는 주입하지 않는다. 순수 모델은 조절한 시계로
재시도 간격과 기한, 자원 보존을 검증하고 cancelled snapshot의 interruptReason을 검사한다.

다운로드의 실패 regression은 metadata 조회 실패와 native Cancel 실패를 독립적으로
주입해 취소 재시도와 cleanup의 소유권을 확인한다. 브라우저 UI 재개 뒤 paused 상태,
JSON escape와 UTF-8 metadata 한도, 만료 retained 항목의 aggregate 예산 및 최대 식별자의
실제 protocol response 직렬화도 검증한다.

`api/webview-downloads.test.ts`는 Zod 계약, 개별 작업 권한과 backend 출처 검사를 확인한다.
renderer에 모든 다운로드 권한을 허용해도 작업이 실행되지 않으며 호출자가 임의 저장 경로를
전달할 수 없는지 검사한다. `lifecycle/downloads.test.ts`는 pending 승인 기한, 상한과 슬롯 회수,
탐색 시 pending 거부, 승인된 작업의 수명, pause/resume과 종료 기록 및 실패 시 자원 정리를 확인한다.
`lifecycle/windows-webview-downloads.ts`는 `mise run host:windows`에서 실제 UI Worker와
WebView2 다운로드를 실행한다. 기본 거부, renderer 권한 거부, 항목별 승인과 거부, 실제 파일
내용과 byte 진행, pause/resume/cancel, 승인 기한, 탐색 및 종료 시 pending 정리를 검증한다.
승인된 전송과 pending 요청이 함께 있는 브라우저를 종료해 죽은 broker에 작업을 보내지 않고
COM 참조, timer와 창 자원을 정리하는지도 확인한다.
기존 multiple-automatic-downloads 권한 거부를 유지하며 제어 시나리오는 새 WebView에서
첫 다운로드로 실행한다. 마지막 장애 검사는 같은 뷰의 두 창이 공유하는 browser 프로세스에서
승인된 전송과 pending 요청을 각각 유지한다. 자동 다운로드 권한을 허용하는 검증이 아니다.
테스트가 기록한 고유한 브라우저 기본 경로의 파일만 지운다. 사용자 지정 경로, 물리 다운로드 UI
조작이나 앱 재실행 후 재개 검증은 포함하지 않는다. 결과는
`build/windows-webview-downloads-results.json`에 기록한다.


`api/webview-controls.test.ts`는 기본 WebView 제어의 Zod 입력과 출력, 개별 작업 권한,
닫힌 창과 취소, multiple 뷰의 ID 선택, 플랫폼 서비스 부재 및 네이티브 오류 전파를 검사한다.
`lifecycle/windows-webview-controls.ts`는 `mise run host:windows`에서 실제 UI Worker와
WebView2를 실행한다. URL과 제목, history, reload와 stop, 허용하지 않은 origin 및 redirect,
탐색에 따른 진행 중 명령 취소, 같은 문서 fragment의 세션 유지, zoom 조회와 적용 및
개발 모드 DevTools 열기와 프로덕션 거부를 확인한다. DevTools의 물리 조작과 paint,
실제 모니터 및 하드웨어 검증은 포함하지 않는다. 결과는
`build/windows-webview-controls-results.json`에 기록한다.
`api/webview-audio.test.ts`는 audio 작업의 개별 권한, 엄격한 boolean 입력, 음소거와 재생의
독립 상태, 취소와 닫힌 창 및 플랫폼 서비스 부재를 검증한다.
`lifecycle/windows-webview-audio.ts`는 `mise run host:windows`에서 실제 WebView2의 음소거
변경과 반복 설정, 문서 탐색 뒤 유지, 준비 전과 종료 후 거부 및 native 자원 정리를 확인한다.
결과는 `build/windows-webview-audio-results.json`이다. 조용한 문서를 사용하며 재생 중인
audio와 물리 장치 출력은 별도 수동 검증이다.

`api/window-taskbar.test.ts`는 작업 표시줄 진행률의 상태별 입력, 출력, SDK 호출 컨텍스트,
독립 작업 권한, 취소, 닫힌 창과 미지원 플랫폼을 검사한다.
`lifecycle/taskbar-progress.test.ts`는 버튼 준비, 마지막 성공 값의 복원, 실패 후 재시도,
서로 다른 HWND와 파괴 후 핸들 재사용을 검사한다. 버튼 재생성은 합성 호출이다.
`windows-bun-window-api.ts`는 실제 UI Worker와 WebView2에서 공개 SDK를 통해
ITaskbarList3의 다섯 상태를 설정한다. 네이티브 재생성 뒤 새 HWND에서도 반복한다.
`mise run host:windows`에 포함하며 실제 작업 표시줄의 색상, 그룹 표시 또는
Explorer 프로세스 재시작을 육안으로 검증하지 않는다.

`api/notification.test.ts`는 알림 상태 조회와 Windows 설정 열기의 독립 권한,
Zod 계약, SDK 컨텍스트와 취소, WinRT 실패 경계와 자원 정리를 검사한다.
`lifecycle/windows-notification.test.ts`는 별도 프로세스에서 누락된 앱 등록 오류를 확인한다.
등록된 조회는 격리된 프로세스에 UUID 시작 메뉴 바로가기와 process AppUserModelID를 설정한
뒤 fixture 전용 popup 억제/15초 만료 알림으로 OS 상태를 초기화한다. 엄격한 WinRT projection
getter와 FFI 값을 비교하며 고유 tag/group의 임시 알림은 finally에서 history 제거와 빈 상태를
검사한다. 바로가기도 실패 때 정리한다. 실제 I/O Worker의 승인, 거부, 취소, opener STA 공존과
종료도 확인한다. 공개 getStatus는 이런 알림을 보내거나 상태를 초기화하지 않는다.
상태 조회 회귀는 `mise run host:windows`에도 포함한다. Windows 설정 열기 접수는
폐기 가능한 데스크톱에서 `BUNAWAY_NOTIFICATION_SETTINGS_NATIVE=1`을 지정한 선택 검사다.
기본 CI는 실제 설정 페이지 표시나 사용자 차단 상태 변경, toast 표시를 검증하지 않는다.
[notification README](../plugins/notification/README.md)의 실행 명령과 남은 검증 범위를 따른다.

`windows-initial-placement.fixture.ts`는 모니터 겹침이 바뀌는 `SetWindowPos`에서
실제 창 프로시저에 `WM_DPICHANGED`를 전달한다. 초기 DPI 보정의 수렴, 중앙 좌표와
content/outer 크기, DPI 순환 때 숨김 HWND 정리 및 생성 후 OS 권장 배치 처리를 검증한다.
기본 tracking 크기 보정도 재현해 큰 창의 중앙 배치와 작은 작업 영역의 overflow,
생성 이후 제한 복원 및 실제 rectangle 불일치 때 정리를 확인한다.
합성 모니터 검증이며 실제 다중 모니터 실행을 대신하지 않는다.

`mise run check`와 플랫폼 검사는 먼저 `plugins:build`를 실행해 중립 공개 출력과 OS별
호스트 출력을 생성한다. `cli/plugin-build.test.ts`는 화면 출력의 OS 코드 제외,
확장자를 작성하거나 생략한 플랫폼 import의 동일한 처리, 깨끗한 체크아웃에서 빌드 테스트 폴더 생성,
대상 OS 선택, package.json 버전 반영과 잘못된 버전 거부, 실패 시 기존 출력 보존을 검사한다. storage 네이티브 검사는 여러
어댑터의 DLL 소유권과 반복 dispose도 확인한다. 저장 어댑터 생성 시 기본 폴더가 생기지 않는지,
앱이 지정한 절대 경로의 입출력이 가능한지와 링크, 별칭, ACL 및 파일 교체 검사를 실제 Windows에서 확인한다.

`cli/plugins.test.ts`는 네이티브 export의 실제 경로를 패키지 루트와 비교해 내부 링크는 허용하고
외부로 연결되는 링크는 거부하는지 검사한다. Windows의 임시 폴더에 남은 짧은 경로도 정규화해
같은 패키지 안의 모듈을 잘못 거부하지 않는지 확인한다. macOS 네이티브 CI는 호스트 실행 전에
`plugins:build`를 실행한다.

`api/cli-arguments.test.ts`는 nested subcommand, Bun flag 문법, Zod defaults/transform, help와
오류 복구, snapshot과 타입 추론을 검사한다. `windows-cli-arguments.ts`는 실제 Windows host의
windowless UI Worker와 named pipe에서 초기 및 두 번째 실행의 argv를 onOpen에 전달하고
match, help, 오류 이후 다음 요청 처리를 확인한다. raw 모드에서 `https://`와 `file:relative.txt`도
원래 인자로 전달한다. `lifecycle/desktop.test.ts`는 초기 및 전달 요청의 URL 모양 string 옵션과
기존 파일 URL 검증을 함께 확인한다. `host:windows`에 포함하며 WebView 페이지는 만들지 않는다.
raw 모드와 자동 실행 prefix를 함께 사용해 `launchReason`, 앱 argv와 숨김 전달의 표시 상태가
유지되는지 확인한다. 실제 Windows CLI 초기 요청에서도 자동 실행 prefix를 제거한 앱 인자를 검사한다.

공식 플러그인은 `src/index.ts`에서 선언을 조립하고 `src/contract.ts`에 계약을 둔다.
`api/plugin-contracts.test.ts`는 OS 자원 없이 네이티브 입력 검증을 실행해 모르는 작업의
UNSUPPORTED, 잘못된 입력의 INVALID_ARGUMENT과 입력 스냅샷을 확인한다.

권한 식별자는 operation 이름이며 작업마다 독립적으로 허용한다. API 검사는 저장 메타데이터의
exists와 stat 분리, 창 조회의 선언된 대상 반환과 다른 조회 및 제어의 거부를 확인한다.
앱 명령의 접근 검사와 직접 플러그인 호출 거부도 확인하며 범용 자원별 권한 계약은 두지 않는다.
windows-ui-operations.test.ts는 실제 UI Worker에서 정책 승인 전에 플러그인의 동의 요청이
실행되지 않는지, 비동기 요청의 승인과 사용자 거부가 전달되는지 검사한다. OS 대화상자는 대체하며
실제 카메라 권한 검증을 뜻하지 않는다. capabilities는 플랫폼 지원만 반환한다.

`windows-windowless.ts`의 `destroy-recreate-resident`와 `destroy-recreate-tray`는
마지막 창 재생성의 이전 세션이 폐기된 뒤 destroy를 호출합니다. 새 HWND를 만들지 않고
재생성을 CANCELLED로 끝내며 keep-alive와 기본 quit 트레이 앱이 beforeQuit 없이
StopHook과 네이티브 자원 정리를 완료하는지 확인합니다. `mise run host:windows`에 포함합니다.

Android의 `FrameDispatcherTest`는 읽기 스레드의 직접 전달이 멈춰도 별도 타이머가
실행되는지, 유휴 이후에도 기한을 감시하는지와 종료 제어 뒤의 응답 폐기를 검사한다.
`ProtocolTest`는 큰 한글과 이모지, 문자열과 키의 잘못된 surrogate, 원문 payload 전달의
중복 키와 이스케이프, envelope를 포함한 깊이 및 크기 제한을 확인한다.
`WebViewSessionTest`는 최초 hello, 입력 방향, 종료 및 화면 전환 뒤 대기 요청 폐기를 검사한다.
이 Java 검사들은 `mise run host:android`의 Gradle 단위 검사에 포함된다.
`android-bridge.test.ts`는 실제 `bridge.js`를 실행해 SDK의 텍스트 전달, 기존 객체 기반
리스너와의 호환성, 잘못된 메시지 거부와 종료 후 리스너 해제를 검사한다.
포트 연결 전 요청의 순서와 용량, 이전 문서 및 중복 포트 거부, fallback과 포트 회수도 포함한다.
직접 연결의 SDK 종료 알림과 출력 버퍼 제한도 검사한다. `loopback-channel.test.ts`는
실제 로컬 WebSocket으로 Origin, 일회용 주소, 만료와 회수, 늦은 SDK 초기화, 입력 순서와
크기 및 대기 제한을 검사한다. `runtime-bun.test.ts`는 실제 Bun 자식 프로세스에서
직접 연결의 정책 거부, 명령 오류 응답, 호스트 회수와 종료를 확인한다.
`android-bridge.test.ts`는 WebSocket 생성 실패와 최초 연결의 error/close에서 MessagePort와
reply proxy로 한 번만 전환하고 대기 메시지를 순서대로 전달하는지 검사한다. 이전 소켓의
늦은 콜백과 중복 주소를 무시하며 연결 성공 후에는 실패한 요청을 재전송하지 않는다.
`runtime-bun.test.ts`는 기존 직접 연결 권한을 회수한 뒤 새 파이프 세션이 동작하는지도 검사한다.
`runtime-channel-failure.test.ts`는 실제 TCP 연결의 close 프레임 없는 종료, 잘못된 입력과
수신 정지로 인한 출력 버퍼 초과를 재현한다. 해당 문서의 진행 중 명령만 취소되고 같은 Bun PID와
앱 상태, 다른 세션, 새 문서 연결 및 정상 shutdown이 유지되는지 검사한다.

창 준비 계약은 `api/window-readiness.test.ts`, `lifecycle/window-readiness.test.ts`와
`window-operations.test.ts`에서 설정 검증, 작업 권한, 단계별 완료와 상태 복구,
새 세대와 늦은 확인 차단, 기한, 생성 취소와 전환 순서를 확인한다.
`api/client.test.ts`는 협상한 SDK 준비 확인과 이전 호스트 호환, 확인 전송 실패를 검사한다.
`windows-window-readiness.ts`는 실제 WebView2에서 숨김 생성, 별도 준비 이벤트, 허용된 다른 창의
수신과 권한 필터, 탐색과 fragment, 창 재생성, 문서 실패와 탐색 취소, SDK 미준비의 실제 30초 기한,
문서만 준비된 자동 표시 및 splashscreen 전환 후 한 번의 마지막 창 종료를 검사한다.
`mise run host:windows`에 포함하며 네이티브 입력 준비 뒤 직접 실행할 수 있다.
`windows-hidden-webview.test.ts`는 실제 Win32, WebView2를 별도 STA 프로세스에서 실행한다.
HWND 생성부터 문서 완료까지 Win32 표시, 활성화, 포커스 메시지와 같은 프로세스의 WinEvent를
관찰하고 입력 포커스와 숨김 상태를 확인한다. DLL 대체나 주기적 상태 조회만으로 순간 표시를 판정하지 않는다.
WebView2 SDK 입력이 없거나 다른 OS이면 이 검사를 건너뛴다.

`mise run host:android`는 Windows의 Android SDK/JDK와 선택 기기에서 실제 APK를 검사한다.
`ANDROID_SERIAL` 기본값은 `emulator-5554`이며 기기를 먼저 부팅하거나 연결해야 한다.
공통 Core/SDK 명령, 이벤트와 구독 해제, 정책 거부, 취소, 자산과 subframe 경계,
화면 회전 후 같은 Bun PID와 Core 상태, Activity 종료 뒤 실제 Bun 종료를 확인한다.
홈 런처에서 fixture 아이콘을 눌러 실행하고 호출 주체와 root task를 확인한다.
홈 이동과 복귀에서는 Bun을 유지하고, 시스템 뒤로가기에서는 종료하는지 구분해 검사한다.
회전 설정은 원래 값으로 복원한다. Java 스키마 검사와 Android lint도 포함한다.
실제 WebView에서 localStorage와 sessionStorage의 저장, 읽기와 제거도 확인한다.
`cli/android.test.ts`는 지원하지 않는 설정과 잘못된 명령 인자, 대상 잠금, sync 후
사용자 Java/Manifest/Gradle/Wrapper 보존, 생성 파일 교체, 무관한 프로젝트와 링크 거부를 검사한다.
설치된 패키지의 실제 Android 번들 Worker를 실행하고 생성된 백엔드의 IPC 부팅 협상과 정상 종료도 검사한다.
앱이 지정한 launcher 해석과 시작, ADB가 종료 코드 0으로 반환한 실행 오류의 실패 처리도 검사한다.
Gradle 출력의 최종 application ID와 잘못된 메타데이터 거부도 검사한다.
별도 프로세스의 ADB fixture로 설치와 시작 중 출력 잠금, debug 접미사가 붙은 ID의 전달,
정상 종료와 설치 실패, 시작 실패, 취소 후 ADB 종료 및 잠금 해제를 확인한다.
이 결과는 ARM64 실기기, release APK/AAB와 네이티브 플러그인 검증이 아니다.
실제 런처 intent와 renderer 실패 후 회전, Bun의 cacheDir 임시 파일 쓰기도 확인한다.
백엔드 파일 import의 APK 추출과 읽기, Bun이 만든 자식 및 손자의 회전 중 유지와
뒤로가기 및 renderer 실패 후 정리도 검사한다. 설치된 Android Worker 검사는 텍스트,
바이너리와 JS 파일 자산을 번들하고 추출한 뒤 원본 소스를 삭제하고 IPC 명령으로 읽는다.
`lifecycle/android-process-group.test.ts`는 Linux와 JDK 17 이상에서 실제 Java 소유자를
컴파일하고 시작 취소, 정상 및 실패 종료, 강제 종료 후 자식과 손자, 상속된 파이프 정리를
검사한다. 다른 그룹의 프로세스가 유지되는지도 확인하며 Android 기기 실행을 대신하지 않는다.
`lifecycle/android-backend-assets.test.ts`는 JDK 17 이상에서 실제 Java 추출 소유자를
컴파일하고 APK 갱신 시 이전 파일 import 제거, 앱 데이터 보존과 추출 실패 후 재시도를 검사한다.
Linux와 macOS에서는 기존 추출 트리와 루트의 심볼릭 링크가 외부 파일을 건드리지 않는지도 검사한다.
`packaging/publication.test.ts`는 공통 게시의 복구 성공, 게시와 복구 오류의 동시 유지,
게시 후 백업 정리 실패, Android 출력 대상과 패키징 BuildTarget의 분리를 검사한다.

`api/clipboard.test.ts`는 텍스트 계약, 작업별 권한, SDK 호출 컨텍스트와 브라우저 번들을 검사한다.
`api/window-activation.test.ts`는 `showInactive`, `blur`, `activate`의 입력과 결과,
작업 권한과 열린 창 검사, 설정 순서의 후보 선택과 OS 전환 거부를 검사한다.
`lifecycle/windows-activation.test.ts`는 실제 두 Win32 창과 EDIT 입력 필드를 사용한다.
일반, 최소화, 최대화와 최대화에서 최소화한 창을 표시하거나 숨긴 뒤 `showInactive`를
호출해 활성 창과 키보드 입력 포커스 보존, 표시 상태와 이벤트, snapshot의 일치를 확인한다.
`activate`가 숨김과 최소화를 유지하는지도 검사한다. 전경 전환을 OS가 거부한 실행은
입력 포커스 보존 결과와 구분해 기록하며 실제 전경 blur와 focus 성공으로 계산하지 않는다.
DLL 대체 fixture는 반환 BOOL과 실제 전경 상태가 다를 때 관찰 상태를 반환하고,
동기 활성화 콜백 뒤에 반영된 상태도 중복 이벤트 없이 전달하는지 검사한다.
WebView2 경로는 기존 `windows-bun-window-api.ts`와 `windows-window-events.ts`에 포함한다.
`lifecycle/clipboard-resources.test.ts`는 별도 프로세스의 Win32 바인딩 대체로 메모리 실패,
소유권 이전, 잘못된 UTF-16, 점유와 취소, 종료 정리를 확인하며 데스크톱 클립보드를 바꾸지 않는다.
실제 Windows 검사는 `BUNAWAY_CLIPBOARD_NATIVE=1`을 설정한 뒤
`mise exec -- bun test tests/lifecycle/windows-clipboard.test.ts`로 실행한다.
공통 SDK와 실제 UI Worker의 읽기, 쓰기, 지우기, 별도 프로세스 점유와 취소를 확인한다.
WebView2 페이지 실행은 포함하지 않는다. 이전 텍스트만 복원하며 이미지 등 다른 형식은 복원하지 않는다.
실제 검증 기록과 명령은 [clipboard README](../plugins/clipboard/README.md)에 둔다.

`api/window-lookup.test.ts`는 창 식별자 schema, 독립적인 조회 권한, 인증된 출처,
이전 ID와 닫힌 창의 `null`, 취소와 미지원 플랫폼을 검사한다.
`lifecycle/windows-window-lookup.test.ts`는 실제 HWND로 전경 창, 활성화 이력, 숨김,
파괴 후 삭제와 새 ID, 조회 중 표시와 포커스 유지를 검사한다.
OS가 전경 전환 요청을 거부하면 해당 활성화 전환을 `UNTESTED`로 기록하고 실제 조회 결과와
표시 유지 검사는 계속한다. 이 실행을 활성화 전환 성공으로 기록하지 않는다.
`lifecycle/windows-bun-window-api.ts`는 실제 WebView2와 UI Worker에서 문서 탐색의 ID 유지,
네이티브 재생성의 ID 교체, 닫힌 창 조회, normal과 destroyed 상태 및 뷰별 권한을 확인한다.
네이티브 입력을 준비한 뒤 `bun --no-env-file tests/lifecycle/windows-bun-window-api.ts`로
단독 실행하거나 `mise run host:windows`로 전체 Windows 호스트 회귀와 함께 실행한다.

`api/window-creation.test.ts`는 create/recreate의 `{ view, options? }` 계약과 독립 작업 권한,
공개 registry 및 직렬화 Host 경계의 허용된 표시 옵션과 잘못된 옵션, URL, 프로필과 임의 ID 거부를 확인한다.
`lifecycle/windows-window-placement.test.ts`는 ADR 0019의 작업 영역 배치, content/outer 크기,
음수 좌표, DPI 96/120/144/192의 반올림, 최소 크기 충돌과 좌표 범위를 순수 계산으로 검사한다.
single/multiple 계약 회귀는 병합 오류와 네이티브 배치 검증이 예약 및 기존 창 종료보다 먼저
실행되고 호출별 옵션이 선언을 바꾸지 않는지 확인한다. macOS 선언의 미지원 오류도 검사한다.
`lifecycle/windows-initial-placement.ts`는 실제 HWND와 WebView2에서 초기 선언, single과
multiple의 생성 및 재생성, 예약 전 거부와 선언 복원을 확인한다. multiple은 isolated 프로필을 쓴다.
실제 HWND에서 4096 논리 픽셀의 content 및 outer 요청을 기본 tracking 제한으로 줄이지 않고
중앙에 배치하는지도 확인한다.
4096 content 최소 크기가 들어가는지는 실제 작업 영역과 측정한 DPI 및 프레임으로 계산한다.
들어가면 재생성 성공을, 들어가지 않으면 기존 창을 보존하는 거부를 검사한다.
`mise run host:windows`와 CI의 windows-native에 포함하며 네이티브 입력 준비 후
`bun --no-env-file tests/lifecycle/windows-initial-placement.ts`로도 실행할 수 있다.
이 검사는 실행 환경의 모니터와 DPI를 기록하며 다중 물리 모니터 검증을 대신하지 않는다.
`cli/windows-config.test.ts`는 숨김 및 지연 창의 중복 뷰 진단, 식별자 개행과 128개 선언
상한을 검사한다. `lifecycle/window-operations.test.ts`는 열린 뷰의 두 번째 create가
BUSY로 실패하고 기존 자원 소유자를 유지하는지 확인한다. 호출별 옵션의 크기 보정,
제약 병합과 선언값 복원, 제목 검증 및 잘못된 옵션과 미지원 플랫폼에서 기존 창 보존도
검사한다. 같은 뷰의 여러 창이나 실제 WebView2 실행은 포함하지 않는다.
`lifecycle/windows-window-readiness.ts`는 실제 Windows 호스트에서 호출별 크기 적용,
잘못된 제약에서 창 ID 유지와 다음 재생성의 선언 크기 복원을 검증한다.

`lifecycle/window-events.test.ts`는 실제 Core와 typed SDK를 연결해 `windows.changed`의
스키마, 뷰별 구독 권한, 해제, 폐기 세션과 Core 종료 후 늦은 발행 차단을 확인한다.
MessageChannel로 네이티브 이벤트 전송 방향, 미확인 128개 상한과 종료 용량도 검사한다.
Core 구독 큐 초과는 BUSY로 구독을 끝내고 이후 이벤트를 차단하는지 확인한다.
이 계약 검사는 WebView2 실행을 포함하지 않는다.
객체형 앱 정의의 `plugins` tuple에서도 이벤트 이름과 payload 타입을 추론하는지 타입 검사로 확인한다.

`lifecycle/windows-window-events.test.ts`는 실제 Win32에서 API와 시스템 메뉴 명령의
표시, 포커스, 이동, 크기, 최소화, 최대화, 복원과 전체화면 전환을 확인한다.
중복 억제, 현재 물리 outer bounds, revision과 HWND 파괴 후 콜백 차단 및 재생성 식별자도 검사한다.
각 전경 전환 요청의 반환값과 실제 전경 창을 확인한다. OS가 전환을 거부하면 focused 조회와 snapshot의 일치를 확인하고 실제 focus/blur
전환은 검증하지 못했다는 메시지를 출력한다. 해당 실행을 focus/blur 성공으로 기록하지 않는다.
DLL 대체 fixture는 전경 HWND가 동기 활성화 콜백 뒤에 반영되는 경우에도 게시한 창 메시지에서
focus/blur를 발행하는지 확인한다. 실제 OS 전경 전환 검증과는 구분한다.
`lifecycle/windows-window-events.ts`는 실제 WebView2로 구독한 세 문서에서 정상 전달,
권한 거부, 구독 해제, snapshot 조회, 탐색과 창 재생성 및 정상 종료를 확인한다.
`mise run host:windows`에 포함되며, 네이티브 입력 준비 후 이 파일만 실행할 수도 있다.

`cli/app-manifest.test.ts`는 Windows 실행 manifest의 형식과 계약 검증, 플러그인 제거 후
재생성, 생성 import와 metadata 불일치를 검사한다.
`cli/plugins.test.ts`는 index.ts 한곳의 선언에서 플랫폼 경로를 찾고 설치만 한 어댑터를
불러오지 않는지 확인한다. 선언 진입점 기준 경로와 패키지 밖의 링크 거부, I/O와 UI의
부분 지원 조회 및 UNSUPPORTED 응답도 검사한다. `api/native-plugins.test.ts`는 플랫폼
선언 검증, 지원 목록 복사와 일반 플러그인의 시작 제한과의 분리를 확인한다.
manifest 생성과 카탈로그 로딩에서 작업 이름만 전달하며 작업 개수 상한을 유지하는지도 검사한다.
`api/plugin-zod-runtime.test.ts`는 원본 Zod와 입력, 결과 파싱을 비교한다. record 키 정규화와
제거, when, 사용자 검사, 변환 횟수, JSON 제한과 동기 및 비동기 파싱을 검사한다.
실패하는 비동기 검사 뒤에도 같은 Worker가 다음 호출을 처리하고 종료 코드 0으로 끝나는지,
`lifecycle/plugin-async-parsing.test.ts`는 실제 I/O Worker에서 권한 거부 시 입력 콜백이
실행되지 않고, 입력 파싱 뒤 재승인이 거부되면 네이티브 작업도 실행되지 않는지 확인한다.
중복 승인, 입력 검사 전 취소와 파싱 중 취소, 늦은 검사 실패와 다음 요청의 처리도 검증한다.
`lifecycle/plugin-cancellation.test.ts`는 실제 Windows UI와 I/O Worker에서 입력과 출력 파싱,
비동기 UI 실행을 한도만큼 취소해도 승인 용량과 다음 호출이 정상인지 확인한다. 컨텍스트 취소,
늦은 완료와 실패, 중복 승인과 작업 대기 중 종료도 검증한다. `lifecycle/macos-bun.test.ts`는
네이티브 UI만 대체한 실제 macOS 호스트와 Worker에서 같은 입력, 출력, 실행 취소 경로를 검사한다.
`lifecycle/io-response-ownership.test.ts`는 실제 I/O Worker와 `ImageResources`에서 응답 승인 전
취소, 컨텍스트 폐기와 종료가 전달되지 않은 이미지 자원을 회수하고, 승인된 자원은 유지하는지 확인한다.
`lifecycle/windows-host-shutdown.test.ts`는 백엔드 I/O 취소가 Core 종료 훅보다 먼저 전달되고
어댑터 폐기는 훅 이후 실행되는지 확인한다. Windows에서는 실제 Win32 UI Worker와 Job을 사용한
창 없는 실행도 검사하며 `host:windows`에 포함한다. Linux에서는 UI와 Job 경계를 대체한다.
`lifecycle/windows-ui-lifecycle.test.ts`는 실제 UI Worker와 대체 Win32 경계에서 마지막 창을
파괴해 종료를 확정한 뒤 입력 파싱을 재개한다. 취소 패킷 없이도 동기 어댑터와 비동기 UI
어댑터의 실행을 차단하고 CANCELLED를 반환하는지 확인한다.
`lifecycle/native-requests.test.ts`는 취소된 요청의 용량 반환과 이전 완료의 새 요청 간섭 방지를 확인한다. 실제 Worker와
빌드한 플러그인에서 파서가 로컬로 실행되고 전송 경로가 다시 파싱하지 않는지도 확인한다.
정책의 기존 크기와 깊이 상한도 manifest 생성과 읽기에서 유지하며, 상한 초과 입력은 거부하는지 검사한다.
`cli/windows-assets.test.ts`는
원본 소스와 임시 자산을 삭제한 뒤에도 compiled EXE가 manifest와 플러그인 구현을
읽고 지연 로딩을 유지하는지 검사한다.
메인과 두 Worker에서 플러그인의 `BunawayError` 코드가 그대로 전달되는지도 확인한다.
중간 생성 소스 없이 가상 모듈이 EXE에 포함되는지 검사한다.
`cli/macos-build.test.ts`는 macOS compiled 실행 파일의 메인과 백엔드 Worker가
원본 소스와 임시 자산을 삭제한 뒤에도 파일 import를 읽는지 검사한다.
텍스트, 바이너리와 `.js` 파일을 자산으로 가져오는 경우를 포함한다.
`packaging/contract.test.ts`는 `.bunaway/work/`와 `.bunaway/locks/`의 성공 및 실패 후 정리,
작업 디렉터리 링크 거부와 외부 파일 보존을 검사한다.
작업 중과 게시 직전에 작업 경로가 링크로 바뀌어도 외부 파일을 게시하지 않고 이전 출력을 보존하는지 검사한다.

`cli/restart-controller.test.ts`는 코드 교체 응답을 기다리는 중 받은 UI 변경의 즉시 무효화,
연속 저장 대기와 종료 시 대기 취소를 검사한다. `cli/distribution.test.ts`는 설치한 CommonJS
플러그인의 `.cjs`, `.js` 진입점을 실제로 번들하고 로드해 export와 교체 전후 객체 동일성을 검사한다.
조건별 import/require 결과와 require 전용 진입점, 차단된 import 거부 및 setup 플러그인의
바인딩 객체 재사용도 확인한다. Host API 테스트는 같은 플러그인을 재사용한 앱의 실행 컨텍스트가 독립적인지 검사한다.

- `protocol/`: 직렬화, 버전 협상, 오류 계약.
- `api/`: 모듈 공통 타입, 명령 input/output, Host API 컨텍스트, 취소, 오류 계약,
  클라이언트 기본 연결의 지연 초기화, 문서/HMR 공유, 구독 해제, 실패, 취소, 문서 종료 정리.
- `core/`: 명령, 상태, 이벤트, 플러그인.
- `conformance/`: 네이티브 호스트 간 공통 계약.
- `security/`: 권한, origin, 세션, 파일 범위.
- `lifecycle/`: 종료, 재연결, 모바일 수명주기.
  `webview-session.test.ts`는 WebView 전송, Windows 메시지 경계와 실제 Core를 연결해
  잘못된 구독 응답과 클라이언트 종료 시 세션 철회, 원격 구독 제거와 명령 취소를 확인한다.
- `docs/`: 문서 링크 검사기의 정상 입력, 잘못된 링크와 출력 경로 경계.

Windows 이벤트 전송 회귀는 실제 `MessageChannel`과 Core를 연결한다. 두 뷰의
총 130개 구독에 대한 방송과 구독별 순서, 수신 확인 지연, BUSY 구독 종료,
서버 대기열 포화와 세션 정리, 취소 및 종료 용량을 확인한다.
이 검사는 WebView2 GUI 실행을 포함하지 않는다.

`windows-window-events.test.ts`의 `windows-modal-events.fixture.ts`는 실제 Win32
이동 모달 루프에서 5ms 간격으로 위치를 384번 변경한다. 이벤트 수신 확인과
서버 전달이 모달 종료 전에도 진행되고, 양방향 전송의 순서와 정리가 유지되는지 검사한다.
물리 마우스 드래그를 실행하는 검사는 아니다.

Windows 호스트 시나리오는 `lifecycle/windows-host.ts`에 두고 PID 조회, 창 닫기와
프로세스 종료 감시는 `lifecycle/windows-host-processes.ts`에서 실행한다.

`api/opener.test.ts`는 HTTP/HTTPS 계약과 파일 API, 절대 경로 입력과 작업별 권한을 확인한다.

`api/window-relations.test.ts`는 trusted destroy의 백엔드 출처와 독립 작업 권한,
관계 조회와 변경의 작업별 권한, 입력과 출력 경계를 확인한다.
`lifecycle/windows-window-relations.test.ts`는 실제 HWND의 owner와 enabled,
여러 모달의 원래 enabled 복원, 순환과 종료된 ID 거부, 네이티브 실패의 변경 취소,
자식부터의 자원 해제 순서를 검사한다. `lifecycle/windows-owned-modal.ts`는 실제
WebView2 세션과 UI Worker로 웹의 destroy 거부, 닫기 확인 거절, 모달 자식 재생성,
부모 종료와 새 ID, 마지막 창 집합의 종료 취소와 오류, 대기 중 trusted destroy를
검사한다. 실제 WebView2 정리 기한 초과는 성공으로 간주하지 않는다.
`windows-windowless.ts`의 destroy 시나리오는 keep-alive와 트레이 상주 앱에서도
마지막 창의 trusted destroy가 닫기 확인과 beforeQuit를 우회하고 앱을 정리하는지 검사한다.

`lifecycle/windows-opener.test.ts`는 실제 Windows I/O STA, 없는 파일과 디렉터리, 공유 잠금, junction,
하드 링크, 대소문자 별칭 거부와 파일 핸들 정리를 검사한다. 실제 I/O Worker의 승인 거부와
대기 작업 취소, 자체 COM 초기화와 종료도 검사한다. `windows-opener-job.test.ts`는 Explorer가 실행한
프로세스의 Job 분리와 앱 종료 후 생존을 확인한다. `cli/opener.test.ts`는 설치한 `.tgz`의 선언,
카탈로그, 작업 권한과 브라우저 번들, UI Worker에서 어댑터를 초기화하지 않는지 검사한다. `BUNAWAY_OPENER_FILES_TEST=1`로 실행하면
`cli/windows-opener-files.ts`의 자체 STA를 소유한 compiled I/O 어댑터 프로브로 실행 파일의 기본 동작과 실제 Explorer 선택을 확인한다.
이 opt-in 검사는 Explorer 데스크톱이 필요하며 사용자 파일 연결을 바꾸지 않고 테스트 폴더의 창만 닫는다.
일반 문서 편집기의 실행 완료, UNC 공유, MSIX나 Inno 설치 검증은 포함하지 않는다.
`app-reload.test.ts`는 명령 교체 후 상태, 세션, 구독, 진행 중인 명령의 기존 구현과
비공개 개발 IPC 입력 검증을 확인한다. 일반 경로와 별칭 경로에서 정상 번들을 교체하고,
해시가 다르거나 세대 디렉터리 밖을 가리키는 번들은 거부하는지도 검사한다.
`windows-app-reload.ts`는 생성하고 설치한 앱의
실제 CLI 파일 감시와 WebView2를 사용해 소스 오류 중 기존 앱 유지, 수정 후 상태와
화면 입력, 이벤트 순서, Host API, 오류 코드 보존, 계약 변경 시 전체 재시작을 검증한다.
CLI 계약 테스트는 로컬 UI와 백엔드의 공유 파일 변경을 전체 재시작 대상으로 분류하고
두 번들을 갱신하는지, JSON을 export하는 플러그인도 개발 번들에 포함할 수 있는지 확인한다.
뷰 프로필 이름은 호스트의 순수 `view-profile.ts` 함수를 공유한다.
macOS WebContent PID 조회와 종료는 `lifecycle/macos-renderer.ts`가 맡으며,
`macos-host.ts`는 시나리오별 기준 PID와 테스트 순서를 유지한다.

`mise run test`는 프로토콜, 정책, SDK, 코어, Host API의 계약 테스트와 네이티브용 생성
스키마 일치 검사를 실행한다. `mise run check`에는 테스트와 테스트 코드의 타입 검사도 포함한다.
코어, SDK 테스트와 `runtime-bun.test.ts`의 실제 Bun 프로세스 IPC 테스트를 포함한다.
런타임 테스트는 플러그인 초기화 중 Host API, 응답 컨텍스트, 취소, 폐기, 늦은 응답,
새 세션, 종료 훅, EOF와 부팅 전/초기화 중 종료를 확인한다.
`mise run host:windows`는 C++ 컴파일 없이 Bun UI Worker의 실제 WebView2, SDK, 권한,
다중 창, 저장, 메모 복원, 렌더러 복구, 정상/비정상 종료를 검증한다.
모달 중 메인의 타이머, Promise, 네트워크와 초기화 중 닫기, 생성 실패, 파일 핸들 경계,
이동한 독립 CLI 프로젝트도 포함한다. [실행 결과](../docs/architecture/windows-bun-results.md).
모달 테스트는 진행 중인 HTTP 요청을 완료한 뒤 테스트 서버를 닫는다.
독립 CLI 프로젝트는 테스트용 UI 명령 호출을 추가한 뒤 생성 앱의 타입 검사를 통과해야 빌드와 창 실행을 진행한다.
공통 앱, 화면 데이터는 `tests/fixtures/desktop/host/`에서 Windows/macOS가 공유한다.
예전 Windows C++ 호스트/probe와 전용 실행기, 테스트는 삭제했다.
독립 실험 실행기와 모의 백엔드는 제거했다. `runtime-bun.test.ts`는 실제 Bun 런타임의
boot 전후 종료와 초기화 중 프로토콜 버전, 런타임 ID 및 세대 불일치 거부를 확인한다.
다른 플랫폼, 모바일 수명주기의 검증 완료를 뜻하지 않는다.

공개 창 API의 계약, 작업 권한, 카탈로그와 개발 URL은 SDK, CLI 테스트에서 확인한다.
`api/window-geometry.test.ts`는 content, outer와 normal 조회 schema, 공개 SDK 호출 컨텍스트,
반올림과 정수 범위, 작업 권한 거부 및 닫힌 창을 검사한다.
`lifecycle/windows-geometry.test.ts`는 실제 Win32 창에서 setter 직후 조회, 일반, 숨김,
최소화, 최대화와 전체화면 bounds, normal 복원과 음수 좌표를 검사한다. DPI 메시지는
합성 메시지이며 실제 배율이 다른 물리 모니터 사이의 이동 검증과 구분한다.
최소화 또는 최대화 직후, 표시와 숨김 직후 및 복원 영역 setter 뒤의 체크포인트는
HWND 소유 프로세스와 스레드, style, 원본 WINDOWPLACEMENT와 Win32 상태를 함께 검사한다.
실패에는 최근 체크포인트와 제한된 상태 메시지 기록, 호스트 callback 오류를 포함한다.
검사는 상태를 복구하거나 메시지를 pump하지 않으며 기존 geometry 기대값을 유지한다.
`lifecycle/windows-window-state.test.ts`는 같은 HWND에서 일반, 최소화와 최대화 상태,
표시와 숨김을 반복해 전체화면 해제 후 현재 bounds, normal bounds와 표시 상태를 검사한다.
프레임 재계산 뒤 일반 배치를 확정하는 순서를 회귀 검사하며 음수 화면 좌표를 유지한다.
같은 검사는 `setContentPosition`, `setOuterSize`, `setContentBounds`, `setOuterBounds`의
일반 및 숨김 적용, 제약 보정, 최소화 및 최대화 중 복원 영역 변경, 전체화면 거부,
rectangle 경계 오류의 변경 방지와 실제 이벤트 snapshot 일치도 확인한다.
각 성공한 작업 뒤 WndProc 오류도 확인하고, 숨김 크기를 위치 변경 전후에 각각 검사한다.
마지막 전체화면 검사에서는 진입 전 일반 상태, 숨김 직후 상태와 종료 뒤 일반 상태도 확인한다.
실패 때 native style, placement와 client/outer rectangle 및 최대 32개 scalar 메시지를
출력해 크기와 표시 상태가 실패한 단계를 구분한다. native pointer는 보관하지 않는다.
`api/window-geometry.test.ts`는 새 setter의 단위 기본값, DPI 반올림, 입력과 출력 schema,
SDK 호출 컨텍스트, 작업 권한, 닫힌 창 및 시작 전 취소를 GUI 없이 검사한다.
`windows-window-events.ts`는 실제 WebView2, Core와 UI Worker를 연결해 네 setter의
공개 SDK 호출 및 `setOuterBounds` 결과와 `windows.changed`의 revision, bounds 일치를 확인한다.
`windows-fullscreen-dpi.fixture.ts`는 DLL 대체로 음수 좌표의 모니터 이동, 작업 영역의
좌표 보정과 전체화면 중 현재 DPI에 따른 normal bounds 계산을 검사한다.
같은 fixture는 DPI 120/144/192에서 601×451 물리 content의 resizable 반복 변경을 검사한다.
일반, 최소화, 최대화와 전체화면 및 표시와 숨김 상태를 구분하며 실제 물리 모니터 검증은 아니다.
작업 영역 오프셋이 다른 모니터로 최대화 창을 옮기거나 전체화면에 진입해도 원래 일반
복원 rectangle의 모니터로 좌표를 보정하는지, 조회가 숨김 상태를 유지하는지도 검사한다.
왼쪽과 위쪽 모니터의 경계에 걸친 일반 창의 위치, 모니터 변경과 최소화, 최대화 중
복원 모니터 정보의 보존도 검사한다. 전체화면과 DPI 변경도 경계에 걸친 복원 영역을 사용한다.
최소화, 최대화와 전체화면 중 복원 모니터를 제거해도 normal bounds 조회가 유효 모니터를 다시 선택하고 표시 상태를 유지하는지 검사한다. 대체 모니터도 조회할 수 없으면 공개 `INTERNAL` 오류를 반환해야 한다.
최소화와 최대화 중 원래 모니터를 다시 연결해도 Windows가 옮긴 복원 위치를 유지하는지 검사한다. 분리 중 조회하는 경우와 한 번도 조회하지 않는 경우를 모두 확인한다. 전체화면에서는 표시와 숨김 상태로 모니터 분리와 재연결을 반복해 원래 복원 모니터의 좌표 보정으로 돌아오는지 확인한다. 재연결 후 핸들이 유지되는 경우와 바뀌는 경우를 모두 검사한다. 이 검사는 DLL 대체이며 실제 물리 모니터의 분리와 재연결 검증은 아니다.
`api/window-state.test.ts`는 상태 제어와 조회의 입력 및 출력 schema, 독립적인 작업 권한,
전체화면 중 변경 거부, 닫힌 창과 허용된 미선언 뷰의 오류를 검사한다.
`lifecycle/windows-window-state.test.ts`는 실제 Win32 창에서 최소화 전 최대화 복원과 일반
복원의 차이, 숨긴 창의 표시, OS에서 직접 바꾼 상태 조회, 크기 제약과 전체화면 복원을 확인한다.
최대화와 최소화 이력이 있는 일반 창도 전체화면 해제 후 일반 상태로 복원되는지 검사한다.
공개 함수와 UI Worker, WebView2를 연결한 상태 제어와 조회는 `windows-bun-window-api.ts`로 검증한다.
`lifecycle/windows-window-size.test.ts`는 서로 다른 작업 영역과 DPI에서 최대화 크기 보정과
제약이 없는 축의 보존을 확인한다. `windows-size-constraints.test.ts`는 실제 Win32에서
최대화 중 제약 축소, 확대와 해제, 숨긴 최대화 창과 최소화 창의 표시 상태 및 복원 크기를 검사한다.
두 창을 사용해 최대화된 보조 창의 제약, 복원 크기와 DPI를 바꿀 때 활성화 메시지가 발생하지 않고 입력 창의 활성 상태와 키보드 포커스가 유지되는지도 검사한다. 다른 프로세스가 전경 창을 바꿀 수 있으므로 입력 창이 계속 전경인지는 비교하지 않는다. 보조 창이 전경을 가져오는 것은 항상 거부한다.
일반, 최소화와 최대화 상태에서 숨긴 보조 창의 제약, DPI와 전체화면을 바꿀 때 표시나 활성화 메시지가 발생하지 않고 숨김 상태, 복원 크기와 입력 창의 포커스를 유지하는지도 검사한다.
합성 DPI 메시지 이후 최대화 크기를 다시 계산하고 표시 상태와 논리 복원 크기를 유지하는지도 확인한다.
합성 DPI 메시지로 표시하거나 숨긴 전체화면 창이 실제 모니터 영역을 유지하고, 해제 시 크기 제약을 적용하는지도 검사한다.
`windows-window-size.test.ts`의 별도 프로세스는 Win32 DLL을 대체하고 실제 FFI 창 콜백을 호출한다.
서로 다른 DPI와 해상도의 모니터로 이동하기 전에 전달된 제안 위치로 전체화면 대상을 선택하고,
화면 영역, 숨김 상태, 활성화 방지와 저장된 크기 제약을 유지하는지 검사한다. 실제 물리 모니터 이동 검증과는 구분한다.
일반 창의 복원 정보에 남은 최대화 이력은 제거하고 최소화한 창의 최대화 복원 이력은 유지하는지도 검사한다.
같은 격리된 DLL 대체 환경에서 최대화 요청을 무시하도록 해도 성공으로 반환하지 않고
네이티브 상태 확인 후 공개 `INTERNAL` 오류로 변환하는지 검사한다.
`lifecycle/window-operations.test.ts`는 정리 대기 중 중복 생성, 마지막 창 재생성 예약,
기존 문서 취소, 닫기 거절과 종료 경쟁을 검증한다. 미지원 destroy 호출이 실패해도
진행 중인 재생성은 새 창 생성까지 완료하는지도 확인한다. Windows 네이티브 실행기는
`windows-bun-window-api.ts`로 크기와 위치, 전체화면 복원, 확인 대화상자 거절과 승인,
보조 창의 반복 생성과 새로운 세션, 자기 창 재생성을 추가 검증한다.
닫기 확인을 설정한 창의 브라우저 프로세스를 종료해 확인 없이 닫히는지도 검증한다.
호출한 뷰의 세션이 종료되면 정리 대기 중인 생성 요청이 새 창을 열지 않는지도 확인한다.
`macos-bun.test.ts`는 정확한 origin과 포트, 실제 Bun Worker의 명령과 세션 폐기, 종료 수신 확인과 플러그인 정리를 검사한다.
UI 초기화 실패 검사는 UI 의존성만 대체하고 실제 Worker를 사용한다. UI 이벤트 처리 없이도
비동기 종료 훅을 기다리며, 종료 훅의 무한 루프는 5초 기한 뒤 강제 종료되는지 확인한다.
플러그인 초기화 중 창을 닫으면 정리를 완료한 뒤 정상 종료하고, 종료 요청 없이 Worker가
종료되면 코드가 0이어도 시작 실패로 처리하는지 확인한다.
macOS에서는 참조된 하위 프로세스와 `unref()`된 하위 프로세스, 플러그인 종료 기한 초과와
호스트 SIGKILL을 실제 프로세스로 검사한다. shell의 자식과 감시 프로세스까지 정리되고
다른 프로세스 그룹은 유지되는지 확인한다. 다른 OS의 시작 회귀는 macOS 그룹 소유권만 대체한다.
`windows-bun-storage.ts`는 임의 바이트, 빈 파일, 짧은 대체와 append, Unicode 텍스트 append,
바이트 읽기 상한과 링크 거부를 실제 Win32 핸들로 검사한다.
`windows-storage-metadata.ts`는 실제 WebView2에서 바이트 대체와 append, UTF-8 append 및
독립적인 텍스트 대체 권한 거부를 I/O Worker와 함께 검사한다.
이 검사들은 `mise run host:windows`에 포함하며 Linux 계약 검사와 구분한다.

`tests/lifecycle/run-native.ts`는 패키징과 테스트 실행 순서를 조정한다.
macOS 전용 설정과 리소스 경계 페이지도 `fixtures/desktop/host/`에 둔다.
`host:macos`는 C 컴파일 없이 Bun compiled 앱으로 실제 WKWebView 회귀를 실행한다.
같은 실행기의 `macos-webview-regressions.ts`는 실제 AppKit 창의 초기 크기 보정,
최소, 최대 제약과 제한 해제, WebKit UI delegate의 미디어 권한 거부를 확인한다.
미디어 검사는 설치된 delegate와 네이티브 decision block을 사용하며 실제 장치를 열지 않는다.
`macos-window-api.ts`는 실제 compiled 호스트와 WKWebView를 연결해 여러 시작 창,
지연 생성, 권한별 목록, 표시와 포커스 조회, 반복 생성과 개별 닫기를 검사한다.
보조 창을 닫아도 주 창과 백엔드가 유지되고, 마지막 창의 자기 재생성이 새 세션으로
완료되며, 마지막 닫기에서 호스트가 한 번 종료되는지 확인한다. 영속 프로필은 검사하지 않는다.
브리지에 최상위 `Date`, 객체와 배열 안의 `Date`를 보내도 앱이 종료되지 않고,
잘못된 메시지를 거부한 뒤 정상 메시지를 계속 수신하는지 확인한다.
4KB 응답 24,000개를 실제 페이지에 전달한 뒤 호스트 메모리 증가를 검사하고,
런타임 세대를 바꿔 다시 창을 만들 때 영구 저장 리소스 규칙이 하나로 유지되는지 확인한다.
공용 기능 목록 검사는 Windows 창 API의 `supported`와 macOS의 `unsupported`를 요구한다.

`desktop.test.ts`는 앱 열기 입력, 단일 인스턴스 전달과 시작 큐, 종료 취소,
실패 복구, 제어 패킷 경계와 창 없는 시작의 실행 유지 조건, 잘못된 desktop 설정의 진단을 확인한다.
`windows-windowless.ts`는 실제 Windows HWND, 트레이와 WebView2로 빈 창 선언,
지연 생성과 첫 창의 트레이 생성, 숨김과 최소화 및 최대화 복원, 마지막 창 닫기 뒤
백엔드 유지와 새 세션, 트레이 Quit 취소와 재시도를 확인한다. 트레이 입력은 실제
소유 HWND에 콜백 메시지를 게시하며 물리 마우스 클릭 검증과 구분한다.
창 없는 상주 앱과 트레이 앱의 CLI 중단, 대기 중인 beforeQuit 우회와 StopHook 정리도 검사한다.
강제 종료에서는 StopHook을 보장하지 않으며 실제 Job 자식 프로세스와 HWND 종료를 확인한다.
실행 결과는 `build/windows-windowless/<scenario>-report.json`에 기록한다.
Windows 실행기의 `windows-desktop.ts`는
실제 창을 숨긴 뒤 백엔드 타이머가 계속 동작하는지, 두 번째 실행으로 복원되는지,
종료 취소 뒤 같은 창과 세션을 유지하고 다시 종료할 수 있는지 확인한다.
`windows-desktop-web.ts`는 복원 뒤에도 원래 구독으로 이벤트를 받고 같은 세션에서
명령을 호출하는지 확인한다. IPC의 5초 기한은 요청이나 응답 조각을 계속 보내도 연장되지 않는다.
기한 검사에서는 큰 인자의 전달과 연결 종료에 따른 pipe 오류도 처리하며 요청과 응답이 각각 기한을 채웠는지 확인한다.
Windows PowerShell 실행기 테스트는 한글 파일과 URL 인자 및 호출자의 cwd 보존을 확인한다.
`--`, PowerShell 공통 매개변수 이름, 따옴표, 끝의 역슬래시와 빈 인자도 확인한다.
한글 파일명 128개와 256개도 실제 실행기로 전달해 JSON 인코딩 뒤 명령줄 길이 초과가
발생하지 않는지 확인한다. 표준 입력의 크기 제한, 잘못된 JSON과 5초 기한도 검사한다.
Windows 데스크톱의 dev-veto, dev-hide, dev-pending 시나리오는 CLI 중단이 종료 취소,
트레이 숨김과 대기 중인 종료 훅을 우회하며 플러그인 정리를 실행하는지 확인한다.

공개 창 API와 데스크톱 종료 설정을 함께 쓰는 회귀도 확인한다. `windows.close`의
마지막 창 종료 취소는 기존 세션을 유지하고, 자기 창 재생성은 `beforeQuit`를 호출하지 않는다.
트레이 숨김 설정에서는 API로 닫은 뒤에도 같은 요청 컨텍스트로 창을 다시 표시할 수 있어야 한다.

## 네이티브 빌드와 배포 회귀

`api/opener-selected-app.test.ts`는 지정 앱 opener의 strict Zod 입력, 독립 권한,
호출 컨텍스트와 오류를 확인한다. Windows의 `lifecycle/windows-opener-selected-app.test.ts`는
실제 앱과 대상 파일 검사, 링크 거부와 핸들 정리를 확인한다. `windows-opener-job.test.ts`는
Explorer와 compiled helper로 파일 및 HTTP/HTTPS URL 하나의 argv 보존과 Job 밖의 실행,
앱 종료 뒤 helper 생존을 확인한다. 두 검사와 기존 opener STA 검사는 `host:windows`에도 포함한다.
Linux의 계약 검사에서 건너뛴 Windows 테스트를 실제 실행 결과로 판단하지 않는다.

`api/path.test.ts`는 Windows 문자열 경로 규칙과 명시적 base, per-drive 상대 경로 거부를 검사한다.
보충 문자의 UTF-16 입력과 합성 출력 상한을 확인하며 실제 WebView2에도 같은 경계 회귀를 적용한다.
`windows-path.test.ts`는 실제 current-user Known Folder를 조회하고 .NET의 독립적인
표준 폴더 조회 결과 및 여러 어댑터의 DLL 수명과 비교한다.
`windows-path.ts`는 실제 WebView2와 I/O Worker에서 폴더 조회, 문자열 helper와
작업별 권한 거부를 확인하며 `mise run host:windows`에 포함한다.
실제 사용자 폴더 redirection 설정 변경과 다른 사용자, 머신 검증은 포함하지 않는다.

`api/autostart.test.ts`는 로그인 자동 실행 플러그인의 정책, 공개 helper, 앱 ID 분리와
Windows 명령줄 제한, 숨김 등록의 트레이 요구 조건을 검사한다.
`windows-desktop.ts`의 autostart 시나리오는 실제 HWND와 WebView2에서 일반 및 숨김
초기 실행, SDK 준비 뒤 표시 억제, 숨김 두 번째 요청의 표시 상태 유지, 수동 재실행의 복원과
같은 UI 세션 유지 및 정상 종료 정리를 검사한다. 로그인 실행 출처는 인증하지 않으며
실제 로그아웃과 로그인, 사용자 시작 앱 UI 조작은 별도 대화형 검증이다.
`lifecycle/windows-autostart.test.ts`는 실제 사용자
Run 값의 등록, 조회, 경로 갱신과 반복 해제를 확인한다. 임시 앱 ID에만 승인 테스트 값을
써서 비활성화 선택을 보존하는지 확인하며 실제 작업 관리자 조작과는 구분한다.
저장 명령줄을 CreateProcessW로 실행해 compiled EXE와 개발 Bun의 공백, Unicode,
따옴표, 빈 문자열과 끝의 역슬래시 argv를 검사한다. 실제 로그인 자동 실행은 별도
대화형 로그인 검증이 필요하다. 테스트는 다른 앱의 등록을 변경하지 않는다.
`cli/autostart.test.ts`는 로컬 tarball의 isolated 설치, manifest와 I/O 어댑터 발견,
정책 승인과 browser 번들에서 FFI가 제외되는지도 확인한다.

`windows-safe-storage.test.ts`는 실제 DPAPI로 Unicode와 임의 바이트, 크기 상한, 손상 입력,
보충 문자의 UTF-16 상한 왕복과 초과 입력 거부,
반복 dispose와 독립 어댑터, 저장된 암호문의 새 프로세스 복호화를 검사한다.
`windows-safe-storage.ts`는 실제 WebView2와 I/O Worker에서 동시 요청, UI 타이머 진행,
뷰별 권한 거부와 손상 입력을 확인하며 `mise run host:windows`에 포함한다.
다른 사용자나 머신, Windows 키 복구 및 물리 입력 검증은 포함하지 않는다.

`mise run host:windows`와 `mise run host:macos`는 Bun으로
`tests/lifecycle/run-native.ts`를 실행한다. CLI의 의존성 준비와 네이티브 빌드를
거친 뒤 플랫폼별 실제 호스트 fixture를 만들고 검증한다.
`--skip-tests`는 fixture 생성까지만 수행하며, macOS의 `--app`은 ad-hoc 서명 앱
검증과 `tests/packaging/macos-distribution.test.ts`의 배포 회귀를 추가한다.
배포 회귀는 `bun:test`로 실제 DMG와 PKG, 실패 시 이전 산출물 보존을 확인한다.
서명 fixture도 Bun으로 compile하며 C 컴파일러를 사용하지 않는다. compiled 앱 입력과
서명, JIT와 FFI entitlement, 롤백과 정리를 검증한다.
macOS의 기본 테스트 실행에도 포함되며, 실제 Bunaway 앱 검증은
`BUNAWAY_DISTRIBUTION_APP`에 지정한 앱을 사용한다. 다른 OS에서는 건너뛴다.
Apple 공증 서비스와 도구 실패는 테스트 자식 프로세스의 PATH에만 놓는 Bun fixture로
검증한다. Python이나 별도 셸 실행기는 필요 없다.

`api/storage-transfers.test.ts`는 두 endpoint, 추가 옵션 거부와 독립적인 전송 권한을 검사한다.
`windows-bun-storage.ts`는 실제 source 및 destination 핸들로 여러 chunk의 임의 바이트,
빈 파일, 기존 대상 보존, 크기 상한, 링크와 경로 거부 및 같은 parent의 파일과 디렉터리 rename을 확인한다.
다른 parent 이동은 source를 유지한 채 UNSUPPORTED로 거부하며, 다른 볼륨은 식별 가능한 경우에만 검사한다.
`windows-storage-metadata.ts`는 실제 WebView2와 I/O Worker에서 copy/move와 원본 및 복사본,
일반 쓰기 권한 거부를 검사하며 `mise run host:windows`에 포함한다.

`cli/native-build.test.ts`는 한글과 공백이 포함된 캐시 경로에서 Bun ZIP과 SDK의
압축 해제 위치를 확인하고, 잘못된 ZIP의 실패가 호출자에게 전달되는지 검사한다.
Windows 네이티브 CI는 이 검사를 호스트 빌드 전에 실행하며 전체 실행 로그도 보관한다.
macOS 배포 회귀는 날짜와 바이너리 데이터를 포함한 추가 plist 메타데이터가
서명과 DMG, PKG 조립 후에도 타입과 값 그대로 남는지 확인한다.

`lifecycle/window-instances.test.ts`는 인스턴스 ID 선택, 이전 ID 거부, 요청별 getCurrent,
동시 생성과 앱 및 뷰별 상한, 정리 중 슬롯과 단일 창 호환을 검사한다.
`lifecycle/windows-ui-lifecycle.test.ts`는 실제 UI Worker와 창 어댑터에서 모든 살아 있는
창의 복원, 시작 controller 오류의 fatal 보고와 정리, 실행 중 생성 실패의 인스턴스 격리를 검사한다.
Win32와 WebView 콜백 경계는 제어 가능한 fixture로 대체하며 실제 Windows 실행 검증과 구분한다.
`lifecycle/window-profiles.test.ts`는 실제 임시 폴더로 프로필 공유, 격리, 재생성 보존과 최종 삭제를 검사한다.
`lifecycle/windows-multiple-windows.ts`는 실제 WebView2에서 같은 뷰의 여러 창, 응답 및 이벤트 라우팅,
원래 컨텍스트 취소, 탐색과 ID 유지, 재생성과 ID 교체, 공유 쿠키 및 localStorage,
격리 프로필의 재생성 보존과 새 생성 초기화, 모달 소유 관계, 최종 삭제와 앱 재실행을 확인한다.
공유 브라우저 프로세스 장애에서 해당 창의 정리, 격리된 창의 계속 동작과 새 공유 환경 복구도 확인한다.
실행한 OS, Bun revision과 WebView2 버전은 `build/windows-multiple-windows-results.json`에 기록한다.
CI의 windows-native 작업은 `mise run host:windows`를 통해 이 검사를 실행한다.

`api/storage-directories.test.ts`는 생성의 기본값, 작업별 권한, 결과 전송 상한과
네이티브 디렉터리 record의 경계 검사를 확인한다. `windows-bun-storage.ts`는 실제
검사한 핸들로 여러 batch의 이름과 링크 종류, 재귀 생성, 파일 및 빈 디렉터리 삭제,
큰 목록 실패와 자원 해제를 확인한다. 링크나 별칭 및 ACL 거부도 유지한다.
`windows-storage-metadata.ts`는 실제 WebView2와 I/O Worker에서 목록, 생성과 빈 폴더 삭제,
독립적인 텍스트 쓰기 권한 거부를 검사하며 `mise run host:windows`에 포함한다.

`api/zod-promise.test.ts`는 ESM과 CommonJS의 실제 Worker에서 Zod의 형제 검사 실패,
끝나지 않는 검사, 정상 변환 횟수와 when, abort 동작을 확인한다.
`cli/zod-distribution.test.ts`는 새 프로젝트에 원본 Zod와 배포 패키지를 설치하고
설치된 CLI의 제품 및 개발 앱 번들에서 동일한 SDK 입력과 출력 회귀를 실행한다.
이 검사는 Win32, WebView2나 WKWebView의 실제 네이티브 실행을 대신하지 않는다.

`api/clipboard-formats.test.ts`와 `lifecycle/clipboard-codecs.test.ts`는 RGBA 상한과
canonical base64, 다중 형식의 JSON 예산, CF_HTML byte offset과 잘못된 UTF-8,
DIB의 행 방향과 padding, alpha 및 잘못된 profile, mask, 크기를 확인한다.
`clipboard-resources.test.ts`는 다중 HGLOBAL의 준비 실패와 부분 등록에서 소유권과
정리가 유지되는지 격리된 Win32 바인딩으로 확인한다. 실제 `windows-clipboard.test.ts`는
`mise run host:windows`에 포함되며 공통 SDK와 UI Worker에서 텍스트, HTML, RTF,
파일 목록과 이미지, 지원 형식 발견을 왕복한다. 테스트는 CI 데스크톱 clipboard를
변경하고 원래 Unicode 텍스트만 복원한다. WebView2 페이지나 다른 앱의 붙여넣기,
물리 장치 검증을 뜻하지 않는다.

`api/window-monitors.test.ts`는 음수 화면 원점, 32비트 rectangle overflow, 개별 조회 권한,
취소와 모니터 서비스 미지원 계약을 검사한다. `windows-monitors.test.ts`는 실제 Win32
디스플레이 열거와 MONITORINFOEXW rectangle, 주 모니터, 점과 rectangle 선택, 최소화 전
모니터 및 반복 callback 정리를 검사한다. `windows-bun-window-api.ts`는 실제 WebView2의
명령 컨텍스트에서 같은 조회와 권한 거부를 검사한다. 두 네이티브 검사는
`mise run host:windows`에 포함한다. CI의 디스플레이 구성에서 실행하며 실제 다중 물리
모니터의 hotplug, 혼합 DPI와 회전 또는 사용자 커서 조작 검증을 대신하지 않는다.


`api/window-monitor-events.test.ts`는 versioned snapshot과 이벤트 스키마, 독립 조회 권한,
취소와 선택적인 snapshot 서비스 미지원을 검사한다. 잘못된 protocol error가 포함된 snapshot은
`safeParse`와 `safeParseAsync`에서 예외 대신 Zod 오류를 반환하는지도 확인한다. `lifecycle/windows-monitor-events.test.ts`는
초기 replay 부재, id별 변경과 알림 병합, 배열 순서 변경 억제, 오류 중 마지막 유효 목록 보존,
오류 정제와 복구 및 반환 snapshot의 복사 격리를 검사한다. 같은 파일의 Windows 전용 검사는
실제 숨겨진 HWND에 WM_DISPLAYCHANGE, WM_SETTINGCHANGE와 WM_DEVICECHANGE를 보내고
제어한 모니터 값으로 메시지 처리 뒤 병합, 변경 억제와 정리를 확인한다.

`lifecycle/windows-monitor-events.ts`는 실제 Win32와 WebView2, UI Worker, Core 및 SDK를
연결한다. 테스트 번들에서만 실제 디스플레이 열거에 합성 이름 변경과 조회 실패를 추가한다.
실제 알림 HWND에 합성 메시지를 보내 이벤트 전달, 이벤트 또는 조회 권한 누락, 초기 replay 부재,
오류 복구, 구독 해제 뒤 snapshot 복구, 탐색과 창 재생성 및 종료 정리를 검사한다.
두 Windows 전용 검사는 `mise run host:windows`에 포함한다. 실제 모니터 구성이나 OS 설정을
변경하지 않으며 물리 장치 hotplug, 혼합 DPI, 회전 검증을 대신하지 않는다.

`api/power.test.ts`는 배터리의 0과 unknown, 배터리 없음, DWORD tick 순환,
독립 blocker ID와 128개 상한, 부분 활성 실패 및 반복 정리를 검사한다.
`power-cleanup.test.ts`는 실제 어댑터와 두 handle 소유자를 번들해 격리된 Win32 바인딩에서
public 요청 해제와 활성 rollback 해제가 함께 실패해도 모든 handle을 재시도하고,
미해제 handle이 있는 동안 DLL을 유지하며 두 단계의 오류를 보고하는지 검사한다.
`cli/power.test.ts`는 isolated tarball 설치와 I/O 어댑터 발견, browser의 FFI 제외를 검사한다.
`windows-power.test.ts`는 실제 GetSystemPowerStatus와 session idle query, PowerCreateRequest,
system/display 활성 및 GetHandleInformation으로 명시 해제와 종료 시 handle 정리를 확인한다.
`windows-power-worker.test.ts`는 빌드한 공개 power API에서 실제 I/O Worker까지 상태와 idle,
독립 ID, 개별 권한 거부, 명시 해제와 종료 정리를 확인한다.
`mise run host:windows`에 포함하며 물리 배터리 전환, 화면 꺼짐과 idle 절전 또는
Modern Standby 및 사용자 절전 후 요청 종료의 하드웨어 검증을 대신하지 않는다.

`appearance.test.ts`는 선호의 null, 색 형식과 개별 operation 권한, 호출 컨텍스트를 확인한다.
CLI의 같은 이름 검사는 로컬 tarball의 isolated 설치, 네이티브 I/O 어댑터 발견과 browser
번들의 FFI 제외를 검사한다. `windows-appearance.test.ts`는 실제 Windows 고대비,
client-area animation, screen reader 설정 플래그 및 시스템 색과 비교하고 두 어댑터의
DLL 수명과 종료 후 거부를 확인한다. `mise run host:windows`에 포함한다.
사용자 테마 변경과 실제 보조 기술 또는 WebView 접근성 트리 검증을 대신하지 않는다.

`system-events.test.ts`는 선택 OS 알림 HWND의 지연 생성, 중복 해제, 조회 실패 후 복구,
WTS 등록 실패, 상태 알림 합치기, lifecycle 순서와 큐 초과를 검증한다. 복귀 뒤 사용자
활동 알림이 다른 pump 배치 또는 설정 알림 뒤에 도착해도 resume이 중복되지 않는지 검사한다. 조회 권한과
현재 이벤트 route를 모두 가진 수신자에게만 전달하는 계약도 검사한다.
`windows-system-events.test.ts`는 실제 Windows 숨김 HWND, 메시지 pump와 WTS 등록을
사용한다. 메시지는 합성 입력이며 실제 하드웨어 절전이나 사용자 세션 잠금 검증을
대신하지 않는다. Linux에서는 이 네이티브 회귀를 건너뛴다.

`api/image.test.ts`와 `lifecycle/image-resources.test.ts`는 선택 image 플러그인의
Zod 계약과 canonical base64, 빈 이미지, operation 권한, ID 해제와 앱 종료,
count와 메모리 quota 및 생성 취소의 정리를 확인한다. `windows-image.test.ts`는
`host:windows`에 포함하며 공통 SDK와 실제 UI Worker, WIC에서 PNG와 data URL의
RGBA alpha 왕복, JPEG와 BMP, 잘못된 encoded 입력과 decode 크기, 최대 PNG,
정책 거부와 결과 전달 전 취소를 확인한다. 실제 파일 경로 접근, WebView 표시,
다른 앱의 가져오기, 색상 관리와 최소 Windows 버전 검증은 포함하지 않는다.

`image-crop.test.ts`는 offset rectangle과 행 복사, alpha, 소스 보존, 잘못된 영역,
생성 취소와 새 ID를 확인한다. `image-resize.test.ts`는 nearest resize의 출력 중심 선택,
축소와 비정수 비율, 투명 RGB와 반투명 채널의 정확한 복사, 소스 보존과 크기 상한을 확인한다.
`windows-image.test.ts`는 실제 UI Worker의 nearest resize와 WIC linear resize,
linear filtering의 투명 edge, crop과 빈 소스 및 quota 오류를 추가로 검사한다.
이 transform 검사도 `host:windows`에서 실행하며 소스 리소스는 변경하지 않는다.

`api/os.test.ts`는 독립 작업 권한과 metadata 계약을 검사한다. `lifecycle/windows-os.test.ts`는
실제 Kernel32 언어 설정 조회와 Bun 실행 정보를 생성 어댑터에서 검사하며 `host:windows`에 포함된다.
사용자 언어 설정 변경이나 translation 하드웨어 검증은 포함하지 않는다.

`api/process-plugin.test.ts`는 local `.exe` argv 계약과 독립 실행 권한을 검사한다.
`lifecycle/process-run.test.ts`는 실제 Bun 자식의 특수 인자, binary stdin/stdout/stderr, 합계
출력 제한과 내부 실행 작업의 취소 후 직접 자식 종료를 확인한다. `windows-process.test.ts`는 생성 Windows
어댑터의 timeout, capacity와 폐기를 실제 `.exe`로 확인한다. 실제 core/client 공개 호출에서 취소
전달을 보류해 공개 Promise 거부 시 자식이 아직 살아 있음을 확인하고, 전달 후 어댑터의 정리와
자식 종료를 확인한다. 공개 Promise 거부는 종료 완료를 보장하지 않는다. 두 검사는 `host:windows`에 포함되며
호출별 손자 정리나 제삼자 도구의 부수 효과를 검증하지 않는다.
자식은 PID 파일 쓰기를 완료한 뒤 rename으로 준비를 알린다. 두 생존 검사는 파일 생성과 쓰기 사이의
경합으로 빈 PID를 읽지 않고, 취소 전에 실제 자식의 Windows process handle을 잡는다.

`api/network.test.ts`는 URL, header, bytes 상한과 독립 작업 권한을 검사한다.
`lifecycle/windows-network.test.ts`는 생성 Windows와 macOS 어댑터 및 실제 loopback HTTP/WebSocket 서버로
redirect 거부, binary 보존, timeout, 취소, 폐기와 용량을 검사한다. `host:windows`에 포함되며
외부 proxy나 OS 인증, 물리 네트워크 설정 검증은 포함하지 않는다.

`lifecycle/macos-network.ts`는 `host:macos`에서 compiled WKWebView, SDK, Core와 async UI
어댑터를 실제 loopback 서버에 연결한다. 뷰별 grant와 앱 명령의 출처 유지, backend grant,
HTTP binary 및 UTF-8, redirect와 WebSocket handshake 거부, decompressed body 상한,
text/binary 메시지, timeout과 SDK deadline, 취소 뒤 실제 TCP 정리와 종료 중 pending 요청 정리를
확인한다. 결과는 `build/macos-native-logs/network-results.json`이며 기존 네이티브 CI artifact에 포함된다.
`cli/network.test.ts`는 isolated tarball 설치의 두 OS native export에서 실제 HTTP를 실행하고
browser 번들에 Bun 전송 구현이 포함되지 않는지 검사한다. TLS, 외부 proxy와 OS 인증은 검증하지 않는다.

`lifecycle/windows-trash.test.ts`는 실제 Windows I/O STA에서 파일을 휴지통으로
보내고 해당 `$I` 메타데이터와 `$R` 파일 내용을 확인한다. HTML 연결 폴더 보존,
파일 소실, 부모 고정과 삭제 공유 중 파일 교체 거부를 검사한다. 테스트는 해당
파일의 휴지통 항목만 정리하며 전체 휴지통을 비우지 않는다. 셸이 유지하는 COM Worker가
다른 초기화 회귀에 영향을 주지 않도록 별도 Bun 프로세스에서 실행한다. `host:windows`에
포함하며 사용자 설정별 휴지통 비활성화, 용량 초과와 경고 UI는 수동 검증 항목이다.

`lifecycle/macos-io-host.ts`는 `host:macos`의 실제 compiled WKWebView에서 공통
I/O Worker의 실행, 백엔드 setup과 뷰 출처, 파싱 전 정책 검사, UI/I/O 지원 목록,
동기 I/O 중 AppKit 왕복, 취소와 문서 폐기, 초기화 실패와 5초 종료 기한을 검사한다.
테스트 어댑터는 실제 파일을 쓰며 개별 제품 플러그인의 macOS 지원 검증과 구분한다.
`build/macos-io-results.json`에는 OS, CPU, Bun revision과 시나리오별 종료 결과를 남긴다.
공통 Worker와 메인 호스트를 사용하는 `macos-bun.test.ts`의 I/O 파싱 취소 검사는
Linux에서도 실행하며 실제 AppKit은 대체한다.

`macos-bun.test.ts`는 진행 중인 백엔드 I/O의 abort를 기다리는 StopHook도 실제
Worker로 검사한다. 종료 요청이 I/O 취소를 먼저 전달하고 코어 훅 뒤에 어댑터를
폐기해 강제 종료 없이 끝나는지 확인한다. 실제 WKWebView fixture도 같은 순서를 검사한다.

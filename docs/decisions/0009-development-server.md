---
status: accepted
---

2026-10-07: 프로덕션 웹 빌드 자동 실행은 후속 [ADR 0012](./0012-integrated-app-build.md)에서 구현한다.
2026-10-09: Windows 개발 모드는 호환되는 앱 명령 구현만 교체하고 코어와 네이티브 호스트의 수명을 유지한다.

# UI 개발 서버는 외부 도구가 소유하고 CLI가 실행 수명주기를 관리한다

Vite, Next.js/Turbopack 등의 개발 서버를 네이티브 창과 연결한다. bunaway가 UI
개발 서버나 HMR을 다시 구현하지 않는다. `src-bunaway/bunaway.json` v1에 선택적
`dev.command`(실행 파일과 인자 배열), `dev.url`, `dev.timeoutMs`를 추가한다.
이 결정은 ADR 0007의 HMR 설정 제외 범위와 기존 CLI의 로컬 자산 전용 dev 제한을
확장한다. 앱, 권한 작성 형식, Web/IPC wire 계약과 프로덕션 자산 origin은 유지한다.

CLI는 프로젝트 루트에서 명령을 shell 없이 실행하고 지정 URL의 HTTP 2xx 응답을
기다린 뒤 호스트를 시작한다. 명령 출력은 터미널에 그대로 전달한다. 기존 listener를
임의로 채택하지 않고 포트 충돌로 실패한다. redirect는 준비 완료로 간주하지 않는다.
Windows는 별도 Bun worker의 kill-on-close Job, POSIX는 프로세스 그룹으로 개발
명령의 자손을 종료한다. 서버 조기 종료, timeout, Ctrl+C, 창 닫기는 전체 개발 실행을
정리한다. 백엔드 빌드 실패는 서버를 유지하면서 다음 소스 변경을 기다린다.

`dev.url`은 localhost 또는 127.0.0.1의 HTTP(S) URL만 허용하며 TLS 검증을 우회하지
않는다. 개발 산출물의 해시 inventory에 `app.json.development.url`을 포함하고,
호스트 실행의 `--dev-url`과 일치해야 한다. 해당 뷰의 기존 명령, 이벤트, Host 권한은
유지하고 생성된 개발 정책의 origin만 정확한 개발 origin으로 교체한다. 작성한
policy.json은 수정하지 않는다. 네이티브가 관찰한 출처, 최상위 frame, 세션, 컨텍스트
검사는 계속 적용한다. Windows 가상 호스트는 app.bunaway.local에만 매핑하며,
macOS는 해당 자산 호스트만 bunaway://로 변환한다. 개발 서버 URL은 변환하지 않는다.

외부 서버 모드에서 CLI는 UI를 검증 번들하거나 배포 자산으로 복사하지 않는다.
프런트엔드 출력 디렉터리가 아직 없어도 개발할 수 있다. UI의 변경, HMR, 오류 화면은
서버가 담당한다. CLI는 src-bunaway, build.app 앱 정의 디렉터리와 루트
package.json, bun.lock, tsconfig.json 변경과 앱 정의가 import한 프로젝트 내부 전이 의존성을 감시한다.
성공한 검증마다 의존성 목록을 갱신하고 실패하면 이전 목록을 유지한다.
Windows에서는 명령 이름과 입력, 출력, 이벤트 계약, 상태 초기값이 같고 같은 플러그인
객체와 desktop 콜백을 사용하면 앱 명령 구현만 교체한다. 코어, StateStore, 창, 문서,
세션, 구독과 inspector 연결은 유지하며 진행 중인 명령은 기존 코드로 완료한다.
모듈 변수는 새로 초기화된다. 앱 import 단계에서 자원을 생성하면 교체 때 중복 실행될 수
있으므로 수명이 있는 자원은 플러그인 setup과 StopHook이 소유한다.

SDK와 설치된 네이티브 플러그인의 공통 모듈은 첫 개발 번들에 고정한다. 후속 앱 번들은
그 모듈을 참조해 오류 클래스, Host API 실행 컨텍스트와 플러그인 객체를 공유한다.
CLI가 시작한 개발 프로세스의 비공개 Bun IPC로 UUID와 앱 번들 해시를 전달하며 호스트는
해시와 세대 디렉터리 경계를 검증한 뒤 import한다. 프로덕션과 WebView에는 교체 API를 노출하지 않는다.
Bun의 ESM 캐시를 비울 수 없어 앱 코드는 프로세스당 100회까지 로드하며 이후에는 재시작한다.

호환되지 않는 앱 정의, 플러그인 객체나 실행 설정 변경은 전체 재시작한다. macOS도
기존 전체 재시작을 유지한다. 전체 재시작은 세션을 무효화하며 미완료 요청을 재전송하지 않는다.
앱 코드 빌드 실패는 실행 중인 앱과 개발 서버를 유지한다. dev 설정 변경은 서버도 교체한다.

`dev` 생략 시 UI 변경은 전체 호스트를 재시작하며 Windows 앱 코드 교체는 동일하게 적용한다.
로컬 UI도 사용하는 파일은 두 번들을 함께 갱신하기 위해 전체 재시작한다. 일반 build/package는
개발 URL과 marker를 포함하지 않으며 기존 로컬 자산을 사용한다. 외부 프런트엔드의
프로덕션 빌드 명령 자동 실행, Next.js SSR의 앱 패키징, 새 UI 템플릿은 별도 범위다.
구현과 Linux 계약 테스트는 실제 Windows/macOS 네이티브 검증 완료를 의미하지 않는다.

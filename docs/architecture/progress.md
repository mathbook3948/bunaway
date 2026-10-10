# 구현 진행 상태

개발 우선순위는 [ADR 0010](../decisions/0010-windows-first-platform-model.md)에 따라
Windows를 먼저 완성하고 다른 플랫폼을 같은 Bun 기반 개발 모델에 맞추는 것이다.
현재 macOS 호스트는 기존 자식 프로세스 구조를 사용한다. 아래 기록에는 선택 플러그인
이관 전의 저장, 메모 복원 검증이 포함되며, 이를 현재 플러그인 지원이나 장기 실행 모델로
해석하지 않는다.

## 2026-10-07 선택 네이티브 플러그인

저장, 로그와 기능 조회를 개별 패키지로 구현했다. 기본 생성 앱은 저장만 설치하고 등록한다.
Host 호출은 등록 계약을 검증하며 policy v1은 permissions, allow와 deny 구조를 사용한다.
Windows에서 실제 다중 뷰, 메모 재시작, 파일 핸들 검사와 I/O 취소 회귀를 검증했다.
macOS 네이티브 어댑터는 후속 작업이다. 네이티브 권한이 포함된 정책은 시작 때 거부하고,
권한이 없는 상태에서 네이티브 작업을 호출하면 `UNSUPPORTED`를 반환한다.

기준일: 2026-10-07. 현재 코드와 ADR, 기존 실행 기록 및 아래에 명시한 CI 실행을 대조했다.

선택 네이티브 플러그인의 구조와 공개 계약은
[ADR 0013](../decisions/0013-optional-native-plugins.md)와 [구조 계약](./plugins.md)에
확정하고 Windows 실행, 개별 패키지 배포와 새 v1 정책 구조를 구현했다.
공식 배포 전까지 정책 형식은 v1로 유지하며 개발 중 구조 변경으로 v2를 만들지 않는다.

과거 진행 문서의 “Windows 외 미구현”, “runtime-bun 플랫폼 windows 고정”은 현재 코드와
맞지 않는다. 아래는 요구사항 전체 완료 선언이 아니라 구현 및 검증 범위다.
새 macOS 회귀 실행은 [macOS 기록](./macos-native-results.md)에서 기존 검증과 구분한다.

2026-10-06 Windows 직접 FFI 실험에서
Bun UI Worker의 창, WebView2, 비동기 작업, 다중 창, 종료를 검증했다. 5초 종료 기준
초과는 공식 컨트롤에서도 재현됐다. C++ 프로브 결과만으로 제품 전환을 선언하지 않았고, 이후 실제 제품 회귀를 실행했다.
같은 날 실제 제품의 코어, 정책, Host API, 다중 창, CLI를 이식하고 기본 실행을 전환했다.
[실제 Bun FFI 검증](./windows-bun-results.md)은 기존 C++/CI 기록과 구분한다.
책임 분리, 채널, 수명, 이식 순서는 [Windows Bun UI Worker 구조안](../decisions/0006-windows-bun-ui-worker.md)에 정리했다.

| 단계 | 구현 상태 | 검증 범위, 근거 | 남은 작업, 미검증 |
| --- | --- | --- | --- |
| 개발 환경 | mise 기반 Bun 1.4.2, 8개 workspace, 타입 환경 분리, 개발자용 로컬 CLI artifact | 공통 CI 및 실제 tarball 외부 설치, 생성, 이동, 검증/typecheck 테스트 | 공개 publish, 프레임워크 라이선스 결정 |
| A 계약 | Web, 프로세스 IPC, 정책 단일 스키마, JSON 검증, 직렬화, 버전 협상 | 계약 테스트와 Windows/macOS 네이티브 검증기 회귀 | Linux, 모바일 네이티브 계약 준수 |
| B 번들 실행 실현성 | Windows x64 baseline, macOS arm64 Bun 1.4.2 고정. 독립 실험 코드는 제거 | 과거 플랫폼별 probe의 IPC, 계산, 이벤트, 오류, 정상/강제 종료 기록 | 다른 CPU/OS, 설치, 배포 |
| C 수직 기능 | client-sdk, core, runtime-bun, Win32/WebView2, AppKit/WKWebView, 메모 연결 | Windows 다중 창(3개), 뷰별 정책, macOS 단일 창/뷰의 명령, 이벤트, 경계, 렌더러 복구, 종료. 저장과 메모 파일 복원은 이관 전 기록 | macOS 다중 창/뷰, 다른 플랫폼 동등 검증 |
| D 플랫폼 확장 | macOS 제품 호스트 구현. Linux, Android, iOS 호스트 미구현. macOS 네이티브 플러그인 어댑터는 후속 작업 | macOS arm64 로컬 기록 및 네이티브 CI(정확한 실행 결과는 별도 기록) | macOS Intel, 최소 OS, Linux, 모바일 실행, 수명주기, 패키징 |
| E 배포 가능한 초기 버전 | CLI create/validate/doctor/dev/build, vanilla, Vite, React, Vue, Svelte, SDK/native 소스 artifact, 버전 lock, Windows 앱 패키지, macOS `.app`/ad-hoc, 선택 저장/로그/기능 조회 패키지와 Windows 어댑터 | CLI, artifact 계약 테스트, 기존 native 검증 기록(새 artifact의 플랫폼별 검증과 구분) | 공개 publish, 라이선스, UI framework 템플릿의 네이티브 실행 검증, macOS 다중 창, 설치, Developer ID, 공증, Store, 출시 기준 |
| F 선택 기능 | Chromium 렌더러 등 미구현 | 없음 | 선택 렌더러, 추가 네이티브 플러그인 |

## 구현 근거와 플랫폼 차이

- `packages/client-sdk/src/index.ts`의 `createClient`는 hello 협상, 명령 호출,
  이벤트 구독, 해제, deadline, 취소, 종료를 구현한다. `src/webview.ts`가 전송을 연결한다.
  화면용 `invoke`, `listen`과 인자 없는 `createClient()`는
  `src/default-client.ts`의 문서별 연결을 공유하며 초기화, 준비 대기, pagehide 정리를
  SDK에 맡긴다. 기본 연결의 지연 초기화, HMR 공유, 실패, 취소, 문서 종료는
  `tests/api/default-client.test.ts`에서 검증한다. 코드 커밋 `fae4b809b02a04355c8c862a8c896c7bbbd503cb`의
  [Windows 통합 CI](https://github.com/mathbook3948/bunaway/actions/runs/37554130779/job/112576287836)가
  2026-10-07 통과했다. 실제 창과 이동한 CLI 앱에서 기본 SDK 호출을 검증했으며,
  이 커밋 이후 #29의 변경은 문서뿐이다.
- `packages/core/src/create-core.ts`의 `createCore`는 명령, 상태, 이벤트, 세션, 정책과
  플러그인 초기화, 역순 정리를 구현한다. 다중 세션 계약은 실제 Windows 다중 창 검증과
  구분하며, 계약 테스트만으로 macOS 다중 창 지원을 주장하지 않는다.
- `packages/runtime-bun/src/runtime.ts`의 `runBunApp`은 boot/hello/ready,
  session-open/web/revoke, Host API 왕복, 취소, 종료를 IPC에 연결한다.
  `process.platform`을 공통 `Platform`으로 변환한다(`darwin`→`macos`).
  이 매핑이 Linux/모바일 네이티브 호스트 구현을 뜻하지 않는다.
- `native/windows/bun/`은 C++ 의존 없이 Bun 메인, UI STA Worker, I/O Worker를 연결한다.
  기본 CLI/mise/CI는 이 경로를 사용한다. 기존 Windows C++ 호스트, probe와 전용 실행기는 삭제했다.
  `windows[]`와 이전 단일 창 설정을 지원한다.
  창, 뷰별 WebView2 환경, 세션, 정책, 뷰 단위 복구, 마지막 창 종료 시 Job 정리를 구현한다.
  [창/뷰 ADR](../decisions/0004-multi-window-per-view-policy.md)은 Windows 범위다.
- `native/macos/host/main.mm`는 단일 `view`, `home`, `window` 설정을 사용한다.
  `WKURLSchemeHandler` 로컬 자산, 호스트가 관찰한 frame/origin, 탐색 시 세션 폐기,
  첫 탐색 전 `WKContentRuleList`, 범위 제한 `openat`과 FIFO, 링크 거부를 구현한다.
  렌더러만 재생성하고 Bun은 유지한다. Bun 프로세스 그룹과 guard로 종료를 관리하지만
  spawn→guard 연결 사이의 비정상 종료 race 제약은 남는다.
- Windows 다중 창 변경으로 공유 `app.json`이 macOS 호스트와 호환되지 않게 된 것을
  새 회귀 실행에서 확인했다. macOS 회귀용 단일 창 선언을 `native/macos/host/test/app.json`에
  분리했고 공통 정책, 백엔드, 페이지는 계속 공유한다. 다중 창을 조용히 단일 창으로 변환하지 않는다.
- 공유 메모 회귀 페이지의 Windows 영속 프로필 검사는 기본값으로 유지한다.
  macOS driver만 비영속 브라우저 저장소의 재시작 초기화를 명시적으로 검사하며,
  범위 제한 메모 파일 복원은 현재 Windows 플러그인으로 검증한다. macOS의 기존 기록은 이관 전 검증이다.
- `examples/memo/`는 CLI 생성 앱과 같은 `src/` + `src-bunaway/` 구조의 독립 단일 창 앱이다.
  예제 폴더의 `dev/build/package`로 실행, 빌드하며 여러 창과 자동 실행 시나리오는
  `tests/fixtures/desktop/host/`가 소유한다. `packages/cli`는 실제 create/validate/doctor/dev/build를
  제공하고 단일 뷰 vanilla, Vite, React, Vue, Svelte 템플릿을 생성한다.
  Vite 기반 생성 앱의 설치, 타입 검사, CSS/컴포넌트 HMR, 프로덕션 자산 번들은 CLI 테스트로
  검증하며, 실제 Windows/macOS 창의 UI 실행 검증과 구분한다. 저장과 로그, 기능 조회는 plugins/의 개별 패키지로 구현했다.
  CLI tarball에는 선택 패키지의 네이티브 구현을 넣지 않으며 필요한 앱이 따로 설치한다.
- 개발자용 CLI tarball은 SDK, 스키마, runtime pin, native source/tools, 라이선스 원문을
  함께 포함한다. 현재 생성 앱은 CLI, SDK 패키지를 node_modules에 설치하며
  package.json과 bun.lock으로 버전을 고정한다. [설치, 버전 정책](../framework-distribution.md)은 공개 publish나 채널별 앱 설치
  검증과 별개다. `vanilla`의 UI 갱신은 전체 호스트 재시작이며 Vite 기반 템플릿은 외부 서버의 HMR을 사용한다.

## 실행 근거: 기존 기록과 새 실행을 분리

- [Windows B 기록](./windows-probe-results.md): 2026-10-04 로컬 probe 50개.
- [Windows C 기록](./windows-host-results.md): 2026-10-05 Windows Server 2022,
  다중 창/뷰 정책 분리, 렌더러/창 격리, 기존 설정 호환. 여기에 이번 macOS 결과를 합치지 않는다.
- [기존 CI PR](https://github.com/mathbook3948/bunaway/pull/9): 공통 검사 3개 OS와
  Windows probe/실제 WebView2 및 artifact 업로드 성공 기록.
- [macOS 기록](./macos-native-results.md): 이전 macOS 26.5.2 arm64 검증과 이번
  로컬/Actions 실행을 별도 표기한다. 기존 `.app` 성공이 새 CI나 현재 샘플 설정의 성공은 아니다.

현재 CI는 세 운영체제의 공통 검사와 Windows 및 macOS 네이티브 통합 검사를 실행한다.
독립 실험 실행기는 제거했으며 CI는 제품 호스트와 실제 런타임을 검증한다.
실제 GUI/WKWebView 결과 없이는 성공 처리하지 않으며 실패는 CI 실패로 전달한다.
결과 JSON, 테스트별 로그, 페이지 보고서는 진단 artifact로 보관한다(7일).
macOS는 `mise run host:macos -- --app`으로 ad-hoc 서명한 `.app`의 실행과 서명 유지,
배포 스크립트의 DMG 생성과 PKG 조립을 검사한다. Windows CI는 Inno Setup을 설치해
실제 설치, 업그레이드와 제거 회귀 테스트를 실행한다. 로컬에서는 Inno Setup이 있을 때 이 검사를 실행한다.
프로덕션 인증서, 실제 공증과 Store 제출은 이 검사 범위에 포함하지 않는다.

## 이어서 할 작업

1. macOS 다중 창/뷰와 현재 Windows 다중 창 메모 설정 지원 여부를 별도 작업으로 결정한다.
2. 명령 타입 생성, macOS 네이티브 플러그인 어댑터, 공개 릴리스 절차를 구현하고 React/Vue/Svelte 템플릿의 실제 네이티브 실행을 검증한다.
3. 최소 OS, CPU, Windows WebView2 설치, macOS Developer ID, 공증, 설치, 배포를 검증한다.
4. Linux, Android, iOS의 Bun 실행, 배포, 수명주기를 각 플랫폼에서 구현, 검증한다.
5. UI 프레임워크 예제, 성능, 패키지 크기와 PRD 출시 기준을 확인한다.

[플랫폼 지원 표](../platform-support/README.md)는 검증 환경과 출시 지원을 구분한다.
[공통 API](./common-api.md)와 [모듈 의존성](./workspace.md)이 현재 계약이며,
[C ABI 초안](./native-abi.md)은 이전 동일 프로세스 설계 기록이다.

선택 플러그인 분리에서 창 제어도 @bunaway/plugin-windows로 옮겼다. @bunaway/plugin-api를 통해 플러그인 SDK의 Backend SDK와 Core 의존성을 제거했다. 공통 프로토콜의 창 작업 목록과 전용 정책 필드는 제거하고 등록 계약과 permissions로 검사한다. 이 변경의 실제 GUI 검증은 CI에서 확인해야 한다.

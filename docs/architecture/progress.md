# 구현 진행 상태

기준일: 2026-10-05. 작업 시작 시 최신 main
`5a9641eeac9c44a670d43cefb23069db833ed221`의 코드, ADR과 기존 실행 기록을 대조했다.
과거 진행 문서의 “Windows 외 미구현”, “runtime-bun 플랫폼 windows 고정”은 현재 코드와
맞지 않는다. 아래는 요구사항 전체 완료 선언이 아니라 구현 및 검증 범위다.
새 macOS 회귀 실행은 [macOS 기록](./macos-native-results.md)에서 기존 검증과 구분한다.

| 단계 | 구현 상태 | 검증 범위·근거 | 남은 작업·미검증 |
| --- | --- | --- | --- |
| 개발 환경 | mise 기반 Bun 1.4.2, 8개 workspace, 타입 환경 분리 | 3개 OS 공통 CI의 frozen install·format·lint·typecheck·계약 테스트, Ubuntu 생성 스키마 diff | 범용 CLI dev/build·프로젝트 생성 |
| A 계약 | Web·프로세스 IPC·정책 단일 스키마, JSON 검증·직렬화·버전 협상 | 계약 테스트와 Windows/macOS 네이티브 검증기 회귀 | Linux·모바일 네이티브 계약 준수 |
| B 번들 실행 실현성 | Windows x64 baseline·macOS arm64 Bun 1.4.2 고정, WebView 없는 독립 패키지 | 플랫폼별 probe의 IPC·계산·이벤트·오류·정상/강제 종료 | 다른 CPU/OS·설치·배포 |
| C 수직 기능 | client-sdk·core·runtime-bun, Win32/WebView2·AppKit/WKWebView, 메모 연결 | Windows 다중 창(3개)·뷰별 정책, macOS 단일 창/뷰의 저장·이벤트·복원·렌더러 복구·경계·종료 | macOS 다중 창/뷰·다른 플랫폼 동등 검증 |
| D 플랫폼 확장 | macOS probe·제품 호스트 구현. Linux·Android·iOS 호스트 미구현 | macOS arm64 로컬 기록 및 네이티브 CI(정확한 실행 결과는 별도 기록) | macOS Intel·최소 OS, Linux·모바일 실행·수명주기·패키징 |
| E 배포 가능한 초기 버전 | Windows 앱 패키지·메모 샘플, macOS `.app` 생성·ad-hoc 서명 스크립트 | 기존 macOS 로컬 `.app` 서명 확인·실행 기록 | CLI·플러그인·템플릿, macOS 현재 다중 창 메모 설정, 설치·Developer ID·공증·스토어·출시 기준 |
| F 선택 기능 | Chromium 렌더러 등 미구현 | 없음 | 선택 렌더러·추가 네이티브 플러그인 |

## 구현 근거와 플랫폼 차이

- `packages/client-sdk/src/index.ts`의 `createClient`는 hello 협상, 명령 호출,
  이벤트 구독·해제, deadline·취소·종료를 구현한다. `src/webview.ts`가 전송을 연결한다.
- `packages/core/src/create-core.ts`의 `createCore`는 명령·상태·이벤트·세션·정책과
  플러그인 초기화·역순 정리를 구현한다. 다중 세션 계약은 실제 Windows 다중 창 검증과
  구분하며, 계약 테스트만으로 macOS 다중 창 지원을 주장하지 않는다.
- `packages/runtime-bun/src/runtime.ts`의 `runBunApp`은 boot/hello/ready,
  session-open/web/revoke, Host API 왕복·취소·종료를 IPC에 연결한다.
  `process.platform`을 공통 `Platform`으로 변환한다(`darwin`→`macos`).
  이 매핑이 Linux/모바일 네이티브 호스트 구현을 뜻하지 않는다.
- `native/windows/host/host.cpp`는 `windows[]`와 이전 단일 창 설정을 지원한다.
  창·뷰별 WebView2 환경·세션·정책, 뷰 단위 복구, 마지막 창 종료 시 Job 정리를 구현한다.
  [창/뷰 ADR](../decisions/0004-multi-window-per-view-policy.md)은 Windows 범위다.
- `native/macos/host/main.mm`는 단일 `view`·`home`·`window` 설정을 사용한다.
  `WKURLSchemeHandler` 로컬 자산, 호스트가 관찰한 frame/origin, 탐색 시 세션 폐기,
  첫 탐색 전 `WKContentRuleList`, 범위 제한 `openat`과 FIFO·링크 거부를 구현한다.
  렌더러만 재생성하고 Bun은 유지한다. Bun 프로세스 그룹과 guard로 종료를 관리하지만
  spawn→guard 연결 사이의 비정상 종료 race 제약은 남는다.
- Windows 다중 창 변경으로 공유 `app.json`이 macOS 호스트와 호환되지 않게 된 것을
  새 회귀 실행에서 확인했다. macOS 회귀용 단일 창 선언을 `native/macos/host/test/app.json`에
  분리했고 공통 정책·백엔드·페이지는 계속 공유한다. 다중 창을 조용히 단일 창으로 변환하지 않는다.
- 공유 메모 회귀 페이지의 Windows 영속 프로필 검사는 기본값으로 유지한다.
  macOS driver만 비영속 브라우저 저장소의 재시작 초기화를 명시적으로 검사하며,
  범위 제한 Host API의 메모 파일 복원 검사는 양 플랫폼에서 그대로 유지한다.
- `examples/memo/`의 앱 정의·화면은 macOS 회귀에서도 사용하지만 현재 배포용
  `app.json`은 Windows 다중 창 선언이다. macOS `--sample`로 복사한 패키지의 실행은
  지원하지 않는다. `packages/cli`, `plugins/log`, `plugins/storage`는 빈 모듈이며
  네이티브 Host API 로그/저장 구현과 배포할 기본 플러그인 완료는 다르다.

## 실행 근거: 기존 기록과 새 실행을 분리

- [Windows B 기록](./windows-probe-results.md): 2026-10-04 로컬 probe 50개.
- [Windows C 기록](./windows-host-results.md): 2026-10-05 Windows Server 2022,
  다중 창/뷰 정책 분리·렌더러/창 격리·기존 설정 호환. 여기에 이번 macOS 결과를 합치지 않는다.
- [기존 CI PR](https://github.com/mathbook3948/bunaway/pull/9): 공통 검사 3개 OS와
  Windows probe/실제 WebView2 및 artifact 업로드 성공 기록.
- [macOS 기록](./macos-native-results.md): 이전 macOS 26.5.2 arm64 검증과 이번
  로컬/Actions 실행을 별도 표기한다. 기존 `.app` 성공이 새 CI나 현재 샘플 설정의 성공은 아니다.

새 CI는 기존 공통 검사·Windows native를 유지하고 macOS native를 추가한다.
macOS 빌드는 공유 Bun 캐시 초기화 때문에 probe→host 직렬 실행한다.
실제 GUI/WKWebView 결과 없이는 성공 처리하지 않으며 실패는 CI 실패로 전달한다.
결과 JSON·테스트별 로그·페이지 보고서는 진단 artifact로 보관한다(7일).
`.app`·서명·설치 검증은 CI에 포함하지 않는다.

## 이어서 할 작업

1. macOS 다중 창/뷰와 현재 Windows 다중 창 메모 설정 지원 여부를 별도 작업으로 결정한다.
2. CLI·프로젝트 템플릿·명령 타입 생성·기본 로그/저장 플러그인을 구현한다.
3. 최소 OS·CPU, Windows WebView2 설치, macOS Developer ID·공증·설치·배포를 검증한다.
4. Linux·Android·iOS의 Bun 실행·배포·수명주기를 각 플랫폼에서 구현·검증한다.
5. UI 프레임워크 예제·성능·패키지 크기와 PRD 출시 기준을 확인한다.

[플랫폼 지원 표](../platform-support/README.md)는 검증 환경과 출시 지원을 구분한다.
[공통 API](./common-api.md)와 [모듈 의존성](./workspace.md)이 현재 계약이며,
[C ABI 초안](./native-abi.md)은 이전 동일 프로세스 설계 기록이다.

# 구현 진행 상태

기준일: 2026-10-05. PR #5 머지 후 main `e5c72963c306dad6782bdf7fc2391e3c019319c7`의
코드와 저장소 실행 기록을 기준으로 정리했다. 이 문서 정리에서는 앱·테스트를 재실행하지 않았다.
검증 완료는 아래에 연결한 기록의 환경과 항목에 한정한다.

| 단계 | 구현 상태 | 검증 완료 범위 | 남은 작업·미검증 |
| --- | --- | --- | --- |
| 개발 환경 | mise 기반 Bun 1.4.2, 8개 workspace, 타입 환경 분리, 포맷·린트 | PR #5 기록의 workspace·테스트·메모 앱·호스트 백엔드 타입 및 lint·format 검사 | 범용 CLI의 dev/build·프로젝트 생성 |
| A 계약 | Web·프로세스 IPC·정책 단일 스키마, 타입 추론, JSON 검증·직렬화, 버전 협상, 네이티브 스키마 생성 | 계약 테스트 및 Windows 네이티브 검증기 회귀 | 다른 플랫폼의 계약 준수 검증 |
| B 번들 실행 실현성 | Windows x64 baseline Bun 1.4.2 고정, WebView 없는 C++ 독립 패키지 | B 실행 기록의 IPC·계산·이벤트·오류·정상/강제 종료 | PR #5에서는 B 실험 미재실행. 다른 OS와 설치·배포 미검증 |
| C 수직 기능 | 실제 client-sdk·core·runtime-bun, Win32·WebView2 호스트, 메모 앱 연결 | Windows 단일 창/뷰의 명령→범위 제한 저장→이벤트→화면 갱신, 재실행 후 읽기, 렌더러 복구, 오류·취소·권한·종료 | 다중 창/뷰와 뷰별 정책 분리의 실제 호스트 검증 |
| D 플랫폼 확장 | Windows 외 호스트 미구현, 모바일 런타임 경로 미확정 | 없음 | macOS·Linux·Android·iOS의 실행·수명주기·패키징 |
| E 배포 가능한 초기 버전 | Windows 앱 패키지 빌드 스크립트·메모 샘플 있음. CLI·기본 플러그인·템플릿 미구현 | 독립 메모 패키지 빌드 성공 기록 | 설치 프로그램·서명·공증·스토어 배포·출시 기준 미충족 |
| F 선택 기능 | Chromium 렌더러 등 미구현 | 없음 | 선택 렌더러·추가 네이티브 플러그인 |

## 구현 근거

- `packages/client-sdk/src/index.ts`의 `createClient`는 hello 협상, 명령 호출,
  이벤트 구독·해제, deadline·취소·종료를 구현한다. `src/webview.ts`가 WebView 전송을 연결한다.
- `packages/core/src/create-core.ts`의 `createCore`는 명령·상태·이벤트·세션·정책 검사와
  플러그인 초기화·역순 정리를 구현한다. 다중 세션의 코어 계약 테스트가 실제 다중 창 검증을 뜻하지 않는다.
- `packages/runtime-bun/src/runtime.ts`의 `runBunApp`은 boot/hello/ready,
  session-open/web/revoke, Host API 왕복·취소와 코어 종료를 프로세스 IPC에 연결한다.
  플러그인 초기화 중에도 응답을 읽는다. 현재 플랫폼 서비스는 `windows`로 고정된다.
- `native/windows/host/host.cpp`는 ready 후 첫 WebView 탐색, 호스트 발급 컨텍스트,
  origin·frame·세션·정책 검사, 범위 제한 파일 open, 렌더러 장애 후 세션 재생성과 Job 정리를 구현한다.
- `examples/memo/`는 `memo.save`→`appData/notes/memo.txt`→`memo.saved`와
  시작·뷰 재생성 시 `memo.read`를 연결한다. 실제 저장 후 취소가 파일 변경을 롤백하지 않는다.
- `packages/cli`, `plugins/log`, `plugins/storage`는 빈 모듈이다. Host API의 로그·저장
  구현과 배포할 기본 플러그인의 구현 완료는 구분한다.

## 실행 근거

[Windows C 실행 결과](./windows-host-results.md)에는 2026-10-05 환경과 재현 명령,
Windows 통합 검증 5개·페이지 검사 28개·메모 화면 검사 3회·네이티브 회귀 8개,
계약 테스트 108개(861 assertions)의 통과 기록이 있다.
메모 저장 버튼·이벤트 화면 갱신·호스트와 Bun 재실행 후 복원·렌더러 강제 종료 후
새 세션 연결·정상/강제 종료 시 Bun 정리를 확인했다. 메모 UI 통합 검증은 같은 앱 정의와
화면에 테스트 보고 명령을 더한 패키지에서 실행했고, 독립 메모 패키지는 빌드 성공을 기록했다.

[Windows B 실행 결과](./windows-probe-results.md)는 별도 실험 호스트의 기록이다.
PR #5에서 이를 재실행하지 않았으므로 C 실행 기록과 합쳐 새 검증 결과로 보고하지 않는다.
실행 로그·JSON은 `build/` 산출물이며 저장소에 포함되지 않는다. 재현 경로는
`mise run check`, `mise run host:windows`, 별도의 `mise run probe:windows`다.

## 이어서 할 작업

1. Windows 다중 창/뷰와 뷰별 정책 분리를 실제 호스트에서 검증한다.
2. CLI·프로젝트 템플릿·명령 타입 생성·기본 로그/저장 플러그인을 구현한다.
3. WebView2 설치 경로, 설치 프로그램·서명·배포와 최소 OS·CPU 지원 범위를 검증한다.
4. macOS·Linux 호스트와 Android·iOS의 Bun 실행·배포 경로를 각 플랫폼에서 구현·검증한다.
5. PRD의 출시 기준에 따라 UI 프레임워크 예제, 성능·패키지 크기와 지원 표를 확인한다.

Windows 단일 창·단일 뷰(`main`) 성공은 다른 플랫폼·다중 창/뷰·설치·서명·배포 완료를 뜻하지 않는다.
WebView2 Evergreen 런타임은 별도로 필요하다.
[C 공통 API](./common-api.md)와 [모듈 의존성](./workspace.md)이 현재 실행 계약이며,
[C ABI 초안](./native-abi.md)은 이전 동일 프로세스 설계의 기록이다.

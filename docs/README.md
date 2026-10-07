# 문서 안내

앱 개발을 처음 시작한다면 [MDX 개발 가이드 사이트](./site/README.md)를 먼저 읽는다.
저장소 루트에서 `bun run docs:dev`로 연다. 전체 구조와 첫 앱 실행을 익힌 뒤 프로젝트 파일, 뷰별 정책, 명령과 이벤트 순서로 읽는다. 검색과 목차, SDK 및 설정 레퍼런스도 있다.
사이트의 프레임워크 기여 섹션과 아래 자료는 프레임워크 개발 및 설계 검토에 사용한다.
앱 개발 가이드에서는 사용법과 결과, 권한, 오류를 설명한다.

제품 범위는 [PRD](./PRD.md)에, 공통 용어는 [용어집](./GLOSSARY.md)에 정리한다. 현재 구현과 다음 작업은 [진행 상태](./architecture/progress.md)에서 확인할 수 있다.

[데스크톱 기능 TODO](./TODO.md)는 Tauri와 Electron의 공개 기능을 대조한 개발 목록이다.
현재 Windows 구현과 남은 기능, 우선순위 및 플랫폼별 후속 작업을 구분한다.

## 설계와 구현 계약

- [개발자용 프레임워크 설치 artifact, 버전, 업그레이드](./framework-distribution.md)
- [Vite, Next.js 등 외부 UI 개발 서버 연결](./development-server.md)

- [모듈 의존성과 타입 환경](./architecture/workspace.md)
- [IPC와 정책 계약](./architecture/protocol.md)
- [SDK, 코어, Host API 공통 계약](./architecture/common-api.md)
- [선택 네이티브 플러그인의 공개 계약과 이관 구조](./architecture/plugins.md)
- [번들 Bun 실행 방식과 실험 범위](./architecture/runtime-feasibility.md)
- [Windows B 실행 결과](./architecture/windows-probe-results.md)
- [Windows C 호스트, SDK, 코어, 메모 실행 결과](./architecture/windows-host-results.md)
- [Windows Bun FFI 제품 실행 결과, 제약](./architecture/windows-bun-results.md)
- [macOS probe, WKWebView 회귀 검증: 기존/새 실행 기록](./architecture/macos-native-results.md)
- [플랫폼 지원, CPU, CI와 출시 검증 범위](./platform-support/README.md)
- [Windows 메모 샘플 실행 방법](../examples/memo/README.md)

## 설계 결정

PRD와 설계 문서, 코드에서 확인한 결정을 ADR에 기록한다. 구현 여부와 플랫폼 검증 결과는 진행 상태 및 실행 기록에서 확인한다.

- [0001: 번들 Bun의 별도 프로세스 실행](./decisions/0001-bundled-bun-process.md)
- [0002: 호스트가 소유하는 호출 컨텍스트](./decisions/0002-host-owned-call-context.md)
- [0003: 단일 스키마와 분리된 프로토콜](./decisions/0003-shared-schema-separate-protocols.md)
- [0004: Windows 창/뷰별 정책과 수명 분리](./decisions/0004-multi-window-per-view-policy.md)
- [0005: 설치 artifact와 생성 앱의 vendor snapshot](./decisions/0005-framework-artifact.md)
- [0007: 통합 v1 앱 설정과 생성 폴더 구조](./decisions/0007-project-settings.md)
- [0008: 설치 패키지와 bun.lock 기반 프레임워크 의존성](./decisions/0008-installed-framework-packages.md)
- [0006: Windows Bun 진입점, UI Worker, 직접 FFI](./decisions/0006-windows-bun-ui-worker.md)
- [0009: 외부 UI 개발 서버와 CLI 수명주기](./decisions/0009-development-server.md)
- [0010: Windows 우선 개발과 공통 Bun 앱 정의](./decisions/0010-windows-first-platform-model.md)
- [0011: 기능 모듈 조립과 중복 명령 거부](./decisions/0011-app-module-composition.md)
- [0012: 웹 빌드와 앱 빌드의 통합](./decisions/0012-integrated-app-build.md)
- [0013: 네이티브 기능의 개별 플러그인 설치와 등록](./decisions/0013-optional-native-plugins.md)

[이전 C ABI 초안](./architecture/native-abi.md)은 과거 설계 기록이다. 현재 Windows는 Worker 연결,
macOS는 프로세스 IPC 계약을 사용한다.

## 에이전트 작업 규칙

- [GitHub Issues 사용 규칙](./agents/issue-tracker.md)
- [도메인 문서 경로와 읽기 규칙](./agents/domain.md)

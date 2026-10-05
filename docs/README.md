# 문서 안내

제품 범위는 [PRD](./PRD.md), 공통 용어는 [용어집](./GLOSSARY.md), 현재 구현 범위와 다음 작업은 [진행 상태](./architecture/progress.md)를 기준으로 읽는다. 설계 계약과 실행 검증 결과는 구분한다.

## 설계와 구현 계약

- [모듈 의존성과 타입 환경](./architecture/workspace.md)
- [IPC와 정책 계약](./architecture/protocol.md)
- [SDK·코어·Host API 공통 계약](./architecture/common-api.md)
- [번들 Bun 실행 방식과 실험 범위](./architecture/runtime-feasibility.md)
- [Windows B 실행 결과](./architecture/windows-probe-results.md)
- [Windows C 호스트·SDK·코어·메모 실행 결과](./architecture/windows-host-results.md)
- [macOS probe·WKWebView 회귀 검증: 기존/새 실행 기록](./architecture/macos-native-results.md)
- [플랫폼 지원·CPU·CI와 출시 검증 범위](./platform-support/README.md)
- [Windows 메모 샘플 실행 방법](../examples/memo/README.md)

## 설계 결정

기존 PRD·설계 문서와 코드에서 확인한 결정을 기록한다. ADR의 채택 상태는 구현이나 플랫폼 검증의 완료를 뜻하지 않는다.

- [0001 — 번들 Bun의 별도 프로세스 실행](./decisions/0001-bundled-bun-process.md)
- [0002 — 호스트가 소유하는 호출 컨텍스트](./decisions/0002-host-owned-call-context.md)
- [0003 — 단일 스키마와 분리된 프로토콜](./decisions/0003-shared-schema-separate-protocols.md)
- [0004 — Windows 창/뷰별 정책과 수명 분리](./decisions/0004-multi-window-per-view-policy.md)

[이전 C ABI 초안](./architecture/native-abi.md)은 동일 프로세스 설계 당시의 기록이다. 현재 구현 기준은 프로세스 IPC 계약이다.

## 에이전트 작업 규칙

- [GitHub Issues 사용 규칙](./agents/issue-tracker.md)
- [도메인 문서 경로와 읽기 규칙](./agents/domain.md)

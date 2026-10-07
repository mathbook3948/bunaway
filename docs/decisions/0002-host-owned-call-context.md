---
status: accepted
---

# 호출 출처와 권한 컨텍스트는 네이티브 호스트가 소유한다

WebView에서 전달한 출처나 권한을 그대로 믿으면 앱 명령이 더 넓은 권한의 네이티브 작업으로 이어질 수 있다. 네이티브 호스트가 관찰한 뷰, 세션, origin, frame을 바탕으로 호출 컨텍스트를 발급하고, 백엔드의 Host API 호출에도 그 컨텍스트를 유지한다. 웹 메시지의 자기 신고값이나 TypeScript 타입 브랜드를 인증 수단으로 사용하지 않는다.

이를 위해 세션과 컨텍스트의 발급, 폐기 및 네이티브 작업 직전의 권한 재검사가 필요하다. 뷰의 요청을 백엔드 자체 작업으로 승격하지 않으며, 정책에 따른 기능 허용과 OS 권한은 각각 확인한다. 앱 백엔드와 네이티브 플러그인은 신뢰 코드이므로 이 경계를 악성 백엔드의 샌드박스로 설명하지 않는다.

현재 Windows 호스트는 실제 WebView의 출처, 최상위 문서와 활성 세션을 검사하고 컨텍스트를 발급, 폐기한다. runtime-bun은 이 컨텍스트로 코어 세션을 열고 Host API 호출에 유지하며, 호스트는 작업 직전 정책, 저장 범위를 다시 검사한다. 다중 창/뷰의 위조, 권한 거부, 폐기와 파일 경계를 [실제 Windows에서 검증](../architecture/windows-host-results.md)했다. 뷰별 정책 분리는 [창/뷰 ADR](./0004-multi-window-per-view-policy.md)에 정리하고, 다른 플랫폼은 미검증이다.

근거: [PRD의 권한 모델](../PRD.md), [Host API와 세션 계약](../architecture/common-api.md), [컨텍스트 바인딩](../../packages/runtime-bun/src/host-api.ts), [런타임 연결](../../packages/runtime-bun/src/runtime.ts), [코어 구현](../../packages/core/src/create-core.ts), [Windows 호스트](../../native/windows/bun/entry.ts).

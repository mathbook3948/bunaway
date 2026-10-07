---
status: accepted
---

# IPC 계약은 단일 스키마에서 만들고 Web과 내부 프로토콜을 분리한다

TypeScript와 네이티브가 메시지 형식을 각각 정의하면 검증 규칙이 어긋날 수 있다. 메시지, 정책과 Host operation은 protocol 패키지의 스키마 정의를 원본으로 삼고, TypeScript 타입, 검증 및 네이티브용 JSON Schema를 여기서 만든다. Web 메시지와 호스트↔Bun 내부 envelope는 버전을 따로 관리해 런타임 세대, 컨텍스트, 수명주기 제어를 웹 입력과 분리한다.

현재 전송 계약은 크기와 깊이를 제한한 JSON이며, 프로세스 파이프에서는 UTF-8 NDJSON 프레임을 사용한다. 이 선택은 바이너리, 스트리밍 전송을 별도 계약으로 남기고, 스키마에 새 키워드를 추가할 때 양쪽 검증기의 지원도 맞춰야 하는 비용을 갖는다. 생성 스키마만으로 세션 상태나 권한, 실제 파일 접근 범위까지 검증했다고 간주하지 않는다.

현재 스키마 생성, 검증 코드와 생성물 일치 검사가 존재한다. Windows 실험의 네이티브 패턴 검증은 내장 계약에 한정되며, 임의 앱 정규식의 JavaScript와 동일한 문자 의미를 보장하지 않는다. 앱 명령, 이벤트 패턴은 JavaScript 측 검증을 따른다.

근거: [IPC와 정책 계약](../architecture/protocol.md), [메시지, 정책 스키마](../../packages/protocol/src/schema.ts), [Host operation 정의](../../packages/protocol/src/host-api.ts), [스키마 검사](../../tests/protocol/schema.test.ts).

---
status: accepted
---

# 모든 기능 플러그인을 선택으로 두고 Core에서 분리한다

결정일: 2026-10-07

[ADR 0013](./0013-optional-native-plugins.md)의 설치, 등록, 권한 및 개별 플랫폼 어댑터 계약은 유지한다. 창 제어가 공통 SDK와 프로토콜에 남아 있고 플러그인 작성 SDK가 Backend SDK를 통해 Core를 의존하는 부분을 제거한다.

저장, 앱 로그, 기능 조회와 창 제어는 각각 선택 패키지다. 공통 SDK나 호스트는 특정 플러그인을 자동 등록하지 않는다. 설치와 앱 등록, permissions 허용이 모두 필요하다. 등록하지 않은 작업은 지원하지 않는다.

@bunaway/plugin-api가 AppDefinition, PluginDefinition, CommandContext와 공통 실행 컨텍스트를 소유한다. Core와 Backend SDK는 이를 사용하며 플러그인 작성 SDK는 Core와 Backend SDK를 의존하지 않는다. browser와 bun의 조건별 호출 모델은 유지한다.

창 제어 패키지는 작업 계약, 권한, 공개 함수와 생성, 재생성 로직을 소유한다. 기본 창과 WebView, 앱 종료와 트레이 수명, 진단은 호스트 자원 관리로 유지한다. 창 제어 플러그인은 호스트가 제공하는 중립 자원 인터페이스를 사용한다.

공통 정책의 windows 필드와 PluginDefinition.requiredHost는 제거한다. 창 제어도 windows:list와 windows:control의 `{ view }` allow, deny를 사용하며 deny가 우선한다. 등록 플러그인 없는 정책의 permissions는 빈 배열이다.

Windows 구현을 우선하며 기존 네이티브 플러그인 경계 검증을 보존한다. macOS 네이티브 플러그인 어댑터는 ADR 0013과 같이 후속 작업이다. 기능 조회 문서는 Client SDK가 아닌 선택 플러그인 레퍼런스에 둔다.

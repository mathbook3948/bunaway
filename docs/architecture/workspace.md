# Workspace structure

Bun workspaces는 `packages/*`와 `plugins/*`에만 적용한다.
네이티브 코드, 번들된 Bun 배포물, 렌더러, 템플릿과 예제는 독립 영역이다.

| 경로 | 패키지 | TypeScript 환경 | 직접 workspace 의존성 |
| --- | --- | --- | --- |
| `packages/protocol` | `@bunaway/protocol` | portable | 없음 |
| `packages/client-sdk` | `@bunaway/client` | browser | `@bunaway/protocol` |
| `packages/backend-sdk` | `@bunaway/backend` | portable | `@bunaway/core`, `@bunaway/protocol` |
| `packages/core` | `@bunaway/core` | portable | `@bunaway/protocol` |
| `packages/runtime-bun` | `@bunaway/runtime-bun` | bun | `@bunaway/core`, `@bunaway/protocol` |
| `packages/cli` | `@bunaway/cli` | bun | 없음 |
| `plugins/log` | `@bunaway/plugin-log` | portable | `@bunaway/backend` |
| `plugins/storage` | `@bunaway/plugin-storage` | portable | `@bunaway/backend` |

`portable` 설정은 ES2022 표준 라이브러리만 허용한다.
`browser`는 DOM을 추가하고 `bun`만 Bun·Node 타입을 사용한다.
공통 베이스에 Bun·Node·DOM 타입을 전역으로 넣지 않는다.
패키지의 의존성은 `workspace:*`로 선언하며 경로 별칭으로 우회하지 않는다.

모든 패키지는 비공개다. `protocol`은 스키마·검증·직렬화·버전 협상을 구현했고
`runtime-bun`에는 UTF-8 NDJSON 수신기와 Host API 바인딩을 구현했다. client-sdk·core는
병렬 구현용 공통 타입, backend-sdk는 명령 입력·출력 검증을 제공한다. CLI·플러그인은 아직
빈 모듈이다. [공통 API](./common-api.md)를 따른다. 테스트·스키마 생성 스크립트·Windows 실험용 백엔드는 별도
`tests/tsconfig.json`에서 Bun 타입을 사용한다. portable 패키지에는 전파하지 않는다.
SDK·코어 실행은 공통 Factory 타입을 구현한다. CLI bin과 배포 exports는 구현 단계에서 확정한다.
빌드와 배포 설정은 실제 코드와 산출물 사용처가 생길 때 추가한다.

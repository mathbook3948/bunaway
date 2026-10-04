# C 단계 공통 API

이 계약을 기준으로 client-sdk, core/backend-sdk, Windows 호스트를 병렬 구현한다.
타입과 실행 가능한 명령·Host API 검증 헬퍼를 구현했다. `ClientFactory`, `CoreFactory`는
구현자가 맞춰야 할 타입이며 실제 `createClient`·`createCore` 구현은 각 작업에서 만든다.
기존 Web·프로세스 IPC 버전 1.0과 [프로토콜 규칙](./protocol.md)을 사용한다.

## 공유하는 코드

| 계약 | 소유 패키지 | 소비자 |
| --- | --- | --- |
| `Transport`, `ClientMessage`, `ServerMessage`, 취소·오류·제한 | protocol | SDK·코어·호스트 어댑터 |
| `Client`, `ClientFactory`, `InvokeOptions`, `EventDelivery` | client-sdk | UI·WebView transport |
| `AppDefinition`, `CommandDefinition`, `CommandContext`, 플러그인·상태·이벤트 | core, backend에서 재수출 | 앱·플러그인·코어 |
| `Core`, `CoreSession`, `CoreFactory`, `CoreServices`, `RuntimeServices` | core | runtime-bun |
| Host operation별 입력·출력 스키마, `HostAPI`, `HostContext` | protocol | 코어·플러그인·runtime·네이티브 |
| `command`, `bindHostAPI` | backend, runtime-bun | 앱 정의·Host API 어댑터 |

추가 의존성은 없다. portable 코어는 DOM·Bun·Node 전역 타입 없이 컴파일한다.
`CancellationSignal`은 표준 AbortSignal의 `aborted`, abort 리스너 등록·해제 부분이며
표준 AbortController를 그대로 공급할 수 있다. 코어는 `RuntimeServices.createCancellation`,
`now`, `schedule`을 주입받아 요청·세션·앱 수명과 단조 시계 타이머를 관리한다.

## 클라이언트와 Transport

`ClientFactory({ transport, hello })`는 즉시 Client를 반환한다. Client는 먼저 수신을 구독하고
hello를 교환하며 `ready`에서 협상 버전·features·백엔드 buildId를 반환한다.
호출은 ready를 기다린다. major 불일치·부팅 기한 초과·연결 종료는 준비와 대기 호출을 실패시킨다.

`Transport.send(text)`는 FIFO 큐 접수까지 완료하며 JS 작업 완료를 뜻하지 않는다.
`subscribe`는 원문 메시지 또는 closed 통지를 받으며 반환 함수는 멱등 해제다.
closed는 한 번만 통지하고, 종료 뒤 등록한 구독자도 종료를 관찰한다. 종료 뒤 send는 실패한다.
`close()`는 자원을 회수하고 멱등 완료한다. 세션 하나에 transport·client 하나를 두며
Client.close가 자신의 transport를 닫는다. 재연결은 새 객체·새 세션이다.

`invoke(name, input, { signal, deadline })`는 생성된 명령 타입의 output Promise를 반환한다.
deadline은 Unix epoch 밀리초다. 로컬 취소·만료는 즉시 호출을 실패시키고 필요한 cancel을 전송한다.
요청 ID를 재사용하지 않으며 늦은 결과를 폐기한다. 자동 재시도·부작용 롤백은 없다.

`listen(name, listener, { onError, signal })`은 구독 성공 뒤 비동기 멱등 해제 함수를 반환한다.
listener에는 payload와 공개 source·target·subscriptionId·sequence가 전달된다.
순서 위반·BUSY·연결 종료는 onError로 구독을 끝낸다. 해제 뒤 이벤트를 전달하지 않는다.
해제 함수는 연결이 이미 닫혔으면 네트워크 호출 없이 완료한다.
사용자 콜백의 예외로 다른 요청이나 transport 수신 루프를 중단하지 않는다.

`capabilities()`는 예약 명령 `bunaway.capabilities`를 null 입력으로 호출한다.
앱·플러그인은 이 이름을 등록할 수 없으며 정책에도 정확한 명령 이름을 허용해야 한다.
기능 지원과 OS 권한은 별도 필드다. 같은 capability 이름은 중복할 수 없다.

## 앱 정의와 코어

`command({ input, output, handle })`은 입력을 검증·복사한 뒤 typed handle을 호출하고,
출력도 검증·복사한다. 스키마는 기존 JSON Schema subset이다. 별도 스키마 DSL은 도입하지 않는다.
핸들러의 일반 예외는 코어가 안전한 INTERNAL로 바꾸며 `BunawayError`만 명시적인 API 오류로 취급한다.

앱은 `{ commands, events, state?, plugins? } satisfies AppDefinition`으로 정의한다.
명령·이벤트 이름을 직접 정책에 허용한다. 별도 permission 별칭은 없다.
`CommandsOf`·`EventsOf`는 앱에 직접 선언한 스키마에서 타입을 추론한다.
프런트엔드에는 tooling이 생성한 데이터 타입만 전달하며 백엔드 구현을 번들에 import하지 않는다.
플러그인까지 합친 전체 등록 목록의 타입 생성은 CLI 작업에서 구현한다.

`CoreFactory(app, services)`는 명령·이벤트 등록과 플러그인 setup이 끝난 뒤 Core를 반환한다.
중복·예약 이름, 플러그인 의존 순환·지원 플랫폼·권한 요구사항 불일치는 시작을 실패시킨다.
플러그인은 dependency 순서로 초기화하고 반환한 StopHook을 역순으로 실행한다.
초기화 실패 시 이미 초기화한 플러그인도 정리한다. metadata가 권한을 추가하지 않는다.

`openSession(hostContext, viewId)`는 정책의 허용 뷰에 대한 CoreSession을 만든다.
알 수 없는 뷰·컨텍스트 중복·정지한 코어에서는 실패한다. 세션별 협상, 요청·구독 ID를 분리한다.
`receive(ClientMessage)`는 접수·분배까지 완료하며 result/error는 `services.send`로 보낸다.
클라이언트 hello 전의 invoke는 실행하지 않는다. 일반 명령을 await하며 전체 수신을 막지 않는다.
허용 명령·이벤트와 입력·출력 스키마는 코어에서도 검사한다.

`CommandContext`는 요청 signal과 해당 요청에 묶인 host·state·events를 제공한다.
state.get/set은 JSON 스냅샷을 다루며 get 결과 수정으로 저장 값이 바뀌지 않는다.
events.emit은 선언된 이벤트 스키마를 검사하고 broadcast 또는 명시한 view로 전달한다.
발신자는 컨텍스트에서 결정하며 대상 뷰의 이벤트 허용 목록과 구독을 확인한다.
웹 요청을 backend 발신자로 승격하지 않는다.

세션 close는 멱등이며 새 요청 차단→signal 취소→미완료 요청 실패·구독 폐기 순서다.
stop은 모든 세션과 backend 작업을 취소하고 플러그인을 정리한다. 정리 기한 초과는 TIMEOUT이다.
Core.stop 완료와 실제 Bun 프로세스 종료는 별도다. 최종 프로세스 정리는 네이티브가 확인한다.

`API_LIMITS`: 준비 10초, 종료 2초, 명령 최대 30초, 미완료 요청·구독 각 128개,
세션 요청 ID 기록 1024개. 명령 deadline은 최대 실행 시간보다 길게 연장할 수 없다.
요청·이벤트 큐 초과는 BUSY 또는 세션 종료로 알리며 조용히 누락하지 않는다.

## Host API와 내부 IPC

| operation | input | output |
| --- | --- | --- |
| `storage.readText` | `{ scope: appData/temp, path }` | string |
| `storage.writeText` | `{ scope, path, text }` | null |
| `log.write` | `{ level: debug/info/warn/error, message, details? }` | null |
| `capabilities.get` | null | `{ name, support, permission, reason? }[]` |

단일 `hostOperations` 정의에서 네이티브 `host-call.schema.json`과 `host-operations.json`을 생성한다.
요청 스키마 검사는 파일 권한 검사가 아니다. path는 `/`로 구분한 상대 경로이고,
공통 스키마는 절대·드라이브 경로, 점 경로 요소, 역슬래시·NUL·개행을 거부한다. 실제 파일을 여는
네이티브 경계에서 절대 경로·순회·심볼릭 링크·대상 교체와 scope 권한을 검사한다.
U+2028·U+2029가 들어간 경로도 전체 문자열에서 점 경로 요소를 검사한다.
지원 여부와 permission 값은 각각 실제 플랫폼 지원과 현재 OS 동의를 반영한다.
기능 조회는 호출 권한을 부여하지 않으며 네이티브 정책은 실제 operation마다 다시 검사한다.

`bindHostAPI(context, signal, services.callHost)`는 호출 컨텍스트를 고정한다.
앱 핸들러는 `host.call(operation, payload)`만 사용하며 context를 선택할 수 없다.
호출 전·응답 후 취소를 검사하고 진행 중 취소는 즉시 실패시킨다.
잘못된 응답·일반 서비스 예외는 내부 정보를 제외한 INTERNAL로 전달한다.
낮은 계층도 signal에 맞춰 자원을 정리하고 늦은 결과를 폐기해야 한다.

제품 부트에서는 `boot.payload.policy`와 호스트 발급 `backendContext`가 필수다.
스키마의 optional은 기존 B 실험과의 호환 용도다.
누락을 전체 허용으로 해석하지 않는다. 호스트가 선택한 뷰와 세션은 `session-open`
`{ context, viewId }` 제어 프레임으로 알린다. 이는 Web 메시지로 입력받지 않는다.
runtime은 세대·방향·정책을 검사한 뒤 CoreSession을 만들고 web 프레임을 해당 세션으로 전달한다.
revoke는 native에서 권한을 즉시 폐기하고 CoreSession도 닫는다.

`HostContext` 브랜드는 잘못된 타입 사용을 막는 장치다. 인증 수단이 아니다.
네이티브는 실제 origin·최상위 frame·세션·런타임 세대와 context를 연결하고 매 호출에 재검사한다.
Host 요청 ID는 runtime이 생성하며 context와 함께 매칭한다. backendContext는 별도로 발급한다.
callHost는 signal 취소 시 같은 context·requestId의 `host-cancel`을 보낸다.
네이티브는 시작 전 작업을 취소하고 가능한 자원을 정리하며, 이미 완료된 작업은 무시한다.
취소가 끝난 외부 부작용을 롤백한다고 보장하지 않는다. 응답은 한 번만 완료하고 늦은 결과는 폐기한다.

## 병렬 구현과 검증

1. client-sdk: ClientFactory에 맞는 createClient, 요청·구독·취소·종료 및 Transport 계약 테스트.
2. core/backend-sdk: CoreFactory에 맞는 createCore, 등록·세션·상태·이벤트·플러그인 실행.
3. Windows 호스트: WebView2·Transport 경계, session-open/revoke, 정책·파일·Host operations.

runtime-bun은 공통 CoreServices로 모듈을 연결한다. 프로토콜·공통 타입 변경은 한 작업에서 관리한다.
저장·로그 플러그인은 이 API로 구현할 수 있으며, CLI·패키징은 실제 산출물 계약을 추가로 기다린다.

`tests/api/contracts.test.ts`는 명령 input/output, Host 컨텍스트 유지·오류·취소,
부트 정책·Web 경계와 compile-time 소비자 타입을 검증한다. `mise run check`에 포함한다.
실제 createClient/createCore 실행·WebView·파일 권한 집행은 각 구현 뒤 별도로 검증한다.

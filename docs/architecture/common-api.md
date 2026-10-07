# C 단계 공통 API

이 계약에 맞춰 client-sdk, core/backend-sdk와 Windows 호스트를 구현했다.
`ClientFactory`, `CoreFactory`는 공개 실행 계약이며 실제 `createClient`, `createCore`와
Windows FFI 호스트와 macOS의 `runBunApp` 어댑터가 이를 연결한다. 명령, Host API 검증 헬퍼와 WebView Transport도 구현했다.
실제 호스트의 검증 범위는 [Windows Bun FFI 실행 기록](./windows-bun-results.md)과
[macOS 실행 기록](./macos-native-results.md)을 따른다.
기존 Web, 프로세스 IPC 버전 1.0과 [프로토콜 규칙](./protocol.md)을 사용한다.

## 공유하는 코드

| 계약 | 소유 패키지 | 소비자 |
| --- | --- | --- |
| `Transport`, `ClientMessage`, `ServerMessage`, 취소, 오류, 제한 | protocol | SDK, 코어, 호스트 어댑터 |
| `Client`, `ClientFactory`, `InvokeOptions`, `EventDelivery` | client-sdk | UI, WebView transport |
| `AppDefinition`, `CommandDefinition`, `CommandContext`, 플러그인, 상태, 이벤트 | core, backend에서 재수출 | 앱, 플러그인, 코어 |
| `Core`, `CoreSession`, `CoreFactory`, `CoreServices`, `RuntimeServices` | core | runtime-bun |
| Host operation별 입력, 출력 스키마, `HostAPI`, `HostContext` | protocol | 코어, 플러그인, runtime, 네이티브 |
| `command`, `defineModule`, `defineApp`, `bindHostAPI` | backend, runtime-bun | 앱 정의, Host API 어댑터 |

추가 의존성은 없다. portable 코어는 DOM, Bun, Node 전역 타입 없이 컴파일한다.
`CancellationSignal`은 표준 AbortSignal의 `aborted`, abort 리스너 등록, 해제 부분이며
표준 AbortController를 그대로 공급할 수 있다. 코어는 `RuntimeServices.createCancellation`,
`now`, `schedule`을 주입받아 요청, 세션, 앱 수명과 단조 시계 타이머를 관리한다.

## 클라이언트와 Transport

앱 화면의 기본 API는 `@bunaway/client`의 `invoke`, `listen`, `capabilities`다.
첫 호출에서 SDK가 WebView 브리지를 찾아 Transport와 Client를 만들고 현재 프로토콜의
hello를 교환한다. import만으로 연결하거나 브리지를 읽지 않으므로 SSR, 일반 브라우저에서
모듈을 import할 수 있다. 브리지가 없는 환경에서 기본 API를 호출하면 `UNSUPPORTED`로
Promise를 거부하며 앱 WebView에서 열도록 안내한다. 브라우저용 가짜 성공 응답은 없다.
인자 없는 `createClient()`는 Client를 즉시 반환하는 동기 API이므로 브리지가 없으면
같은 `UNSUPPORTED` 오류를 동기적으로 던진다.

```ts
import { invoke, listen } from "@bunaway/client";

const unlisten = await listen<string>("memo.saved", event => {
  console.log(event.payload);
}, { onError: error => console.error(error) });
const text = await invoke<string>("memo.read", null);
await unlisten();
```

직접 import한 `invoke<T>`와 `listen<T>`의 `T`는 각각 반환값과 이벤트 payload 타입이며 런타임
검증기를 추가하지 않는다. 앱 정의에서 명령 이름, 입력, 출력, 이벤트 타입을 추론하려면
`CommandsOf`, `EventsOf`와 인자 없는 `createClient`를 사용한다. 백엔드 import는 type-only다.

```ts
import { createClient } from "@bunaway/client";
import type { CommandsOf, EventsOf } from "@bunaway/backend";
import type { app } from "../src-bunaway/app.ts";

const client = createClient<CommandsOf<typeof app>, EventsOf<typeof app>>();
const text = await client.invoke("message.read", null);
```

기본 함수와 인자 없는 `createClient()`는 문서별 Client 하나를 공유한다. SDK를 여러 번
로드하거나 UI HMR이 호출 모듈을 교체해도 같은 연결, 요청 ID, 구독을 사용한다.
`pagehide`에서 SDK가 연결을 닫고 리스너, 요청, 구독을 정리한다. UI 컴포넌트는 자신이
등록한 구독의 해제 함수를 사용하며 공유 Client 전체를 닫지 않는다. 명시적 close나 연결
실패 뒤 같은 문서에서 호출해도 새 hello나 자동 재전송은 하지 않는다. 새 문서 로드는
새 세션을 만든다. BFCache 복원도 이미 종료된 세션을 자동으로 다시 연결하지 않는다.

`ClientFactory({ transport, hello })`는 즉시 Client를 반환한다. Client는 먼저 수신을 구독하고
hello를 교환하며 `ready`에서 협상 버전, features, 백엔드 buildId를 반환한다.
호출은 ready를 기다린다. major 불일치, 부팅 기한 초과, 연결 종료는 준비와 대기 호출을 실패시킨다.

`Transport.send(text)`는 FIFO 큐 접수까지 완료하며 JS 작업 완료를 뜻하지 않는다.
`subscribe`는 원문 메시지 또는 closed 통지를 받으며 반환 함수는 멱등 해제다.
closed는 한 번만 통지하고, 종료 뒤 등록한 구독자도 종료를 관찰한다. 종료 뒤 send는 실패한다.
`close()`는 자원을 회수하고 멱등 완료한다. 세션 하나에 transport, client 하나를 두며
Client.close가 자신의 transport를 닫는다. 재연결은 새 객체, 새 세션이다.

명령 타입을 지정한 클라이언트의 `client.invoke(name, input, { signal, deadline })`는 명령 타입의 output
Promise를 반환한다. 직접 import한 `invoke<T>`는 작성자가 지정한 T의 Promise를 반환한다.
deadline은 Unix epoch 밀리초다. 로컬 취소, 만료는 즉시 호출을 실패시키고 필요한 cancel을 전송한다.
요청 ID를 재사용하지 않으며 늦은 결과를 폐기한다. 자동 재시도, 부작용 롤백은 없다.

`listen(name, listener, { onError, signal })`은 구독 성공 뒤 비동기 멱등 해제 함수를 반환한다.
listener에는 payload와 공개 source, target, subscriptionId, sequence가 전달된다.
순서 위반, BUSY, 연결 종료는 onError로 구독을 끝낸다. 해제 뒤 이벤트를 전달하지 않는다.
해제 함수는 연결이 이미 닫혔으면 네트워크 호출 없이 완료한다.
사용자 콜백의 예외로 다른 요청이나 transport 수신 루프를 중단하지 않는다.

`capabilities()`는 예약 명령 `bunaway.capabilities`를 null 입력으로 호출한다.
앱, 플러그인은 이 이름을 등록할 수 없으며 정책에도 정확한 명령 이름을 허용해야 한다.
기능 지원과 OS 권한은 별도 필드다. 같은 capability 이름은 중복할 수 없다.

## 앱 정의와 코어

`command({ input, output, handle })`은 입력을 검증, 복사한 뒤 typed handle을 호출하고,
출력도 검증, 복사한다. 스키마는 기존 JSON Schema subset이다. 별도 스키마 DSL은 도입하지 않는다.
핸들러의 일반 예외는 코어가 안전한 INTERNAL로 바꾸며 `BunawayError`만 명시적인 API 오류로 취급한다.

앱은 `defineModule("memo").command("save", contract, handle).event("saved", schema)`로
기능을 정의하고 `defineApp({ modules: [memo], state?, plugins? })`로 조립할 수 있다.
`contract`는 기존 JSON Schema의 `{ input, output }`이며 `command`와 같은 검증을 거친다.
서비스 구현은 일반 TypeScript 함수나 클래스로 작성하고 모듈에서 공개 명령과 연결한다.
작은 기능에 계약, 서비스 파일 분리를 강제하지 않는다.

모듈의 로컬 이름은 `memo.save`, `memo.saved`로 등록한다. 앱 조립은 객체 spread 전에
최종 이름의 중복을 검사한다. 모듈 내부, 모듈 간, 직접 앱 등록, 플러그인 등록의 충돌은
`INVALID_ARGUMENT`으로 실패하며 명령, 이벤트 이름과 양쪽 등록 소유자를 표시한다.
`memo.save`와 `settings.save`는 다르지만 `memo.archive`의 `save`와 `memo`의
`archive.save`는 충돌한다. 명령과 이벤트의 이름 공간은 서로 독립이다.
체인의 각 단계와 조립한 명령, 이벤트 목록은 불변 스냅샷이므로 이전 객체가 바뀌지 않는다.

조립 결과는 기존 `AppDefinition`이다. 원래의
`{ commands, events, state?, plugins? } satisfies AppDefinition` 형식도 사용할 수 있다.
`defineApp`의 선택적 `commands`, `events`에는 완성된 이름을 직접 등록한다.
등록 API에 전달하기 전에 객체 spread로 덮어쓴 항목은 복원, 검사할 수 없으므로
기능 조합에는 `modules`를 사용한다. 플러그인의 setup, 정리는 기존 Core가 담당한다.
명령, 이벤트 이름을 직접 정책에 허용한다. 별도 permission 별칭은 없다.
`CommandsOf`, `EventsOf`는 앱에 직접 선언하거나 모듈에서 조립한 스키마에서 타입을 추론한다.
모듈 목록을 변수에 저장할 때는 `as const`로 tuple을 유지한다. 조건부 모듈은 공통으로
존재하는 이름만 노출하고, 비어 있을 수 있는 동적 배열과 tuple의 동적 꼬리는 등록을
보장하지 않으므로 타입에 명령, 이벤트를 추가하지 않는다.
모듈, 로컬 이름이 union이면 하나의 이름만 선택되며, `string`으로 넓어진 이름이나
`feature-${number}` 같은 무한한 문자열 패턴은 특정 등록 이름을 보장하지 않는다.
고정된 이름으로 등록하면 해당 스키마의 타입을 유지한다.
프런트엔드에는 데이터 타입만 전달하고 백엔드 구현을 번들에 import하지 않는다.
명령 타입 생성 tooling과 플러그인까지 합친 전체 등록 목록의 타입 생성은 CLI 작업으로 남아 있다.

`CoreFactory(app, services)`는 명령, 이벤트 등록과 플러그인 setup이 끝난 뒤 Core를 반환한다.
중복, 예약 이름, 플러그인 의존 순환, 지원 플랫폼, 권한 요구사항 불일치는 시작을 실패시킨다.
플러그인은 dependency 순서로 초기화하고 반환한 StopHook을 역순으로 실행한다.
초기화 실패 시 이미 초기화한 플러그인도 정리한다. metadata가 권한을 추가하지 않는다.

`openSession(hostContext, viewId)`는 정책의 허용 뷰에 대한 CoreSession을 만든다.
알 수 없는 뷰, 컨텍스트 중복, 정지한 코어에서는 실패한다. 세션별 협상, 요청, 구독 ID를 분리한다.
`receive(ClientMessage)`는 접수, 분배까지 완료하며 result/error는 `services.send`로 보낸다.
클라이언트 hello 전의 invoke는 실행하지 않는다. 일반 명령을 await하며 전체 수신을 막지 않는다.
허용 명령, 이벤트와 입력, 출력 스키마는 코어에서도 검사한다.

전송 실패 시 정리 책임은 `CoreServices`를 제공하는 어댑터에 있다. 오류 응답도 전송할 수 없거나
transport가 closed를 통지하면 해당 경로를 먼저 닫고 새 송수신을 차단한다.
WebView 경로에서는 Windows 호스트가 컨텍스트를 폐기하고, 프로세스 IPC가 살아 있으면 revoke를
보낸다. runtime-bun은 INTERNAL 오류 객체를 전달해 해당 `CoreSession.close`를 호출한다.
공유 프로세스 파이프가 끊기면 runtime-bun은 모든 연결 세션을 닫고 코어를 정리하며,
네이티브 호스트는 Bun 프로세스 정리를 확인한다. 서로 독립된 뷰의 전송 실패는 해당 세션만 닫는다.
어댑터는 멱등 정리를 보장하고 고장 난 경로로 오류를 재전송하지 않는다. 실패한 send는 즉시
reject하며 세션 정리는 별도로 진행해, send와 세션 close가 서로의 완료를 기다리지 않게 한다.

`CommandContext`는 요청 signal과 해당 요청에 묶인 host, state, events를 제공한다.
state.get/set은 JSON 스냅샷을 다루며 get 결과 수정으로 저장 값이 바뀌지 않는다.
events.emit은 선언된 이벤트 스키마를 검사하고 broadcast 또는 명시한 view로 전달한다.
발신자는 컨텍스트에서 결정하며 대상 뷰의 이벤트 허용 목록과 구독을 확인한다.
웹 요청을 backend 발신자로 승격하지 않는다.

세션 close는 멱등이며 새 요청 차단→signal 취소→미완료 요청 실패, 구독 폐기 순서다.
stop은 모든 세션과 backend 작업을 취소하고 플러그인을 정리한다. 정리 기한 초과는 TIMEOUT이다.
Core.stop 완료와 실제 Bun 프로세스 종료는 별도다. 최종 프로세스 정리는 네이티브가 확인한다.

`API_LIMITS`: 준비 10초, 종료 2초, 명령 최대 30초, 미완료 요청, 구독 각 128개,
세션 요청 ID 기록 1024개. 명령 deadline은 최대 실행 시간보다 길게 연장할 수 없다.
요청, 이벤트 큐 초과는 BUSY 또는 세션 종료로 알리며 조용히 누락하지 않는다.

## Host API와 내부 IPC

| operation | input | output |
| --- | --- | --- |
| `storage.readText` | `{ scope: appData/temp, path }` | string |
| `storage.writeText` | `{ scope, path, text }` | null |
| `log.write` | `{ level: debug/info/warn/error, message, details? }` | null |
| `capabilities.get` | null | `{ name, support, permission, reason? }[]` |

단일 `hostOperations` 정의에서 네이티브 `host-call.schema.json`과 `host-operations.json`을 생성한다.
요청 스키마 검사는 파일 권한 검사가 아니다. path는 `/`로 구분한 상대 경로이고,
공통 스키마는 절대, 드라이브 경로, 점 경로 요소, 역슬래시, NUL, 개행을 거부한다. 실제 파일을 여는
네이티브 경계에서 절대 경로, 순회, 심볼릭 링크, 대상 교체와 scope 권한을 검사한다.
U+2028, U+2029가 들어간 경로도 전체 문자열에서 점 경로 요소를 검사한다.
지원 여부와 permission 값은 각각 실제 플랫폼 지원과 현재 OS 동의를 반영한다.
기능 조회는 호출 권한을 부여하지 않으며 네이티브 정책은 실제 operation마다 다시 검사한다.

`bindHostAPI(context, signal, services.callHost)`는 호출 컨텍스트를 고정한다.
앱 핸들러는 `context.host.call(operation, payload)` 또는 backend-sdk의
`storage`, `log`, `capabilities`를 사용하며 context를 선택할 수 없다.
backend-sdk는 `AsyncLocalStorage`로 실행별 `CommandContext`를 연결한다.
`command()`와 `defineModule().command()`는 명령 실행을 연결하고, `defineApp()`은
직접 등록한 명령과 플러그인 명령, setup 및 StopHook도 연결한다.
명령의 실행 범위는 핸들러 실행과 검증이 끝나면 비활성화되므로 지연된 작업이 Host API를 재사용할 수 없다.
setup에서 시작한 작업은 backend 취소 신호로 앱 종료를 관찰한다.
현재 범위가 없으면 `INVALID_ARGUMENT`, 종료하거나 취소된 범위이면 `CANCELLED`로 거부한다.
편의 API는 기존 HostAPI.call에 위임하므로 입력과 출력 검증, 네이티브 권한 검사와 취소 계약을 유지한다.
호출 전, 응답 후 취소를 검사하고 진행 중 취소는 즉시 실패시킨다.
잘못된 응답, 일반 서비스 예외는 내부 정보를 제외한 INTERNAL로 전달한다.
낮은 계층도 signal에 맞춰 자원을 정리하고 늦은 결과를 폐기해야 한다.

제품 부트에서는 `boot.payload.policy`와 호스트 발급 `backendContext`가 필수다.
스키마의 optional은 기존 B 실험과의 호환 용도다.
정책이 포함된 모든 부트 파싱, 프로세스 직렬화 경로는 중복 view ID를 거부한다.
누락을 전체 허용으로 해석하지 않는다. 호스트가 선택한 뷰와 세션은 `session-open`
`{ context, viewId }` 제어 프레임으로 알린다. 이는 Web 메시지로 입력받지 않는다.
runtime은 세대, 방향, 정책을 검사한 뒤 CoreSession을 만들고 web 프레임을 해당 세션으로 전달한다.
revoke는 native에서 권한을 즉시 폐기하고 CoreSession도 닫는다.

`HostContext` 브랜드는 잘못된 타입 사용을 막는 장치다. 인증 수단이 아니다.
네이티브는 실제 origin, 최상위 frame, 세션, 런타임 세대와 context를 연결하고 매 호출에 재검사한다.
Host 요청 ID는 runtime이 생성하며 context와 함께 매칭한다. backendContext는 별도로 발급한다.
callHost는 signal 취소 시 같은 context, requestId의 `host-cancel`을 보낸다.
네이티브는 시작 전 작업을 취소하고 가능한 자원을 정리하며, 이미 완료된 작업은 무시한다.
취소가 끝난 외부 부작용을 롤백한다고 보장하지 않는다. 응답은 한 번만 완료하고 늦은 결과는 폐기한다.

## 구현과 검증 범위

1. client-sdk: 직접 `invoke`, `listen`, `capabilities`, 인자 없는 `createClient()`의 문서별
   기본 연결과 자동 초기화, 정리, 명시적 `createClient`와 요청, 구독, 취소, 종료,
   `createWebViewTransport` 구현.
2. core/backend-sdk: `createCore`와 등록, 세션, 상태, 이벤트, 플러그인 실행, 명령 검증 구현.
3. Windows 호스트: WebView2 경계, session-open/revoke, 정책, 파일, Host operations 구현.

runtime-bun의 `runBunApp`은 공통 CoreServices로 모듈을 연결한다. 저장, 로그 Host API는
Windows 호스트에서 실행하지만 기본 저장, 로그 플러그인 모듈은 비어 있다.
메모 샘플과 CLI의 생성, 검증, 개발, 빌드 및 Windows Inno 패키징은 구현했다.
macOS의 CLI 배포 채널 연결과 프로덕션 서명, 실제 공증 및 Store 제출은 후속 작업이다.

`tests/api/contracts.test.ts`는 명령 input/output, Host 컨텍스트 유지, 오류, 취소,
부트 정책, Web 경계와 compile-time 소비자 타입을 검증한다. `mise run check`에 포함한다.
`tests/api/default-client.test.ts`는 기본 연결의 지연 초기화, HMR 공유, 준비 대기,
직접 호출, 구독 해제, 기능 조회, 실패, 취소, 문서 종료와 새 문서의 세션 분리를 검증한다.
`tests/api/modules.test.ts`는 조립한 앱의 타입 추론, 중복 등록, Core, Client 명령 호출과
정책, 이벤트를 검증한다. SDK, 코어 실행과 실제 Bun 프로세스 IPC 테스트도 `mise run check`에 포함한다.
`mise run host:windows`의 실행 기록은 실제 SDK, 코어, 메모 저장, 이벤트와 네이티브
파일 권한 집행, 다중 창/뷰의 정책 분리를 Windows에서 확인한다. 다른 플랫폼 지원
완료를 뜻하지는 않는다.

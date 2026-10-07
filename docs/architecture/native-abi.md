# 내부 Native Host C ABI 초안

상태: 이전 동일 프로세스 설계의 기록. 2026-10-04에 번들된 Bun 자식 프로세스와 IPC 구조로
변경하면서 이 런타임 ABI 초안은 현행 구현 요구사항에서 제외했다. 아래 내용과 헤더는
단계 A의 기록으로만 보존한다. 현재 B 단계는 [런타임 실현성 계획](./runtime-feasibility.md)을 따른다.
헤더는 [`bunaway.h`](../../native/host-api/bunaway.h)다.

## 경계와 버전

이 ABI는 네이티브 호스트와 Bun 내장 런타임 사이의 내부 계약이다. WebView의 IPC 계약은 별도 프로토콜 버전으로 관리한다. `BUNAWAY_HOST_ABI_VERSION`은 C 함수, 구조체 계약의 버전이며 IPC JSON에 넣지 않는다. 호스트는 시작할 때 헤더와 같은 ABI 버전을 전달하고, 런타임은 다르면 시작을 거부한다. 시작 옵션의 세 콜백과 큐 상한은 모두 필수이며, 누락되었거나 0인 상한은 동기적으로 거부한다.

Web IPC payload는 전체 UTF-8 JSON 메시지다. 요청 ID, 명령, 결과, 오류, 이벤트 같은 프로토콜 필드는 JSON 스키마에 따른다. C ABI는 WebView 메시지의 payload를 그대로 운반한다. ABI 진입점은 UTF-8, JSON 완결성, 설정된 크기 상한을 검사하고 잘못된 입력을 큐에 넣지 않는다.

`bootstrap_json`은 별도 `bootstrap.schema.json`을 따르며 `entrypoint`와 `buildId`를 가진다.
호스트는 검증한 앱 자산의 로컬 절대 경로를 entrypoint로 넘긴다. 상대 경로와 원격 URL은
허용하지 않는다. 스키마의 절대 경로 문법 검사에 더해, 실제 파일의 정규화, 서명된 자산
범위, 존재 여부는 호스트가 검사한다. 경로 검사만으로 신뢰할 수 있는 코드가 되지는 않는다.
호스트가 선택한 정책과 bootstrap은 WebView에서 변경할 수 없다. Bun 초기화는 임의 cwd의
`.env`, 설정, 스크립트를 자동 로드하지 않아야 한다. start는 옵션과 bootstrap bytes를
반환 전에 복사하고, 동기 실패에는 콜백 없이 out_runtime을 0으로 남긴다.

## 호출과 스레드

`bunaway_start`, `bunaway_post_message`, `bunaway_request_stop`은 수락 여부만 동기 반환한다.
VM 시작, 메시지 처리, 종료 완료를 기다리지 않고 콜백도 함수 안에서 직접 부르지 않는다.
start를 받은 내장 어댑터가 전용 OS 스레드와 큐를 생성하고 호스트는 이 ABI로 그 수명을
관리한다. 앱 부팅과 Bun VM 작업은 그 스레드에서 직렬 처리한다. Bun Worker가 아니다.
콜백이 start 반환보다 먼저 다른 스레드에서 도착할 수 있으므로 호스트는 user_data를
호출 전에 완전히 초기화하고 콜백이 받은 runtime 핸들을 사용한다. start 성공 후에는
STARTING을 먼저, 앱 명령 등록이 끝나면 READY를 보낸다. READY 이전의 WEB_IPC는 BUSY다.
일반 데이터 큐가 찼거나 런타임이 종료 중이면 즉시 상태 코드로 거부한다.

콜백은 런타임 스레드에서 직렬 호출한다. 콜백에서 WebView나 OS UI를 직접 조작하지 않는다.
네이티브 쪽의 제한된 큐에 작업을 복사해 넣고 즉시 반환한다. `on_web_message`와
`on_host_request`는 작업을 받았을 때만 OK를 반환한다. Host API 요청이 거부되면
해당 비동기 호출을 오류로 끝낸다. 큐 포화는 BUSY, 무효 컨텍스트는 CANCELLED,
그 밖의 내부 실패는 세부 내용을 제거한 INTERNAL로 매핑한다. 호스트가 Web 메시지를
받을 수 없으면 그 세션을 무효화하고 렌더러에 연결 종료를 알린다. 단순 로그 기록이나
조용한 이벤트 누락으로 끝내지 않는다. 제어용 세션 폐기는 포화된 데이터 큐와 독립적이어야 한다.

## 핸들, 메시지와 소유권

런타임 핸들은 런타임 ID와 generation으로 식별한다. 컨텍스트 핸들은 같은 ID, generation에 불투명 `value`를 더한 값이다. 컨텍스트 값은 네이티브 호스트가 발급, 매핑하고, 수신 메시지의 WebView 세션, frame, origin, 권한 정보를 호스트가 관리한다. 오래되었거나 다른 런타임에 속한 핸들은 거부한다.

컨텍스트 핸들은 `bunaway_post_message` 인자와 콜백 인자로만 전달한다. 웹 JSON, SDK payload, 로그의 프로토콜 필드에 넣지 않는다. Bun에서 Host API를 요청하는 `on_host_request` 콜백도 호출 컨텍스트를 별도 인자로 받으므로 네이티브 호스트가 매 요청마다 권한과 현재 세션을 재검사할 수 있다. Host API 응답은 같은 컨텍스트와 별도 request ID를 붙여 `BUNAWAY_POST_HOST_RESPONSE`로 보낸다.

ABI가 받은 JSON과 operation 문자열의 메모리는 호출이 끝나면 호스트가 재사용할 수 있다. 런타임은 성공을 반환하기 전에 내용을 자체 큐로 복사하며, 거부한 입력 포인터는 보관하지 않는다. 콜백에 전달한 JSON과 operation 포인터는 해당 콜백이 반환할 때까지만 유효하다. 보관할 호스트는 콜백 안에서 제한된 자체 큐로 복사한다. 이 초안에는 반환 버퍼나 해제 함수가 없으며 콜백 출력은 호스트가 해제하지 않는다. 콜백 함수와 `user_data`는 시작 때 복사, 저장되며, `user_data`가 가리키는 객체는 마지막 콜백이 끝날 때까지 살아 있어야 한다.

Host API request ID는 0이 아닌 uint64이며 런타임 수명 동안 재사용하지 않는다.
런타임은 `(runtime, context, request_id)`가 모두 같은 첫 응답만 처리한다.
Host 응답 JSON은 `host-response.schema.json`의 `{ kind: "result", payload }` 또는
`{ kind: "error", error: { code, message, details? } }`다. Web IPC 버전, 요청 ID, 권한
토큰은 여기에 넣지 않는다. 중복, 늦은 응답은 STALE_HANDLE로 거부하고 콜백을 재완료하지 않는다.
operation은 프로토콜 이름과 같은 ASCII 문법 및 128바이트 상한을 적용한다.

호스트는 시작 옵션의 0이 아닌 `backend_context_value`를 backend 자체 작업용으로 예약한다.
런타임은 자신의 ID, generation에 이 값을 붙여 background Host API 호출에 사용한다.
호스트는 STARTING 콜백에서 해당 runtime과 예약 값을 backend 정책에 연결한다.
READY 이전에도 부팅 중 Host API 호출이 올 수 있다. WebView 컨텍스트에는 이 값을
발급하지 않으며 WEB_IPC가 예약 컨텍스트로 들어오면 INVALID_ARGUMENT로 거부한다.
0 핸들이나 WebView payload로 backend 권한을 선택할 수 없다. 같은 런타임 안에서도
컨텍스트 value는 재사용하지 않는다. 탐색, 창 폐기 때 호스트는 즉시 정책 매핑을 폐기하고
`bunaway_revoke_context`로 런타임에 전달한다. 성공 반환부터 새 post와 해당 컨텍스트의
Host API 실행을 거부하며 이미 진행 중인 JS 요청, 구독은 런타임 큐에서 취소, 정리한다.
런타임의 오래된 결과는 호스트에서도 폐기한다. backend 컨텍스트로 바꿔 실행하지 않는다.

## 큐와 종료

호스트는 시작 옵션에 양수인 `max_queued_messages`, `max_payload_bytes`,
`max_inflight_web_requests`, `max_inflight_host_requests`를 지정한다. 런타임은 각각
대기 메시지 수, 각 JSON payload의 바이트 수, 실행 중인 Web 요청 수, 미완료 Host API
요청 수에 상한을 적용한다. Web 요청 한도는 큐에서 꺼낸 뒤에도 완료, 취소까지 유지한다.
초과 입력은 명시적으로 거부하며 제한 없는 대기열을 만들지 않는다.
네이티브 호스트의 콜백 수신 큐도 별도로 제한해야 한다.

max_payload_bytes는 공통 JSON 상한인 1 MiB를 넘을 수 없다. bootstrap에도 같은 상한과
깊이 64를 적용한다. stop, revoke는 데이터 큐 포화로 거부하지 않는다. 호스트는 별도
제어 상태로 처리해야 한다. stop은 JS를 선점 중단한다는 보장이 아니며, 돌아오지 않는
JS나 OS 호출 때문에 STOPPED에 도달하지 못하면 호스트는 종료 기한 초과를 보고한다.
그 경우 user_data를 해제하지 말고 프로세스 종료로 회수한다. UI 스레드는 동기 대기하지 않는다.

`request_stop`이 수락되면 새 입력을 막고 대기 입력과 진행 중 Host API 요청을 취소한다. 중단 시점에 이미 실행된 운영체제 부작용의 롤백은 보장하지 않는다. 취소, 정리가 끝나고 콜백 실행이 모두 빠져나온 다음 `STOPPED` 상태 콜백을 마지막으로 한 번 호출한다. 그 콜백이 반환된 뒤에는 어떤 콜백도 오지 않으므로 호스트는 그때 `user_data`와 콜백 소유 자원을 해제할 수 있다. 시작이 비동기로 실패하면 `FAILED`를 알리고 `STOPPED`로 마무리한다. 런타임 핸들, generation이 맞지 않는 늦은 콜백은 호스트가 폐기한다.

다른 스레드는 STOPPED 알림을 받았다는 사실만으로 콜백의 반환까지 끝났다고 가정하지 않는다.
`bunaway_release`는 종료 콜백 반환 전에는 BUSY, 완전히 끝난 뒤에는 OK를 반환하며
어댑터의 큐, 핸들 자료를 정리한다. 호스트는 OK를 받은 뒤 user_data를 해제한다.
콜백 안에서 release를 호출하면 BUSY이며 동기 대기를 해서는 안 된다. 성공한 release
이후 같은 핸들은 STALE_HANDLE이다. 프로세스 수명 Bun 자원의 해제와 재시작 허용을 뜻하지 않는다.

이 초안은 프로세스당 Bun VM 하나의 수명을 정의한다. 같은 프로세스에서의 두 번째 시작이나 종료 후 재시작은 지원한다고 약속하지 않으며 ABI는 이를 `BUSY`로 거부할 수 있다. Bun 포트가 VM 해제를 지원하지 않으면 실제 상태와 무관하게 콜백을 정리한 뒤 그 프로세스에서 재시작을 거부한다. `STOPPED`는 콜백 quiescence를 뜻하며 프로세스 전역 Bun 자원의 실제 해제를 보증하지 않는다.

| 호출, 콜백 | 의미 |
| --- | --- |
| `bunaway_start` | 옵션 검증과 런타임 시작 예약. 반환 성공은 `READY`를 뜻하지 않는다. |
| `bunaway_post_message(BUNAWAY_POST_WEB_IPC)` | WebView에서 받은 UTF-8 JSON 전체와 별도 컨텍스트를 큐에 복사한다. IPC request ID는 JSON 안에 둔다. |
| `on_web_message` | 응답, 오류, 이벤트 JSON을 컨텍스트와 함께 호스트에 넘긴다. 호스트는 렌더러 스레드로 전달을 예약한다. |
| `on_host_request` | operation, JSON 인자, 호출 컨텍스트, Host API request ID를 넘긴다. 완료는 대응하는 `BUNAWAY_POST_HOST_RESPONSE`로 돌아온다. |
| `bunaway_request_stop` | 비동기 종료를 예약한다. 완료는 마지막 `STOPPED` 콜백으로 확인한다. |
| `bunaway_revoke_context` | 새 작업 접수를 즉시 막고 해당 세션의 요청, 구독 정리를 예약한다. |
| `bunaway_release` | 콜백 반환 완료를 비동기 방식으로 확인하고 어댑터 자원을 회수한다. |

이 문서는 단계 A의 추적 가능한 계약 초안이다. Bun 내부 API, 실제 큐 구현, 플랫폼별 스레드 연결, VM 해제 가능성은 구현과 별도 검증에서 확정해야 한다.

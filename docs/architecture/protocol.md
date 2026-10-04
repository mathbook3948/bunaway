# IPC와 정책 계약 v1 초안

구현된 범위는 메시지·정책의 직렬화, 런타임 검증, 버전 협상이다.
세션 관리, 명령 실행, 권한 집행, 취소 처리와 이벤트 큐는 아직 구현하지 않았다.
이 문서의 실행 규칙은 이후 SDK·코어·네이티브 구현이 충족해야 할 계약이다.

호스트↔Bun은 번들된 자식 프로세스와 IPC로 연결한다. 아래 Web 메시지는 별도 내부
envelope의 payload로 운반하며 호스트 발급 컨텍스트·수명주기 제어는 Web JSON에
추가하지 않는다. `processSchema`와 `parseProcessFrame`·`serializeProcessFrame`,
`runtime-bun`의 `readJsonLines`를 구현하고 Windows B 단계에서 실제 파이프로 검증했다.
[실행 결과](./windows-probe-results.md)를 참고한다.

## 하나의 스키마 정의

`packages/protocol/src/schema.ts`가 원본이다. TypeScript 타입과 검증기는 이 정의를
사용한다. `mise run protocol:generate`는 같은 정의를 JSON Schema 2020-12 형식으로
`native/host-api/generated/`에 내보낸다. `mise run test`가 생성 파일의 일치를 검사한다.
호스트 전용 bootstrap과 Host API 응답도 같은 소스에서 생성하며 WebView 메시지와 분리한다.
현재 검증기는 실제 사용한 키워드만 지원한다. 새 키워드는 검증기·테스트와 함께 추가한다.
Windows 실험 호스트는 생성된 process 스키마와 같은 키워드를 해석하고 런타임 세대,
방향·컨텍스트·요청 ID·이벤트 구독과 sequence를 별도로 검사한다.
제품용 권한 집행과 WebView 신뢰 경계는 C 단계에서 구현한다.

JSON 전송은 UTF-8 최대 1 MiB, 루트 깊이 0에서 최대 깊이 64다. 모든 payload도 같은
제한을 받는다. 유한한 숫자, 문자열, boolean, null, 밀집 배열과 일반 객체만 허용한다.
함수, undefined, BigInt, 비유한 숫자, 순환 참조, 클래스, getter, symbol 속성과
JSON으로 보존되지 않는 속성은 보내기 전에 거부한다. 수신측은 파싱 결과도 검증한다.
송신은 속성 descriptor에서 복사한 JSON 데이터만 검증·직렬화한다. 검증 이후 원본의
동적 속성을 다시 읽지 않으며 복사 중에도 직렬화 크기 예산을 적용한다.
파서가 반환하는 객체도 원형이 없는 JSON record이므로 자체 메서드 대신 `Object.hasOwn`
같은 표준 함수를 사용한다. 배열은 일반 배열로 반환한다.
형태가 잘못된 입력의 오류에는 원본 payload나 JSON 파서 진단을 포함하지 않는다.
JSON Schema 외에도 바이트·깊이 제한과 정책 view ID 중복 금지를 네이티브에서 적용해야 한다.

숫자는 JavaScript와 같은 유한한 IEEE-754 binary64다. 큰 정수의 정확한 보존은 보장하지
않으므로 정밀한 ID·금액·64비트 값은 문자열이나 앱 스키마로 표현한다. 요청 deadline·버전·
이벤트 sequence는 별도로 정수 범위를 제한한다. `-0`은 송신 시 `0`으로 정규화된다.
객체 안의 중복 키는 JSON.parse처럼 마지막 값을 사용한다. 네이티브 파서도 모든 깊이에서
같은 숫자·중복 키 규칙을 적용한 뒤 정책·스키마를 검사해야 한다. 첫 값만 읽는 권한 검사나
JSON 원문에서 필드를 부분 추출하는 구현을 허용하지 않는다. Windows 실험은 C++ 파서의
숫자를 binary64로 정규화하고 중첩 객체의 중복 키, 큰 숫자와 음수 0을 실제 IPC로 검증한다.

## 호스트 전용 프로세스 envelope

`process.schema.json`은 별도 `ipc: { major: 1, minor: 0 }` 버전과 문자열
`runtime: { id, generation }`을 요구한다. `web`은 호스트 발급 `context`와 기존
Web `payload`를 운반한다. `boot`, `hello`, `ready`, `revoke`, `shutdown`, `stopping`,
`fatal`은 부트·협상·수명주기를 처리한다. `host-request`·`host-response`에는
`context`, 문자열 `requestId`와 요청 operation을 넣는다. Host API 호출 실행은 C 단계다.

Windows 실험은 `ready` 전 요청, 중복 ID와 다른 runtime 세대·방향을 거부한다.
stdout은 NDJSON 전용이며 stderr는 별도로 소비하고 실험 로그 전달량은 64 KiB로 제한한다.
프레임 크기는 개행 제외 1 MiB, 깊이는 envelope 전체 루트 기준 64다.
송신 큐와 미완료 요청은 각각 128개, 런타임당 요청 ID 기록은 1024개로 제한한다.
종료 제어는 대기 송신 큐를 비우고 우선 전달하며 남은 요청은 실패 또는 취소로 끝낸다.

## 메시지와 버전

모든 메시지는 `kind`, `protocol: { major, minor }`를 갖는다. 현재 버전은 `1.0`이다.
메시지 객체의 정의되지 않은 필드는 거부한다. payload 내부의 앱 데이터와 달리
envelope에는 origin, frame, 권한 토큰이나 호출 컨텍스트를 넣을 수 없다.

| kind | 필드 | 방향과 의미 |
| --- | --- | --- |
| `hello` | `features`, `buildId` | 양방향, 첫 메시지. 백엔드는 실제 런타임 빌드 ID, 클라이언트는 SDK 빌드 ID |
| `invoke` | `id`, `command`, `payload`, 선택적 `deadline` | UI → 호스트 → 코어 |
| `cancel` | `id` | 같은 세션의 진행 중 요청 취소. 별도 응답은 없음 |
| `listen` | `id`, `event` | UI → 코어, 성공 result의 payload는 `{ subscriptionId }` |
| `unlisten` | `id`, `subscriptionId` | UI → 코어, 성공 result의 payload는 null |
| `result` | `id`, `payload` | 요청 성공 |
| `error` | `id`, `error` | 요청 실패, 원래 요청의 한 번뿐인 종료 결과 |
| `event` | `subscriptionId`, `source`, `target`, `event`, `sequence`, `payload` | 구독별 이벤트 |
| `subscription-error` | `subscriptionId`, `error` | 구독의 최종 실패. 큐 초과에는 BUSY |

요청·구독 ID와 이름은 ASCII 영숫자 및 `_.:-`로 1~128자다.
버전 major가 다르면 UNSUPPORTED로 연결을 종료한다. minor는 두 값 중 낮은 값,
features는 교집합으로 협상한다. 알 수 없는 feature는 자동 활성화하지 않는다.
기본 v1 메시지는 feature 없이 사용한다. 후속 기능은 이름과 최소 버전을 별도로 정의한다.
협상 이후 transport는 모든 메시지가 협상 버전과 같고 허용된 방향인지 확인해야 한다.
`parseMessage`는 형태만 검사하며 활성 세션이나 협상 완료를 증명하지 않는다.

`deadline`은 Unix epoch 밀리초의 안전한 정수다. 호스트는 수신 시 남은 시간을 계산하고
이후에는 단조 시계로 만료를 관리한다. 만료된 요청은 실행하지 않는다. deadline 없는
요청도 호스트의 최대 실행 시간과 진행 중 요청 수 제한을 받는다.

ID는 세션 동안 재사용하지 않는다. 완료·취소·만료 뒤 늦게 온 결과는 폐기한다.
한 요청은 result 또는 error 한 번으로 끝난다. cancel 수신 때 원 요청이 진행 중이면
CANCELLED로 끝내고, 이미 끝났으면 무시한다. 외부 부작용의 롤백이나 자동 재시도는 없다.
탐색·창 폐기·재연결은 새 세션이며 이전 요청과 구독을 모두 무효화한다.

이벤트 sequence는 구독마다 1부터 증가한다. listen 성공 응답을 보낸 뒤 이벤트를 전송한다.
source와 target은 호스트가 붙인 공개 뷰 식별자이고, 백엔드 source는 `backend`다.
권한을 담는 내부 컨텍스트 핸들과 다르며 인증 자료로 사용하지 않는다.
구독 큐 초과는 subscription-error로 구독을 종료한다. 제어 오류조차 전송할 수 없으면
세션을 닫아 클라이언트가 연결 종료를 관찰하게 한다. 조용히 이벤트를 버리지 않는다.

## 정책

정책은 `version: 1`, `views`, `backend`를 필수로 가진다. 선언이 없는 권한은 거부한다.
view마다 고유 id, 정확히 일치시킬 origins, commands, events, host 권한을 선언한다.
현재 origin 문법은 소문자 HTTP(S) hostname과 선택적 port만 지원한다. path·wildcard·
불투명 `null` origin·IPv6·사용자 정보는 허용하지 않는다. 이는 첫 계약의 제한이며
플랫폼 자산 origin의 최종 선택을 뜻하지 않는다. 네이티브 어댑터는 실제 origin을
정규화하고 유효한 port인지 확인한 뒤 정확히 비교해야 한다. HTTP 개발 origin은
별도 개발 모드에서만 허용하고 프로덕션 정책 빌드에서는 거부해야 한다.

네이티브는 자신이 관찰한 활성 세션, view, 최상위 frame, origin으로 정책을 선택한다.
payload에 같은 이름의 필드가 있더라도 권한에 사용하지 않는다. 원격 문서와 서브프레임에
브리지를 주입하지 않는 것이 기본이다. backend 자체 작업은 backend 권한을 사용하며
WebView 작업을 backend 작업으로 승격하지 않는다.

host는 `log: boolean`, `storage: []`로 범위를 선언한다. 저장소 항목은 appData/temp,
pathPrefix, read/write 목록이다. pathPrefix는 ASCII 영숫자·`_-` 디렉터리를 `/`로
잇는 상대 경로이며 빈 문자열은 명명된 scope 전체다. 접두어 일치는 경로 세그먼트
단위다. `notes`가 `notes-private`를 허용하지 않는다. 일반 파일명의 문법과는 별개다.
파일을 여는 네이티브 경계에서 실제 상대 경로, 심볼릭 링크 탈출, 대상 교체 및
OS 권한을 다시 검사해야 한다. 이 정책 파서는 파일 접근을 실행하거나 보호하지 않는다.

```json
{
  "version": 1,
  "views": [{
    "id": "main",
    "origins": ["https://app.bunaway.local"],
    "commands": ["notes.read"],
    "events": ["notes.changed"],
    "host": { "log": false, "storage": [{ "scope": "appData", "pathPrefix": "notes", "access": ["read"] }] }
  }],
  "backend": { "log": false, "storage": [] }
}
```

command 이름을 직접 허용하는 정책이다. PRD의 `permission: "notes:read"`처럼 별도
권한 이름을 도입하려면 명령→권한 매핑을 빌드 산출물에 정의해야 한다. 현재는 그 매핑과
공개 SDK가 미구현이므로 policy commands에 권한 별칭을 넣어도 명령 허용으로 해석하지 않는다.

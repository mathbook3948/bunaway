# 선택 네이티브 플러그인의 구조와 공개 계약

상태: Windows 구현과 로컬 개별 패키지 검증 완료. 기준일: 2026-10-07.
[ADR 0013](../decisions/0013-optional-native-plugins.md)의 구현 계약이다.
저장, 로그와 기능 조회는 개별 tarball로 설치하고 등록한다.
macOS는 창 플러그인의 목록, 생성과 재생성, 표시와 포커스 제어, 닫기와 기본 상태
조회를 제공한다. 저장, 로그, 기능 조회와 opener 어댑터는 아직 제공하지 않는다.

## 설치, 등록, 권한

앱 개발자는 필요한 플러그인 패키지를 `package.json`에 선언하고 `bun.lock`으로
설치를 고정한다. 공개 registry가 준비되기 전에는 개별 로컬 tarball로 설치한다.
CLI와 공통 SDK의 설치가 선택 플러그인의 설치를 대신하지 않는다.

다음은 앱 정의와 서비스의 사용 형태다.

```ts
// src-bunaway/app.ts
import { defineApp } from "@bunaway/backend";

import { storagePlugin } from "@bunaway/plugin-storage";
import { logPlugin } from "@bunaway/plugin-log";
import { memo } from "./memo/module.ts";

export default defineApp({
  modules: [memo],
  plugins: [storagePlugin, logPlugin],
});
```

```ts
// src-bunaway/memo/service.ts
import { storage } from "@bunaway/plugin-storage";
import { log } from "@bunaway/plugin-log";

export async function save(text: string): Promise<null> {
  await storage.writeText({ scope: "appData", path: "notes/memo.txt", text });
  await log.info("메모를 저장했습니다.", { length: text.length });
  return null;
}
```

`storagePlugin`, `logPlugin`, `capabilitiesPlugin`, `windowsPlugin`은 옵션 없는 플러그인 정의 객체다.
현재 필요한 설정은 정책에 작성하므로 별도의 `init()`이나 설정 factory를 요구하지
않는다. 사용자 정의 명령, 상태와 이벤트는 기존 모듈 조립 방식을 유지한다.

패키지가 설치돼 있어도 등록하지 않은 Host operation은 `UNSUPPORTED`다.
등록된 기능의 권한이 없으면 `PERMISSION_DENIED`다. 일반 앱 명령의 이름 오류는
기존 `INVALID_ARGUMENT` 계약을 유지한다.

## 패키지와 진입점

| 패키지 | 공통 공개 export | 화면에서 사용하는 함수 |
| --- | --- | --- |
| `@bunaway/plugin-storage` | `storage`, `storagePlugin` | `storage` |
| `@bunaway/plugin-log` | `log`, `logPlugin` | `log` |
| `@bunaway/plugin-capabilities` | `capabilities`, `capabilitiesPlugin` | `capabilities` |

화면과 백엔드는 같은 패키지의 index.ts를 import한다.
공통 작성 SDK인 `@bunaway/plugin`의 defineNativePlugin은 선언에서 등록 객체와
호출 함수를 만든다. 화면과 백엔드의 호출 구현은 SDK 내부의 browser, bun 조건으로
선택한다. 플러그인마다 계약 파일과 두 환경의 호출 함수를 작성하지 않는다.
SDK의 호출 함수는 연결, handshake, 취소, pagehide 정리와 기존 호출 컨텍스트를
재사용한다. 최상위 선언에서는 플랫폼 자원을 열거나 앱 setup을 실행하지 않는다.
실제 호출에 필요한 SDK는 호출 시 읽으므로 선언 자체를 CLI와 호스트에서 읽을 수 있다.

기본 구조는 다음과 같다. 기능이 커지면 제작자가 필요한 파일과 폴더를 추가한다.
아래 파일명은 관례이며 package.json의 exports와 plugin.json의 entry, operations에
실제 경로를 지정한다. 별도의 contracts.ts, client.ts, authorization.ts를 요구하지 않는다.

Windows 개발 번들은 `package.json`의 조건부 루트 `exports`도 공유 모듈로 처리한다.
`import`와 `require`의 진입점을 각각 해석하고 같은 파일은 하나의 공유 번들로 묶는다.
`defineApp()`은 같은 원본 플러그인의 Host 바인딩을 재사용하므로 setup이나 명령을 가진
플러그인도 객체 동일성을 유지한다. 실행 컨텍스트와 자원 수명은 각 코어가 별도로 소유한다.
`null`로 차단했거나 Bun 조건에서 제공하지 않는 하위 경로는 공유 목록에서 제외한다.
앱이 그런 경로를 실제로 import하면 번들 빌드를 실패로 처리한다.

```text
plugins/<name>/
  package.json
  plugin.json
  src/
    index.ts                 기능과 권한 선언, 공개 export
    windows.ts               Windows 실행과 자원 회수
```

저장, 로그와 기능 조회의 Windows 구현은 각각 src/windows.ts에 둔다.
생성 앱의 tsconfig.json은 browser 조건으로 화면을 검사하고 src-bunaway/tsconfig.json은
bun 조건으로 백엔드를 검사한다. typecheck는 두 검사를 모두 실행한다.
화면 함수는 마지막 인자로 NativeInvokeOptions의 signal과 deadline을 받는다.
백엔드 함수는 명령 또는 setup의 호출 범위를 따르며 별도 옵션을 받지 않는다.
index.ts는 정의와 공개 export를 담당하며 알고리즘과 편의 호출은 역할에 맞는 내부 파일로 분리한다.
`logger.ts`의 수준별 로그 함수는 `plugin.api.write`를 받아 만들고, `query.ts`는
`plugin.api.get` 결과의 이름 중복을 검사한다. `storage`의 범위 비교는 `scope.ts`에 두고 `matches`에 연결한다.
로직에서 선언의 타입을 읽을 때는 import type을 사용해 런타임 순환 import를 만들지 않는다.
추가 처리가 없는 plugin은 생성한 api를 바로 공개하며 내부 처리 파일을 요구하지 않는다.

저장과 로그의 기존 입력, 결과 형식은 유지한다.

```ts
type StorageLocation = { scope: "appData" | "temp"; path: string };

interface StorageAPI {
  readText(input: StorageLocation): Promise<string>;
  writeText(input: StorageLocation & { text: string }): Promise<null>;
}

interface LogAPI {
  write(input: { level: "debug" | "info" | "warn" | "error";
    message: string; details?: JsonValue }): Promise<null>;
  debug(message: string, details?: JsonValue): Promise<null>;
  info(message: string, details?: JsonValue): Promise<null>;
  warn(message: string, details?: JsonValue): Promise<null>;
  error(message: string, details?: JsonValue): Promise<null>;
}

declare function capabilities(): Promise<Capabilities>;
```

위 타입은 함수 계약을 설명하기 위한 표기다. 별도의 class나 factory를 요구하지 않는다.
`Capabilities`는 `{ name, support, permission, reason? }[]` 형식이다. 지원 값은
`supported`, `experimental`, `unsupported`이고 permission 값은 `granted`, `denied`,
`prompt`, `not-required`, `unknown`이다. 플러그인 선언의 `osPermission`은 현재
`not-required`만 허용한다. 이 값은 OS 권한을 요청하거나 현재 동의 상태를 확인하지 않고,
해당 작업에 OS 권한이 필요하지 않음을 정적으로 표시한다. 생략하면 기능 조회 결과의
permission은 `unknown`이다. feature 이름은 중복될 수 없다. 저장의 상대 경로 검사와
1 MiB 메시지 상한, 로그 메시지 1,024자 제한 등
기존 입력과 결과 제약도 각 플러그인의 계약으로 옮겨 유지한다.

## 프레임워크와 기능의 소유

| 소유자 | 담당 |
| --- | --- |
| 공통 protocol | 메시지 형식, JSON 제한, schema 검증, 버전 협상 |
| backend SDK와 core | 앱과 모듈 조립, 명령, 이벤트, 상태, 호출 컨텍스트, 플러그인 등록과 수명 |
| plugin SDK | 기능 계약 검증, 선언에서 공개 호출 함수 생성, 환경에 맞는 호출 선택 |
| client SDK | WebView 연결, invoke/listen, 응답, 취소와 페이지 종료 |
| native host | 실제 출처, 뷰와 세션, operation 전달, 실행 직전 권한 확인 |
| 플러그인 패키지 | 공개 함수, operation 계약, 권한 정의, 플랫폼 어댑터, 기능 자원 정리 |
| capabilities 플러그인 | 등록된 작업의 플랫폼 지원과 OS 권한 메타데이터 조회 API |
| CLI | 설치 패키지 검증, 필요한 어댑터의 번들과 앱 패키지 검사 |

## 호출 계약

공통 백엔드 호출 API는 `host.call(contract, input)`으로 한다. 플러그인은 입력과
출력 schema를 가진 계약을 넘기며 결과 타입은 출력 schema에서 추론한다.
명시적 호출이 필요한 코드에는 `context.host.call(contract, input)`을 제공한다.
문자열 작업 이름만으로 결과 타입을 정하는 고정 전역 작업 목록은 제거한다.

```ts
type HostOperationContract<I extends Schema, O extends Schema> = {
  readonly name: string;
  readonly input: I;
  readonly output: O;
  readonly permission: string;
  readonly osPermission?: "not-required";
};

interface HostAPI {
  call<I extends Schema, O extends Schema>(
    contract: HostOperationContract<I, O>,
    input: Infer<I>,
  ): Promise<Infer<O>>;
}
```

계약 객체의 이름은 등록한 작업을 찾는 키다. 호출자가 넘긴 schema나 permission으로
등록한 계약을 덮어쓰지 않는다. 입력, 결과, 권한 검사에는 앱에 등록한 플러그인의
정규 계약을 사용한다. `currentHost`와 AsyncLocalStorage 객체는 플러그인에 공개하지
않고, 편의 함수는 공통 `host.call`에 위임한다.

명령의 성공, 실패, 취소 후에는 해당 호출 범위를 폐기한다. setup에서 시작한 작업은
앱의 백엔드 취소 신호를 사용한다. 범위가 없으면 `INVALID_ARGUMENT`, 종료된 범위면
`CANCELLED`다. 진행 중 호출도 취소하고 늦은 결과를 폐기한다. Host 호출은 반드시
명령이 끝나기 전에 await한다. StopHook의 Host 호출은 취소된 상태로 실패하므로
StopHook은 타이머, 연결과 자체 자원을 정리한다.

## 플러그인 정의와 계약의 원본

기존 `PluginDefinition`의 이름, 버전, 의존성, 플랫폼, 명령, 이벤트, setup/StopHook을
재사용한다. 네이티브 플러그인은 선택적 `native` 필드로 operation과 permission의
계약을 선언한다. 일반 TypeScript 플러그인에는 이 필드를 요구하지 않는다.

```ts
type PermissionContract = {
  readonly name: string;
  readonly scope?: Schema;
};

type NativePluginContract = {
  readonly operations: readonly HostOperationContract<Schema, Schema>[];
  readonly permissions: readonly PermissionContract[];
};

// PluginDefinition에 추가하거나 교체하는 필드다.
type NativePluginFields = {
  readonly native?: NativePluginContract;
  readonly requiredPermissions?: readonly string[];
};
```

operation에는 이름, 입력과 출력 schema, 필요한 permission 식별자가 있다.
선택 `osPermission: "not-required"`는 OS 권한을 요구하지 않는 작업을 표시한다.
생략하면 기능 조회의 permission 메타데이터는 `unknown`이다.
permission에는 식별자와 선택적 리소스 scope schema가 있다. 각 이름은 플러그인의
이름 공간에 속하며 다른 플러그인이나 앱의 등록과 중복되면 시작을 실패시킨다.
새 네이티브 기능의 선언은 플러그인의 `index.ts`에 작성하며 공통 protocol에
개별 작업을 추가하지 않는다.

패키지는 `package.json`의 `bunaway.plugin`에 `plugin.json` 위치를 선언한다.
CLI가 읽는 manifest의 형식은 다음과 같다.

```json
{
  "format": 1,
  "name": "storage",
  "entry": "./src/index.ts",
  "platforms": {
    "windows": {
      "execution": "io",
      "operations": "./src/windows.ts"
    }
  }
}
```

manifest는 선언과 어댑터의 위치를 지정하고, index.ts는 작업과 권한을 정의한다.
entry의 default export는 플러그인 정의이며 native와 선택적 matches를 제공한다.
CLI는 이름과 버전을 설치 manifest와 대조하고 native를 검증한다.
scope가 있는 permission에는 선언의 matches가 필수다. scope가 없는 기능에는
평가 함수를 요구하지 않는다. plugin.json에 authorization 경로를 따로 쓰지 않는다.
JSON에 schema를 다시 복사하지 않는다. entry는 부작용 없는 선언이며 CLI가 앱
진입점이나 plugin setup을 실행하지 않고 읽을 수 있어야 한다.
`defineNativePlugin`은 선언을 검증하고 `definition`과 `api`를 반환한다.
제작자는 operations 객체에 메서드 이름과 input, output, 짧은 permission 이름을 작성한다.
SDK가 작업과 권한의 플러그인 접두사를 붙이고 권한 목록을 만든다.
같은 permission을 사용하는 작업은 권한 하나를 공유한다. scope가 필요하면 scopes에
짧은 permission 이름과 schema를 연결한다. 사용하지 않는 scopes 키는 선언 오류다.
`s.object`는 필드를 기본 필수로 선언하고 추가 필드를 거부한다. 선택 필드는
`s.optional`로 표시하며 나머지 s 함수도 기존 Schema를 만든다. 검증기를 복제하지 않는다.
이 작성 형식은 제작자가 native.operations와 native.permissions 배열, 완전한 작업 이름과
권한 이름, required와 additionalProperties를 반복해서 작성하게 한 이전 형식을 대체한다.
api의 메서드 이름은 operations의 키와 같다.
입력과 결과의 타입은 schema에서 추론한다. 등록 객체는 default export하며 공개 함수는
api를 원하는 이름으로 export한다. 기존 공식 plugin의 이름 있는 등록 export도 유지한다.

Windows의 `execution`은 `io` 또는 `ui`다. 현재 이관하는 저장, 앱 로그와 지원 조회는
`io`를 사용한다. UI 스레드가 필요한 플러그인은 `ui`를 선언하고 호스트의 UI Worker에
실행을 맡긴다. 플러그인의 공개 함수가 실행 Worker를 직접 만들거나 선택하지 않는다.

경로는 패키지 내부 상대 경로만 허용하고 실제 경로가 설치 패키지를 벗어나면 빌드를
거부한다. framework 버전과 해석 경로도 검사한다. 같은 공통 SDK와 호출 컨텍스트의 복제본이
있으면 기존 SDK 동일성 검사를 거쳐 같은 설치본으로 연결한다.
공식 `@bunaway/` 플러그인의 패키지 버전은 프레임워크 버전과 맞춘다. 외부 플러그인은
자체 버전을 사용하며 SDK peer 버전으로 호환성을 검사한다.

`requiredHost`의 기능별 구조는 제거한다. setup에 필요한 권한의 식별자는
`requiredPermissions`에 선언한다. 시작 전에 backend 정책의 명시적 허용을 확인하되,
리소스 범위까지 보장하는 것으로 설명하지 않는다. 실제 setup의 각 작업은 등록된
permission과 scope로 다시 검사한다. 단순한 기능 등록에는 backend 권한이 필요 없다.
권한 식별자는 `<plugin-name>:<permission-name>`이고 operation은
`<plugin-name>.<operation-name>`이다. 플러그인 이름과 operation의 각 이름은 기존
명령 식별자 제약에 맞춘다. 등록 목록과 scope도 기존 JSON 깊이, 크기 제한을 검사한다.
pattern은 등록 검사와 입력, 출력, scope 검사에서 같은 JavaScript Unicode 모드(`u`)를 사용한다.

## 권한 정책 v1의 구조 변경

공식 배포 전까지 정책 형식의 버전은 v1이다. 개발 중에는 기존 v1의 구조를 직접
갱신하고, 구조 변경만을 이유로 v2를 만들거나 이전 개발 형식의 호환 처리를 추가하지 않는다.

`policy.json`의 view 구조와 origin, 앱 command/event 허용 목록은 유지한다.
`view.host`와 루트 `backend`는 같은 `{ permissions }` 구조를 사용한다.
각 항목은 permission 문자열 또는 `{ identifier, allow?, deny? }`다. 문자열은
리소스 scope가 필요 없는 작업에만 사용할 수 있다.

```json
{
  "version": 1,
  "backend": { "permissions": [] },
  "views": [{
    "id": "main",
    "origins": ["https://app.bunaway.local"],
    "commands": ["memo.save"],
    "events": [],
    "host": {
      "permissions": [
        "log:write",
        {
          "identifier": "storage:write-text",
          "allow": [{ "scope": "appData", "pathPrefix": "notes" }]
        }
      ]
    }
  }]
}
```

저장은 `storage:read-text`, `storage:write-text`, 로그는 `log:write`, 지원 조회는
`capabilities:get`을 사용한다. scope의 자료형과 비교는 해당 플러그인이 정의한다.
저장 scope는 `scope`와 디렉터리 단위 `pathPrefix`다. 작업 종류를 permission으로
구분하므로 기존 scope의 `access` 배열은 사용하지 않는다.

scope가 필요한 작업에 allow가 없으면 접근을 허용하지 않는다. 같은 permission의
allow를 합치고, 어느 항목의 deny라도 요청과 일치하면 거부한다. 기본적으로 아무
permission도 허용하지 않으며 설치와 등록으로 정책에 항목을 추가하지 않는다.
미등록 plugin의 permission이나 잘못된 scope는 시작 전에 설정 오류로 보고한다.
알 수 없는 필드, 권한 식별자와 operation에 연결되지 않은 permission도 설정 오류다.
권한 항목은 출처마다 최대 256개이고 각 allow/deny는 최대 128개의 scope를 허용한다.
저장 scope의 pathPrefix는 기존 정책처럼 최대 256자이며 `/`로 나눈 이름 디렉터리다.
`notes`는 `notes/` 하위 경로까지 허용하지만 `notes-other`에는 일치하지 않는다.

뷰 명령은 해당 뷰의 host 정책, setup은 backend 정책을 사용한다. permission의
평가 함수는 순수 함수로 작성하며 scope 밖의 파일을 실제로 열어 판정하지 않는다.
파일 링크, 최종 경로와 핸들 검사는 저장 plugin의 실행 adapter에서 수행한다.
Windows 저장 adapter는 각 상위 디렉터리의 고정된 핸들과 최종 파일의 정규 경로가
요청한 철자와 정확히 일치하는지 확인한다. 다음 디렉터리를 만들거나 파일을 읽고 쓰기
전에 검사하며 대소문자 별칭과 8.3 짧은 이름을 거부한다. 정책의 경로 비교는 대소문자를 구분한다.
신뢰된 백엔드의 직접 Bun API 접근은 이 정책의 샌드박스 대상이 아니다.

## 화면 호출과 기능 조회

네이티브 plugin의 화면 구현은 `plugin.storage.readText`처럼 `plugin.<name>.` 접두사의
명령을 호출한다. 해당 명령은 plugin 등록으로 설치하며 임의 앱 명령이 이 이름 공간을
사용하면 등록 오류로 처리한다. 일반 앱 명령의 이름과 입력, 결과는 그대로 유지한다.
화면에서 직접 호출하려면 view.commands에도 정확한 plugin 명령 이름을 허용해야 한다.
플러그인의 생성된 화면 함수는 공통 `invokePlugin(contract, input, options?)`을
사용한다. 이 함수가 입력과 결과를 검증하고 기존 WebView 연결로 호출하며
`InvokeOptions`의 signal과 deadline을 전달한다. 기능별 호출 검증을 복제하지 않는다.
명령 허용과 Host permission을 모두 검사하며 백엔드 권한으로 승격하지 않는다.
등록하지 않은 플러그인의 `plugin.<name>.` 명령은 `UNSUPPORTED`로 거부한다.
등록된 플러그인에서 작업 이름을 잘못 지정하면 `INVALID_ARGUMENT`다. 뷰의 명령
허용 검사는 두 경우에도 적용한다.

기능 지원 조회도 선택 기능이다. capabilities plugin이 `plugin.capabilities.get`을
등록하고 `capabilities()`를 공개한다. client SDK는 기능 조회 API를 소유하지 않는다.
backend와 화면 함수는 같은 플러그인 계약을 사용한다.
조회에는 `capabilities:get` 권한이 필요하며 다른 permission을 부여하지 않는다.

조회 결과는 최대 256개의 등록된 네이티브 작업을 포함한다. 창 작업도 windowsPlugin을 등록한 경우에만 포함한다.
결과 전체에는 기존 JSON 깊이와 1 MiB 메시지 제한을 적용한다.
조회 결과는 앱에 등록된 작업과 플랫폼 adapter의 지원 정보로 만든다. 설치했더라도 앱에
등록하지 않은 작업은 결과에 넣지 않는다. `osPermission` 선언이 없으면 `unknown`을
반환하며, `not-required`는 OS 권한 상태를 확인한 값이 아니다. protocol handshake의
지원 feature와 정책의 permission은 이 조회와 별개이며 공통 기반에 남긴다. Tauri의
capabilities 권한 설정과 bunaway의 기능 지원 조회 함수도 서로 다른 개념이다.

## Windows adapter와 시작, 종료

CLI는 앱의 직접 의존성에 선언한 네이티브 plugin의 manifest를 읽고 target별 adapter
목록을 생성한다. dependencies, devDependencies, optionalDependencies와 peerDependencies를 모두 탐색한다.
설치하지 않은 optionalDependencies와 optional peerDependencies는 건너뛰며 필수 패키지의 누락은 오류다.
설치된 패키지 전체는 catalog로 검증하며 operation과 permission의
합계가 256개를 넘어도 허용한다. 각 플러그인의 계약과 policy 입력 제한은 그대로
검사한다. 실제 앱 등록과 runtime registry는 operation과 permission을 각각 최대
256개로 제한한다. 앱 정의는 runtime 등록의 원본이며 build 설정에 같은 목록을 다시
작성하지 않는다. 설치된 package의 adapter 코드가 bundle에 들어가더라도 등록하지
않은 adapter는 import하거나 초기화하지 않는다. 설치와 등록을 정적으로 동일한
목록이라고 추정해서 코드를 제거하지 않는다.
검증할 때 읽은 계약과 adapter 목록은 해당 Project의 `nativePlugins`에 담아
SDK 검증, 정책 검사와 번들에서 재사용한다. 다음 검증이나 개발 재시작에서는 다시
읽으며 프로세스 전체에 계약을 캐시하지 않는다.

Windows의 앱별 생성 데이터는 `assets/manifest.json`에 모은다. `format: 1` 아래에
해석된 앱 설정 `app`, 권한 정책 `policy`, 설치된 플러그인 계약 `plugins`, 개발 중
공유하는 SDK 모듈 목록 `developmentSdk`를 기록한다. plugins의 각 항목에는 이름,
버전, native 계약, 선택적 execution과 authorization 유무가 들어간다.
앱 개발자가 작성하는 설정과 정책은 계속 `src-bunaway/`에 두며 이 manifest는 CLI가
빌드마다 생성한다. 이전 `app.json`, `policy.json`, `development-sdk.json`을 Windows
실행 자산에 중복 생성하지 않는다. macOS도 실행 manifest와 생성 import 모듈을 사용한다.
CLI는 대상 플랫폼의 어댑터 경로를 선택하고 설치된 카탈로그 검증과 플러그인 실행은
`native/host-api/bun`에서 공유한다. macOS 백엔드는 실제 앱이 등록한 계약을 메인 스레드에
보내며, 메인은 설치된 계약과 일치하는 플러그인만 초기화한다. Host API는 호출한
컨텍스트가 아직 활성 상태인지와 해당 컨텍스트의 현재 정책을 검사한 뒤 실행한다.

실행 코드 연결은 CLI의 `app-modules.ts`가 빌드 전용 가상 모듈로 생성한다.
앱 진입점, 개발 SDK 연결, macOS 부팅 코드와 플러그인 지연 import를 이곳에서 관리하며
중간 TypeScript 파일은 쓰지 않는다. 플러그인 계약 데이터는 manifest에만 기록한다.
`bunaway:plugin-imports`는 이 가상 모듈을 가리키고 번들 결과는
`assets/plugin-imports.js`와 필요한 청크다. 호스트와 Worker, 생성 import를 함께 번들해
EXE 컴파일 뒤에도 공통 SDK와 오류 클래스가 일치하도록 한다.
일반 소스의 빈 배열을 빌드 훅으로 대체하지 않으며, 호스트는 manifest를 검증한 뒤
이 import 모듈과 연결한다. 등록된 플러그인만 해당 Worker에서 초기화한다.

개발 산출물에서는 manifest와 실행 번들을 직접 확인할 수 있다. Windows 배포 빌드는
manifest와 실행 모듈을 EXE에 포함하고 임시 assets를 정리한다. 패키지 루트의
`manifest.json`은 완성된 EXE와 배포 파일의 해시를 기록하므로 실행 manifest와 분리한다.

앱 패키지 검증 후 등록한 플러그인과 설치된 manifest를 대조한다. 이름, 버전,
의존성, 지원 플랫폼, 계약과 scope를 확인하고 UI의 권한 평가 및 실행 adapter를
준비한 다음 setup을 시작한다. setup 중의 Host 호출도 준비된 경로로 응답해야 한다.
계약의 객체 키 순서는 일치 여부에 영향을 주지 않는다. 배열 순서와 값은 비교한다.
일반 객체와 null prototype 객체는 같은 JSON 내용이면 같은 계약으로 취급한다. 숫자 `-0`과 `0`도 같은 값으로 비교한다.

UI Worker는 실제 view/session과 등록된 작업, 정책을 확인한다. I/O Worker는 기존
제한된 큐와 실행 직전 승인 절차를 유지한다. entry의 matches는 UI에서 실행할
순수 권한 평가를, operations 모듈은 지정된 Worker의 기능 실행과 자원 회수를 제공한다.
프레임워크의 Worker, 메시지 채널, 취소와 승인 절차를 플러그인마다 복제하지 않는다.
호스트는 manifest의 실행 위치로 작업을 전달한다. `ui` 작업은 UI Worker의 제한된 큐에
들어간 뒤 메인 스레드에 prepare를 보낸다. 메인 스레드는 호출이 아직 활성일 때만 grant를 보내고,
UI Worker는 grant 뒤 현재 호출 문맥과 정책을 다시 확인해 실행한다. `io` 작업은 I/O
Worker의 제한된 큐에 들어간 뒤 메인 스레드에 prepare를 보낸다. 메인 스레드는 호출이 여전히 활성인지
확인하고 UI Worker에 정책 평가를 요청한다. 허용 결과를 받은 메인 스레드가 I/O Worker에 grant를
보내며, I/O Worker는 grant 뒤 실행한다.

작업 전송과 승인 메시지는 각각 최대 128개의 미확인 메시지를 보관한다. prepare,
authorize, authorized와 grant는 별도 승인 용량을 사용하므로 작업 전송이 한도에 도달해도
승인을 계속 처리한다. 취소, 뷰 폐기와 종료 메시지도 각각 예약된 용량을 사용한다.
새 Host 호출은 진행 중 호출과 아직 확인되지 않은 취소, 승인 메시지가 차지하는 용량을
확인하고, 여유가 없으면 `BUSY`로 거부한다.

Host 호출 취소가 메인 스레드의 grant 전에 처리되면 실행을 막는다. grant 뒤 실행 단계가 시작된
경우에는 이미 진행 중인 파일 쓰기 같은 부작용을 되돌리지 않는다. UI와 I/O Worker는
`host-response.ts`의 공통 변환을 사용한다. 성공 결과와 오류는 모두 응답 schema와 최종
envelope의 크기 제한을 검사하며, 실패하면 안전한 `INTERNAL` 응답으로 바꾼다. 정책 거부는 실행하지 않고
`PERMISSION_DENIED`를 반환하며, 응답 전에 진단 이벤트를 보낸다. 진단 채널이 포화되어
이벤트를 버릴 수 있어도 거부 응답과 실행 차단은 유지한다.

코어는 명령 결과에 요청 ID와 프로토콜 정보를 추가한 최종 Web 응답을 직렬화해
1 MiB 제한을 검사한다. HostResponse에 들어가는 결과여도 최종 응답이 제한을 넘으면
해당 요청에 `INTERNAL`을 반환한다. 전송 채널에 넘기기 전에 처리하므로 같은 세션의
다음 명령은 계속 실행할 수 있다.

entry의 default export에 `matches(permission, input, scope)`를 선언한다.
scope가 있는 등록된 플러그인의 평가 모듈만 읽는다.
평가 모듈은 플랫폼 adapter 유무와 별개로 번들에 포함한다. adapter가 없어도 allow와
deny를 검사하고, 허용된 호출에는 `UNSUPPORTED`, 권한 밖 호출에는 `PERMISSION_DENIED`를 반환한다.
공통 계층은 등록된 schema로 검증한 입력과 scope만 전달한다. 함수는 네트워크나
파일 I/O 없이 한 scope와 요청의 일치 여부를 반환한다. 공통 계층은 모든 deny의
불일치와 적어도 하나의 allow 일치를 확인하며, 평가 함수가 실패하면 허용하지 않는다.
scope가 없는 permission은 정책에 해당 식별자를 명시했는지 공통 계층에서 확인한다.

operations 진입점은 `createOperations(environment)`를 export한다. 환경은 호스트가
정한 데이터 루트와 등록된 작업의 지원 정보를 제공하며 호출자가 선택할 수 없다.
반환 객체의 `execute(operation, input, source)`는 승인된 작업을 실행하고
`dispose()`는 준비한 자원을 회수한다. `source`도 호스트가 정한 view/backend 출처다.
I/O Worker에서는 기존 파일 작업처럼 승인과 실행 사이에 await나 두 번째 큐를 두지
않는다. 결과와 안전한 오류는 등록된 계약과 공통 HostResponse 형식으로 검증한다.

Windows UI Worker는 `CoInitializeEx`로 STA를 초기화한 뒤 adapter를 준비하고, 이후 창과
WebView를 만든다. 종료할 때는 adapter를 먼저 정리한 다음 `CoUninitialize`를 호출한다.
adapter 준비 중에 실패해도 이미 준비한 adapter와 COM 자원을 정리한다.

지원 조회 플러그인은 환경의 등록 정보를 조회하며 OS 권한을 추측해서 생성하지
않는다. 공통 호스트가 제공하는 정보에도 storage/log 전용 작업 이름은 고정하지 않는다.

저장 plugin으로 기존 `ScopedStorage`와 파일 바인딩의 생성, 회수 책임을 옮긴다.
로그 plugin으로 앱 로그의 위치, 최대 크기와 회전을 옮긴다. 창, WebView, 실제 출처,
프레임워크 진단 로그는 native host에 남긴다. 준비에 실패하면 준비된 adapter를
역순으로 회수하고 앱 시작을 실패시킨다.

종료 시 새 호출을 막고 command/backend 작업을 취소한다. setup이 반환한 StopHook을
역순으로 실행한 뒤 pending 작업, 큐와 adapter 자원을 정리하고 Worker의 실제 종료를
확인한다. 개별 정리 실패가 다른 adapter 정리를 건너뛰게 하지 않는다. 기존 종료
기한과 강제 종료, Job의 자손 회수 계약은 유지한다.
정리 실패는 모든 adapter 정리를 시도한 뒤 AggregateError로 보고한다.
앱 플러그인의 StopHook 오류는 onPluginError에 플러그인 이름, stop 단계와 원인을 전달하고 나머지 훅을 실행한다.
초기화 실패와 회수 실패가 함께 발생하면 원래 초기화 오류도 보존한다.
UI adapter의 정리 실패 뒤에도 창, COM과 플랫폼 바인딩 회수를 시도한다.

## 배포와 이관 순서

`framework.json`은 공통 `packages`와 선택 `plugins`의 목록을 구분한다. 공식 plugin
tarball을 각각 만들고 CLI 패키지의 필수 dependencies에는 넣지 않는다. plugin은
호환하는 plugin SDK를 peer dependency로 선언한다. 첫 이관에서는 공식 plugin과
공통 SDK의 정확한 릴리스 버전을 맞추며 `bun.lock`으로 설치를 고정한다.

CLI의 기존 `@bunaway/*` 고정 목록 검사는 manifest 기반 plugin 검사로 확장한다.
패키지의 조건부 exports를 해석하고 앱의 직접 plugin 의존성을 확인한다.
저장 예제와 template는 storage plugin만 명시적으로 설치하고 등록한다. 로그나 기능
조회는 예제에서 사용하지 않는 한 추가하지 않는다.

1. 공통 호출 계약, native 등록, 정책 v1의 새 구조와 실패 처리를 구현한다. 기존 모듈 조립과
   일반 plugin setup/StopHook은 유지하고 고정 operation, 권한 목록을 제거한다.
2. 공통 작성 SDK와 세 공식 plugin의 선언, 공개 함수와 플랫폼 구현을 작성한다. SDK의 feature
   export와 core의 자동 조회 명령을 제거한다.
3. Windows adapter와 권한 평가, 시작/종료를 연결한다. 설치된 package와 runtime
   등록을 대조하고 미등록 adapter를 초기화하지 않는 것을 검증한다.
4. 개별 tarball, CLI 해석과 bundle, template와 memo 예제를 이관한다. 정책은
   `version: 1`을 유지하면서 새 필드로 바꾸고 공개 API 지도, 가이드와 지원 표도 갱신한다.
5. 아래 검증을 통과한 Windows 결과를 기록한다. 이후 macOS를 같은 공개 계약에
   맞춰 구현한다. 등록한 plugin의 target adapter가 없으면 `UNSUPPORTED`로 실패하고
   기존 내장 기능으로 자동 대체하지 않는다.

## 완료 검증

- plugin 없는 앱이 storage/log/capabilities 없이 설치, 시작, 종료된다.
- storage만 설치한 독립 앱은 log/capabilities package를 요구하지 않고 저장을 실행한다.
- 설치했지만 등록하지 않은 기능의 호출은 `UNSUPPORTED`이며 native 자원은 열지 않는다.
- 중복 작업, plugin 이름, 없는 의존성, 계약 불일치와 scope 오류를 setup 전에 거부한다.
- 객체형 정의와 class getter로 작성한 plugin 계약을 모두 유지한다. `native`와
  `requiredPermissions`를 추가해도 원래 setup과 명령의 메서드 receiver를 보존한다.
- 뷰 둘과 앱 둘의 동시 호출에서 권한과 취소 신호가 섞이지 않는다. setup의 backend
  권한이 view 호출에 적용되지 않는다.
- allow와 deny, 잘못된 경로, 링크, 최종 핸들, 승인 후 취소의 기존 저장 회귀를 통과한다.
- 종료, 초기화 실패에서 pending 호출과 자원을 회수한다. 로그 plugin이 없어도
  프레임워크 시작 실패와 명령 오류의 진단을 확인할 수 있다.
- 같은 index.ts의 호출이 SDK의 browser와 bun 조건으로 구현과 타입을 각각 선택한다.
  browser bundle에 backend AsyncLocalStorage, Bun/Node 또는 FFI 구현이 들어가지 않는다.
- 독립 tarball 설치, typecheck, validate, dev 재시작, build와 실제 Windows 창에서
  직접 plugin 호출과 앱 command를 통한 호출을 검증한다.
- `docs:check`, `docs:build`와 관련 reference-map 검사를 통과한다. 다른 플랫폼의
  실제 실행 검증은 Windows 계약 테스트의 통과와 구분해 기록한다.

## 모든 기능의 선택 등록과 Core 의존성 제거

[ADR 0014](../decisions/0014-optional-plugin-packages.md)에 따라 창 제어도 @bunaway/plugin-windows로 설치하고 등록한다. 정책은 windows 전용 배열 대신 windows:list와 windows:control의 `{ view }` allow, deny 범위를 사용한다. 시작 창, WebView, 앱 종료와 진단은 플랫폼 자원 수명 관리로 유지한다.

플러그인 작성 SDK는 Backend SDK와 Core를 의존하지 않는다. @bunaway/plugin-api가 앱 계약과 실행 컨텍스트를 소유하고 Core와 Backend SDK가 이를 사용한다. /host 하위 경로는 Bun 전용 컨텍스트이며 루트의 공통 타입을 브라우저와 portable Core에서 읽어도 Bun 자원을 가져오지 않는다.

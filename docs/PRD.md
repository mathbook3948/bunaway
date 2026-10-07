# Bun 기반 크로스플랫폼 앱 프레임워크 PRD

작성일: 2026-10-04 · 구현 상태 갱신: 2026-10-05 (macOS native CI 작업) · 상태: 제품 요구사항·단계별 구현 진행 중 · 제품명: bunaway

## 1 목표와 범위

개발 순서는 **Windows를 먼저 완성한 뒤 다른 플랫폼을 같은 Bun 기반 개발 모델에
맞추는 것**이다. macOS도 Bun을 앱 진입점으로 전환할 계획이며, 현재의 별도 호스트·
Bun 자식 프로세스 구조는 기존 구현 상태다. 앱 개발자는 공통 앱 정의 하나를 작성하고
플랫폼별 부팅은 프레임워크가 담당한다. 개발 우선순위와 진입점 결정은
[ADR 0010](./decisions/0010-windows-first-platform-model.md)을 따른다.

웹으로 화면을 만들고 TypeScript로 앱 백엔드를 작성하는 독립 프레임워크를 만든다. Windows, macOS, Linux, Android, iOS를 대상으로 하며 기본 렌더러는 각 운영체제의 WebView다. Bun은 빌드 도구이자 앱 패키지에 포함하는 백엔드 런타임으로 사용한다. Windows는 번들 Bun을 앱 진입점으로 사용하고 같은 프로세스의 UI Worker가 직접 FFI로 Win32·WebView2를 소유한다. 현재 macOS 구현은 별도 Bun 자식 프로세스를 사용한다. 후속 지원에서는 Bun 앱 진입점으로 전환하며 모바일의 실행·배포 경로도 검증한다.

Tauri에서 참고할 부분은 웹 UI, 백엔드 코어, 네이티브 호스트를 나누는 구조다. 명령 처리, 상태, 이벤트, 플러그인 관리 등 백엔드 기반을 Bun과 TypeScript 중심으로 설계한다. 네이티브 코드는 창, WebView, 운영체제 기능과 Bun 내장에 필요한 경계에 둔다.

이 문서는 책임, 인터페이스, 보안 규칙과 단계별 완료 조건을 정한다. A 단계의 계약 구현과 Windows B 단계의 번들 Bun 프로세스·IPC 실험을 완료했다. C 단계에서는 실제 SDK·코어·Host API와 Windows WebView2 호스트를 연결했다. 세 창의 다중 창/뷰와 뷰별 정책 분리에서 메모 저장·이벤트·재실행 후 복원과 오류·취소·권한·렌더러 재생성·창별 종료를 검증한 기록이 있다([Windows C 실행 결과](./architecture/windows-host-results.md)). macOS arm64의 POSIX probe와 AppKit·WKWebView 단일 창/뷰 호스트도 구현돼 있다. [macOS 실행 기록](./architecture/macos-native-results.md)은 기존 로컬 기록, 이번 재실행과 실제 CI 결과를 구분한다. [Windows B 실행 결과](./architecture/windows-probe-results.md)는 별도 실험 기록이다. macOS Intel·다중 창/뷰, Linux·모바일 호스트와 설치·배포는 미검증이다. macOS `.app` 생성·ad-hoc 서명은 Developer ID·공증·설치 검증이 아니다. 아래 요구사항 전체를 완료한 것은 아니며, 현재 범위는 [진행 상태](./architecture/progress.md)와 [플랫폼 지원 표](./platform-support/README.md)를 따른다.

### 제품 요구사항

- React, Vue, Svelte, vanilla HTML/JS에서 같은 클라이언트 SDK를 사용한다. 코어는 특정 UI 프레임워크를 import하지 않는다.
- 앱 개발자는 일반적인 기능을 TypeScript로 작성한다. 새 운영체제 기능을 추가할 때만 네이티브 어댑터를 작성한다.
- 프런트엔드는 등록된 명령과 이벤트만 사용한다. Bun, Node.js, 파일 시스템, 임의 네이티브 함수에 직접 접근하지 않는다.
- 데스크톱과 모바일은 같은 명령·이벤트·권한 모델을 사용한다. 플랫폼별 기능 차이는 조회 가능한 지원 정보와 명시적 오류로 드러낸다.
- 프로덕션 앱은 사용자 기기에 별도 Bun 설치를 요구하지 않는다. 런타임과 앱 자산을 설치 패키지에 포함한다.
- Chromium 계열 렌더러는 데스크톱의 선택 기능으로 둔다. 기본 WebView 구현과 동일한 SDK 계약을 따른다.

### 이번 제품에 포함하지 않는 것

- Tauri 실행 파일을 감싸는 래퍼, Tauri sidecar 기반 앱, Tauri Rust 플러그인 API나 바이너리 호환성
- 모든 TypeScript 코드를 네이티브 기계어로 바꾸는 AOT 컴파일러
- 모바일에서 데스크톱 Bun·Node.js API 전체를 지원한다는 보장
- 모바일용 Chromium 번들, 임의 원격 코드 실행, 신뢰할 수 없는 백엔드 플러그인 샌드박스
- 첫 릴리스의 자동 업데이트 서비스, 플러그인 마켓, 모든 운영체제 API의 추상화

## 2 기본 실행 구조

Windows의 기본 구조는 번들 Bun 진입점·앱/코어 메인·Win32/WebView2 UI STA Worker·파일 I/O Worker다.
같은 프로세스에서 구조화 복사 채널로 연결하며 WebView 브라우저·렌더러 프로세스는 유지한다.
실제 출처와 권한은 UI가 검증하고 코어와 SDK 계약은 재사용한다.
사용자 Bun 설치나 PATH에 의존하지 않으며 검증한 내부 Bun의 절대 경로를 실행한다.
[ADR 0006](./decisions/0006-windows-bun-ui-worker.md)이 Windows의 현재 계약이다.
아래 별도 Bun/IPC 도식은 macOS와 기존 Windows B/C 실험의 구조를 설명한다.

```text
웹 UI ── 클라이언트 SDK
              │ 비동기 요청·응답·이벤트
              ▼
네이티브 호스트 ── 발신 WebView 식별·권한 검사·렌더러 어댑터
              │ 프로세스 IPC: 요청·응답·이벤트·수명주기
              ▼
Bun 자식 프로세스 ── TypeScript 코어 ── 앱 명령·상태·플러그인
              │ 범위가 지정된 비동기 Host API 요청
              ▼
네이티브 호스트 ── 권한 재검사 ── UI 스레드 / OS 작업 큐
```

네이티브 호스트가 최소 부트 설정을 읽고 번들된 Bun을 실행한다. Bun 코어의 등록이 끝나면 `ready`를 교환한 뒤 첫 WebView에 브리지를 연결한다. 화면 초기화 실패와 자식 프로세스 실행·IPC 초기화 실패를 구별해 보고한다. B 단계의 통과 근거는 번들된 실행 파일 사용, 별도 PID, 실제 IPC 왕복과 종료 시 자식 프로세스 정리다.

### 모듈과 의존 방향

| 모듈 | 책임과 공개 계약 | 허용하는 의존성 |
| --- | --- | --- |
| `protocol` | 메시지 스키마, 오류 코드, 버전 협상, 직렬화 규칙 | 플랫폼·Bun·UI 의존성 없음 |
| `client-sdk` | `invoke`, `listen`, `unlisten`, 기능 조회, 요청 취소 | `protocol`, 주입받은 Transport |
| `core` | 명령 레지스트리, 입력 검증, 상태 저장소, 이벤트 라우팅, 플러그인 수명 | `protocol`, 추상 Host API, Runtime Services |
| `runtime-bun` | 자식 프로세스 안의 코어 부팅, Bun 서비스 어댑터, 프로세스 IPC 연결 | `core`, `protocol`, Bun API |
| `bun-bundle` | 배포할 Bun 실행 파일, 버전·소스 revision·해시·라이선스 고정 | 공식 플랫폼별 Bun 배포물, 필요한 경우 기록된 빌드·패치 |
| `native-host` | 앱 수명주기, Bun 프로세스 실행·정리, IPC, 신뢰 경계, OS 권한, 창 | OS 프로세스 API, 생성된 프로토콜·정책 자료, 렌더러 인터페이스 |
| `renderer-*` | WebView/CEF 생성, 탐색 정책, 메시지 전달, 자산 공급 | 네이티브 호스트의 렌더러 계약, 해당 OS SDK |
| `tooling` | 설정 검증, SDK 타입 생성, 개발 서버 연결, 번들, 네이티브 빌드와 패키징 | 위 모듈의 배포 형식과 빌드 어댑터 |

`core`는 Swift, Kotlin, JNI, Win32 또는 WebView 라이브러리를 직접 참조하지 않는다. 렌더러는 앱 명령의 의미를 알지 못한다. 빌드 도구는 앱 실행에 포함하지 않는다. TypeScript와 네이티브 양쪽에서 쓰는 프로토콜·정책 스키마는 한 정의에서 생성한다.

### 네이티브 구현과 플랫폼 후보

- Windows: Bun 메인·UI STA Worker·I/O Worker, 직접 Win32/WebView2 FFI 및 다중 창/뷰·뷰별 정책·독립 CLI 실행 검증
- macOS: AppKit·WKWebView를 연결하는 Swift/Objective-C++ 호스트
- Linux: GTK·WebKitGTK 기반 C/C++ 호스트
- Android: Kotlin 앱 수명주기·Android WebView, Bun 실행·패키징 경로 별도 검증
- iOS: Swift 앱 수명주기·WKWebView, Bun 실행·패키징 경로 별도 검증

Windows는 현재 TypeScript Bun FFI 호스트를 사용하며 C++ 컴파일 의존이 없다. 위 macOS 호스트는 현재 구현을, Linux·모바일 후보는 초기 제안을 설명한다. 후속 플랫폼의 목표 설계는 ADR 0010에 따라 Windows에서 완성한 Bun 기반 개발 모델에 맞추며 플랫폼별 바인딩과 수명주기는 지원 시점에 검증한다. 기존 경량 호스트 라이브러리 재사용 여부는 라이선스, UI 스레드 제어, 모바일 경계와 유지보수 비용을 검토한 뒤 결정한다. 앱 개발자에게 Rust 작성을 요구하지 않으며 코어를 Rust로 다시 구현하지 않는다.

## 3 실행 경계와 수명주기

### 프로세스와 IPC

- WebView 조작과 OS UI 호출은 UI 스레드에 전달한다. 자식 프로세스의 시작·IPC 입출력·종료 대기는 UI 스레드를 막지 않는다.
- Windows B 단계는 호스트가 만든 전용 stdin/stdout 파이프를 사용한다. stdout은 UTF-8 JSON 프레임 전용이며 로그는 stderr로 분리한다. 프레임 분할·병합, 크기 상한, EOF와 역압을 처리한다.
- 부트 설정, `hello`/`ready`, 요청·응답·이벤트, Host API 요청과 종료 제어는 버전이 있는 IPC 계약으로 전달한다. 기존 Web IPC JSON은 별도 내부 envelope의 payload로 운반하며 WebView가 내부 컨텍스트나 제어 메시지를 만들 수 없게 한다.
- 큐 투입 결과와 작업 완료 결과를 구분한다. 프로세스 사이에는 직렬화한 데이터만 전달하며 JS 객체·네이티브 포인터를 전달하지 않는다. Bun 런타임 DLL과 VM 호출용 C ABI는 필수 구현에서 제외한다.
- 런타임 ID·세대 번호와 호출 컨텍스트는 호스트가 발급한다. 프로세스 종료 뒤 도착한 메시지는 폐기하고 큐 크기, 메시지 크기, 진행 중 요청 수에 상한을 둔다.
- 초기 구현은 앱 인스턴스당 Bun 자식 프로세스 하나다. 여러 WebView는 같은 백엔드의 분리된 라우팅 컨텍스트를 사용한다. 재시작은 새 프로세스와 새 세션으로 수행하며 자동 재시작·요청 재전송은 MVP에 포함하지 않는다.

### 상태 전이

`created → starting → ready → stopping → stopped`를 기본 상태로 삼고 초기화·실행 실패에는 `failed`를 기록한다. 모바일의 foreground/background와 WebView 생성·폐기는 별도 상태로 관리한다. 백그라운드 전환이 백엔드 종료를 뜻하지 않으며 OS가 앱을 정지하거나 종료할 수 있다.

Windows의 현재 실행·채널·종료 계약은 [ADR 0006](./decisions/0006-windows-bun-ui-worker.md)과
[실제 검증](./architecture/windows-bun-results.md)을 따른다. 아래 IPC·suspended spawn은
기존 Windows B 실험 및 다른 프로세스 플랫폼의 기록이다.

종료 시 새 요청 접수를 막고 IPC로 종료를 요청한다. 진행 중 요청과 구독을 기한 내 정리한 뒤 자식 프로세스의 실제 종료와 파이프 EOF를 확인하고 프로세스·파이프 핸들을 회수한다. 종료 응답만으로 `stopped`를 선언하지 않는다. 기한을 넘기면 호스트가 관리하는 자식 프로세스 트리를 강제 종료하고 실제 종료를 확인한다. Windows에서는 kill-on-close Job Object로 호스트 비정상 종료 때도 Bun이 남지 않게 한다. Bun을 suspended 상태로 생성해 Job에 배정한 뒤 실행하며 배정 실패 시 시작을 실패시킨다.

Android Activity 재생성은 백엔드 수명과 분리한다. iOS scene 변경과 suspend/resume에서는 오래된 WebView 세션을 무효화하고 필요한 상태를 다시 동기화한다. 앱 종료 직전 콜백이나 무제한 백그라운드 실행은 보장하지 않는다. 지속해야 할 데이터는 정상 작업 중 저장한다.

## 4 명령과 이벤트 프로토콜

- 요청은 프로토콜 버전, 세션 내 고유 요청 ID, 명령 이름, 검증 가능한 payload, 선택적 deadline을 가진다. 발신 WebView·frame·origin은 네이티브가 관찰한 값으로 붙이며 payload의 자기 신고를 신뢰하지 않는다.
- 핸드셰이크에서 프로토콜 major, 지원 feature, 런타임 빌드 ID를 교환한다. major 불일치는 시작을 중단하고 minor 차이는 협상된 기능만 허용한다. Web IPC 버전과 호스트↔Bun 내부 IPC 버전은 별도로 관리한다.
- MVP 직렬화는 크기가 제한된 JSON이다. 함수, 순환 객체, 임의 클래스, 원시 포인터는 거부한다. 바이너리와 스트리밍은 별도 전송 계약이 마련된 뒤 추가한다.
- 한 요청은 응답 또는 오류로 한 번만 종료된다. deadline 초과·취소 뒤 늦게 온 응답은 폐기한다. 취소는 이미 끝난 외부 부작용의 롤백을 보장하지 않는다. 부작용이 있는 명령은 자동 재시도하지 않는다.
- 오류에는 안정된 `code`, 안전한 `message`, 선택적 구조화 `details`를 사용한다. 기본 코드는 `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `UNSUPPORTED`, `TIMEOUT`, `CANCELLED`, `BUSY`, `INTERNAL`이다.
- 이벤트는 구독 ID, 발신 컨텍스트, 대상과 순서를 가진다. 구독별 순서를 보장하되 서로 다른 생산자 간 전체 순서는 보장하지 않는다. 큐 초과는 조용히 누락하지 않고 명시적으로 알린다.
- 이벤트는 영구 메시지 저장소가 아니다. 재연결한 화면은 스냅샷 명령으로 상태를 복구한다. `listen`은 해제 함수를 반환하며 창 폐기·탐색·재연결 때 기존 구독을 정리한다.
- 앱 상태는 기본적으로 Bun 백엔드 프로세스의 메모리에 존재한다. 명령 핸들러는 비동기 작업 사이에 교차 실행될 수 있으므로 공유 상태의 원자적 변경이나 직렬 실행이 필요한 명령을 명시한다.

## 5 권한과 보안 모델

앱에 포함한 Bun 백엔드와 네이티브 플러그인은 신뢰 코드다. WebView는 XSS나 공급망 문제로 공격받을 수 있다고 가정한다. 이 권한 모델은 WebView가 요청할 수 있는 기능을 제한한다. 악성 백엔드 코드를 샌드박싱하지 않으며 신뢰 백엔드의 직접 Bun API 사용까지 가로막는다고 주장하지 않는다.

1. 권한은 기본 거부다. 앱 manifest에 창/뷰별 허용 명령, 이벤트, 네이티브 기능과 데이터 범위를 선언한다. 와일드카드 전체 허용은 기본 템플릿에 넣지 않는다.
2. 네이티브 브리지 진입점에서 세션·frame·origin·명령 권한을 검사한다. Bun 코어는 핸들러 실행 전에 런타임 스키마로 입력을 검증한다. TypeScript 타입만으로 입력을 검증한 것으로 간주하지 않는다.
3. 각 네이티브 권한 기능을 실행하기 직전에 발신 컨텍스트, 허용 범위, 현재 OS 권한과 대상 자원의 유효성을 재검사한다. 플러그인·대체 렌더러·다른 IPC 경로도 같은 검사를 통과한다.
4. WebView에서 시작한 작업의 호출 컨텍스트는 호스트가 소유한 불투명 핸들로 전달한다. SDK나 payload가 권한을 위조하거나 백엔드 자체 작업으로 승격하지 못하게 한다. 백엔드 자체 작업도 명시적으로 선언한 Host API 범위를 사용한다.
5. 파일 접근은 앱 데이터·임시 폴더 등 명명된 범위와 상대 경로로 제한한다. `..`, 심볼릭 링크 탈출, 검사 이후 대상 변경을 막도록 실제 파일을 여는 네이티브 경계에서 검증한다. 파일 선택 결과는 범위가 있는 핸들로 전달한다.
6. 임의 `eval`, shell 실행, 경로 제한 없는 파일 접근, 임의 동적 라이브러리 로딩을 프런트엔드 명령으로 제공하지 않는다. 비밀값·원본 스택·환경 변수는 응답과 로그에서 제거한다.
7. 원격 페이지와 서브프레임에는 기본적으로 브리지를 주입하지 않는다. 탐색과 새 창 생성은 허용 목록으로 제어한다. 탐색이 발생하면 기존 세션 권한과 미완료 요청을 무효화한다.
8. 개발 모드의 HMR origin과 디버그 브리지는 명시적으로 활성화한다. 프로덕션은 서명된 배포물에 포함된 자산과 정책만 로드하고 CSP를 적용한다. 내부 자산 공급 경로는 순회 공격을 차단하며 공개 localhost 서버를 기본 통신 경로로 삼지 않는다.

OS 권한 선언과 런타임 사용자 동의는 프레임워크 권한과 별개로 충족해야 한다. OS 권한이 거부되거나 철회되면 오류를 반환한다. 권한 토큰을 프런트엔드에 전달하거나 요청이 있었다는 이유만으로 권한을 확대하지 않는다.

## 6 공개 SDK와 플러그인

공개 SDK는 프런트엔드용 `client`와 신뢰 백엔드용 `backend` 진입점을 분리한다. 명령 정의에서 클라이언트 타입을 생성하되 백엔드 코드나 비밀 설정이 프런트엔드 번들에 들어가지 않게 한다. 필수 API는 명령 등록·호출, 앱 상태, 이벤트 구독·해제, 수명주기와 기능 조회다.

공통 타입과 명령 입력·출력 검증은 [C 공통 API](./architecture/common-api.md)로 고정했다.
`createClient`·`createCore`와 Windows용 `runBunApp`의 실행 연결을 구현했다.
명령 타입 생성 CLI와 기본 로그·저장 플러그인은 미구현이다. 다음은 계약 사용 예시이며,
생성된 타입과 `notes.read` 앱 전체의 실행 검증을 뜻하지 않는다. 실제 실행 샘플은
[메모 앱](../examples/memo/README.md)이다.

```ts
// backend/main.ts
import { command, type AppDefinition } from "@bunaway/backend";

export default {
  commands: {
    "notes.read": command({
      input: {
        type: "object",
        properties: { key: { type: "string", pattern: "^[a-z0-9_-]+$(?![\\s\\S])" } },
        required: ["key"],
        additionalProperties: false,
      },
      output: { type: "string" },
      async handle({ key }, ctx) {
        // 원래 요청의 컨텍스트로 Host API의 appData 범위를 검사한다.
        return ctx.host.call("storage.readText", { scope: "appData", path: `notes/${key}.txt` });
      },
    }),
  },
  events: {},
} satisfies AppDefinition;

// frontend/main.ts
import type { Client } from "@bunaway/client";
import type { Commands } from "../generated/commands";
// 실행 시 createClient({ transport, hello })로 생성한다. 아래는 타입 사용 예시다.
declare const client: Client<Commands>;
const text = await client.invoke("notes.read", { key: "welcome" });
```

위 예제를 허용하는 정책에는 해당 뷰의 `notes.read` 명령과 `appData/notes` 읽기 범위를 함께 선언한다. 입력 패턴은 편의 검증이며 네이티브 파일 범위 검사를 대체하지 않는다.

플러그인은 이름·버전·의존성·지원 플랫폼·필요 권한·명령 스키마·초기화·종료 훅을 선언한다. 순수 TypeScript 플러그인과 네이티브 구현이 필요한 플러그인을 구분한다. 네이티브 플러그인은 호스트 계약을 따르며 ABI 호환성을 빌드 시 검사한다. 첫 기본 플러그인은 로그와 범위 제한 저장소로 좁힌다. 권한, 네이티브 바이너리와 코드 변경을 포함한 플러그인은 앱을 다시 빌드해 배포한다.

## 7 플랫폼과 Bun 기능 지원 계획

아래 상태는 이 프레임워크의 계획이다. 기존 Bun이나 운영체제의 지원 상태를 제품 검증 완료로 바꾸어 적지 않는다. 최소 OS 버전과 CPU 범위는 각 런타임·WebView 의존성이 확인된 뒤 지원 표에 고정한다.

| 대상 | 기본 렌더러 | 백엔드 배포 경로 | 초기 상태와 통과 조건 |
| --- | --- | --- | --- |
| Windows | WebView2 | 번들 Bun 진입점 + 직접 FFI UI Worker + I/O Worker | B 실험 및 C 다중 창/뷰·뷰별 정책의 실제 SDK·코어·저장·이벤트·복원 검증 통과. 최소 OS/CPU·설치·서명·배포 미검증 |
| macOS | WKWebView | 번들된 Bun 자식 프로세스 + 네이티브 호스트 | 계획. 앱 번들·서명·IPC·프로세스 정리 검증 필요 |
| Linux | WebKitGTK | 번들된 Bun 자식 프로세스 + 네이티브 호스트 | 계획. 대상 배포판·라이브러리·IPC·패키지 검증 필요 |
| Android | Android WebView | 미확정 | 미검증. Bun 번들·실행방식·수명주기·배포 제약을 별도 검증 |
| iOS | WKWebView | 미확정 | 미검증. Bun 실행 가능 경로·기기·수명주기·배포 제약을 별도 검증 |
| 데스크톱 선택 렌더러 | CEF 등 Chromium 계열 | 동일한 백엔드·Host API | 후속. 번들 크기·하위 프로세스·서명·라이선스 검토 |

| Bun 또는 플랫폼 기능 | 공통 계약 | 모바일 처리 |
| --- | --- | --- |
| JS 계산, Promise, 타이머, 로그, 오류 | 최소 런타임 검증 대상 | Android·iOS 각각 확인 |
| `fetch` | 비동기 네트워크 검증 대상 | TLS·인증서·네트워크 정책·중단 동작을 확인 |
| 파일 I/O | 앱 샌드박스·명명된 범위 | 임시 파일과 앱 데이터부터 검증 |
| Node.js 호환 모듈, SQLite, 추가 Worker | 기능별 지원 목록 | 모듈별 검증 전에는 미검증으로 표시 |
| `bun:ffi`, TCC, native addon, `spawn` | 공통 SDK의 필수 기능에서 제외 | 초기 지원 보장 없음. iOS는 우선 비지원 |
| 창 다중 생성, 메뉴, 트레이 | 데스크톱 확장 API | 자동 모사하지 않고 `UNSUPPORTED` 반환 |

SDK의 기능 조회 결과는 `supported`, `experimental`, `unsupported`와 이유를 반환한다. 플랫폼 기능 지원 여부와 사용자의 OS 권한 허용 여부는 별도 필드다. 필수 미지원 기능은 빌드를 실패시키고 선택 기능은 런타임에서 분기할 수 있게 한다.

## 8 개발 도구와 패키징

CLI의 필수 흐름은 프로젝트 생성, 개발 실행, 설정·권한 검증, 빌드, 패키징, 환경 진단이다. 이름은 제품명 결정 뒤 정한다. 생성 프로젝트는 UI, 백엔드, manifest와 생성된 타입을 분리한다. 프런트엔드는 빌드 명령·출력 디렉터리·개발 URL 계약만 충족하면 되며 Vite나 Bun 번들러 중 하나를 강제하지 않는다.

개발 중 UI는 HMR을 사용하고 백엔드 변경은 Bun 자식 프로세스를 정리한 뒤 새 프로세스를 시작해 반영한다. 이전 세션과 미완료 요청을 무효화하고 부작용이 있는 요청을 자동 재전송하지 않는다. 프로덕션 빌드는 UI 자산, 백엔드 번들, 정책, 플러그인 목록, 런타임 버전과 해시를 함께 고정한다. 작업 디렉터리의 임의 `.env`·설정·스크립트가 자동 로드되지 않게 한다.

`bun build --compile`은 코드와 Bun 런타임을 포함한 실행 파일을 만드는 기능이다. TypeScript 전체를 네이티브 AOT로 바꾸거나 APK·IPA를 생성하는 기능으로 취급하지 않는다. 공식 compile 대상 표와 모바일 앱의 실행·배포 지원 범위는 별도로 관리한다. [Bun 실행 파일 문서](https://bun.com/docs/bundler/executables)

패키저는 대상별 네이티브 빌드 도구와 서명 흐름을 호출하는 어댑터를 둔다. Android는 Gradle·NDK, iOS는 Xcode 도구 체인을 사용하며 하나의 OS에서 모든 타깃을 빌드할 수 있다고 가정하지 않는다. 서명 키는 앱 코드나 저장소에 넣지 않는다. 배포물에 사용한 Bun 버전·소스 revision·배포 URL·실행 파일 SHA-256, 필요한 경우의 패치 목록, OS SDK, 네이티브 의존성과 라이선스 고지를 남긴다. 패키지 안의 Bun을 절대 경로로 실행하며 전역 설치를 찾거나 사용자에게 Bun 설치를 요구하지 않는다.

```text
packages/   protocol/  client-sdk/  backend-sdk/  core/  runtime-bun/  cli/
native/     host-api/  windows/  macos/  linux/  android/  ios/
runtime/    bun-bundle/  patches/  build-manifests/
renderers/  system-webview/  chromium/
plugins/    log/  storage/
templates/  vanilla/  react/  vue/  svelte/
examples/   memo/  commands/  lifecycle/  permissions/
tests/      protocol/  core/  conformance/  security/  lifecycle/
docs/       architecture/  api/  platform-support/  decisions/
```

`chromium`은 첫 단계에서 인터페이스 자리만 정의한다. 플랫폼 빌드 코드가 `core`로 올라오지 않게 의존성을 검사하고 공통 계약 테스트는 각 네이티브 호스트 구현에 같은 입력·기대 결과로 적용한다.

## 9 구현 단계와 완료 조건

| 단계 | 산출물 | 다음 단계로 넘어가는 조건 |
| --- | --- | --- |
| A 구조 고정 | 모듈 경계, Web·프로세스 IPC 계약, 정책 스키마, Bun 배포물 후보 | 순환 의존성 없음. 프로세스 소유권·프레이밍·종료·버전 규칙을 문서에서 추적 가능 |
| B 런타임 실현성 | WebView 없는 Windows 최소 호스트 + 번들된 Bun 실행 파일 + IPC 실험 | Bun 실행, 산술·Promise·타이머, IPC 요청·응답·이벤트, 오류 전달, 앱 종료 시 Bun 프로세스 정리 검증 |
| C 수직 기능 구현 | 한 데스크톱 플랫폼의 UI→명령→범위 제한 저장→이벤트 | 오류·취소·권한 거부·창 종료까지 계약 테스트 통과 |
| D 플랫폼 확장 | 나머지 데스크톱, Android·iOS 호스트와 지원 표 | 각 플랫폼의 공통 기능·수명주기·패키징 검증. 부분 성공을 전체 지원으로 표시하지 않음 |
| E 배포 가능한 초기 버전 | SDK, CLI, 템플릿, 기본 플러그인, 문서, 서명된 배포 샘플 | 아래 출시 기준 충족. 미해결 제약과 지원 버전을 공개 |
| F 선택 기능 | Chromium 렌더러와 추가 네이티브 플러그인 | 기존 SDK·권한 계약을 그대로 충족하고 별도 배포 비용 검증 |

B 단계는 Windows 자식 프로세스 방식에 집중한다. 번들된 Bun의 절대 경로·버전·해시와 호스트/자식 PID를 기록하고, 각 계산 결과를 실제 IPC 응답으로 확인한다. 이벤트 구독·전달·해제, JS 오류와 비정상 종료, 정상 종료·종료 기한 초과·호스트 비정상 종료 때 남은 Bun 프로세스가 없는지 검증한다. 사용자에게 별도 Bun 설치를 요구하지 않는 실행 환경도 확인한다. 구체적인 실험과 증거는 [B 단계 계획](./architecture/runtime-feasibility.md)에 따른다.

Windows B 실험 통과 후 C 단계의 client-sdk·core·runtime-bun과 WebView→명령 호출→범위 제한 저장→이벤트를 연결했고, 메모 앱과 다중 창/뷰의 오류·취소·권한·창별 종료를 검증했다. 단계 표는 목표와 완료 조건이며 전체 플랫폼의 완료 표가 아니다. 남은 C 범위와 D~F 작업은 [진행 상태](./architecture/progress.md)를 따른다. Android·iOS의 실행 방식, 앱 수명주기와 배포 제약은 D 단계에서 각각 검증한다. Windows 성공을 모바일 지원 완료로 간주하지 않는다.

### 초기 버전 출시 기준

- 각 지원 플랫폼에서 신규 프로젝트의 설치·실행·명령·상태·이벤트·저장이 작동하고 Bun 별도 설치가 필요하지 않는다.
- vanilla, React, Vue, Svelte 예제가 동일한 SDK 계약을 사용하며 프런트엔드 번들에 백엔드 구현·비밀 설정이 포함되지 않는다.
- 잘못된 payload, 권한 없는 명령·이벤트, frame/origin 위조, 오래된 세션, 경로 탈출, 프로토콜 불일치와 큐 포화를 거부한다.
- 종료·재연결·Activity 재생성·suspend/resume 경로에서 교착, 해제된 핸들 접근, 중복 응답과 남은 구독이 없다. 앱 종료 뒤 Bun 자식 프로세스와 관리 대상 하위 프로세스가 남지 않는다.
- 시작 시간, 유휴 메모리, 패키지 크기, IPC 지연을 환경·빌드·측정 방법과 함께 기록한다. 목표 수치는 첫 기준 측정 후 정하며 측정 전 성능 우위를 주장하지 않는다.
- 지원 표와 릴리스 산출물이 일치하고 실패를 재현할 수 있는 로그가 남는다. 로그는 비밀값을 제거하며 텔레메트리 전송을 기본 활성화하지 않는다.

## 10 확인된 자료와 미해결 결정

Bun 공식 문서는 실행 파일 번들링을 설명하고 Bun 1.4는 Android 런타임을 experimental로 표기한다. 이것만으로 모바일 앱의 Bun 실행·수명주기·배포가 검증되지는 않는다. [공식 Android 발표](https://bun.com/blog/bun-v1.4#experimental-android-support)

Tauri는 구조를 비교하는 참고 자료다. Tauri의 Rust 코어나 플러그인 호환 계층을 의존성으로 선택한 것은 아니다. [Tauri 구조](https://v2.tauri.app/concept/architecture/)

Skal의 고정 commit `7edb44aceb8c69ac1abd76549e2c09cf6cdc8a57`에서는 VM 작업 큐·타이머 연결을 볼 수 있다. 동시에 프로세스당 singleton, 비어 있는 dispose, Android 링크 우회 설정 등이 있어 수명주기와 배포 안전성을 별도로 검증해야 한다. `-z norelro` 같은 실험 설정은 프로덕션 기본값으로 가져오지 않는다. [Skal 소스](https://github.com/skal-multiplatform/skal/tree/7edb44aceb8c69ac1abd76549e2c09cf6cdc8a57)

`dannote/bun`의 iOS 포트 commit `a3f7a71a950b81109c39a755dca3a018ea121e1c`에는 pthread에서 `bun_main`을 실행하는 내장 경로와 JITless 제약이 있다. 프로세스 전역 상태와 표준 출력 리디렉션의 영향, FFI·TCC·프로세스 실행 제한을 검토해야 한다. 두 프로젝트는 이전 동일 프로세스 설계에서 조사한 참고 자료이며 현재 Windows 번들 프로세스 방식의 의존성이 아니다. 실제 실행 검증 결과로 취급하지 않는다. [iOS 포트 문서](https://github.com/dannote/bun/blob/a3f7a71a950b81109c39a755dca3a018ea121e1c/docs/guides/runtime/ios-embedding.mdx)

현재 결정된 항목과 남은 결정은 다음과 같다.

- Windows x64 baseline과 macOS arm64 번들 Bun 1.4.2의 소스 revision·실행 파일 해시·라이선스는 각각 [Windows manifest](../runtime/build-manifests/windows-x64.json)와 [macOS manifest](../runtime/build-manifests/darwin-aarch64.json)로 고정했다. 다른 CPU/플랫폼 배포물과 upstream 업데이트 검증 책임은 후속 결정이다.
- 모바일의 Bun 실행·배포 경로와 지원할 Bun·Node.js API 목록, native addon 지원 범위
- 프로세스 IPC envelope·프레이밍·큐 상한·종료·오류 처리와 Windows Job 정리는 구현했다. macOS는 프로세스 그룹·guard로 정리하며 spawn 직후 guard 연결 전 race 제약이 남는다. Linux·모바일 정리 방식은 미결정이다.
- Windows의 WebView2 SDK·네이티브 의존성·라이선스와 가상 자산 origin, macOS의 `WKURLSchemeHandler` 자산 origin 매핑은 구현에 고정했다. 최소 OS·CPU·WebView 런타임 지원 범위 및 Linux·모바일 호스트·자산 origin은 별도 검증·결정이 필요하다.
- 서명·공증·스토어 제출에 필요한 조건과 iOS 코드 실행·업데이트 정책. 검토 전 스토어 배포 가능성을 보장하지 않음

CLI create/validate/doctor/dev/build와 vanilla 템플릿, 로컬 프레임워크 설치 artifact·버전 검증은 구현했다.
[프레임워크 배포 문서](./framework-distribution.md)에 저장소 밖 설치·업그레이드와 개발/최종 사용자 요구사항을 구분한다.
현재 다음 작업은 플랫폼별 검증 범위 확대, macOS 다중 창/뷰, UI framework 템플릿의 네이티브 검증, 기본 플러그인,
공개 릴리스/프레임워크 라이선스 결정, Linux·모바일 확장과 설치·서명·배포 검증이다.
A·B 및 Windows C·macOS 단일 창/뷰 성공으로 초기 버전 출시 기준 전체를 충족했다고 판단하지 않는다.

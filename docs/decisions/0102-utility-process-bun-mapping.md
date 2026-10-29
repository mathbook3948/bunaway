---
status: accepted
---

# utility process는 새 API 없이 Bun Worker와 Bun.spawn의 ipc로 대응한다

결정일: 2026-10-27. 검토 기준: main `c6b9ecc9`.

## 배경

Electron의 `utilityProcess.fork(modulePath, args, { serviceName, stdio })`는 앱이 만든 모듈을 별도 프로세스에서 실행하고,
`postMessage`로 양방향 메시지를 주고받으며, `spawn`과 `exit` 이벤트로 시작과 종료를 알린다. 크래시 격리와 별도 메모리가
필요한 작업(변환, 파싱, 외부 라이브러리)을 메인 프로세스와 나누는 용도다.

선례:

- Electron은 `utilityProcess`와 `MessagePortMain`을 제공한다.
- Tauri는 같은 기능이 없고 sidecar(`Command.sidecar`)의 stdout 이벤트로만 대응한다.
- 이 저장소의 backend는 신뢰된 Bun 코드다. `docs/TODO-windows.md`의 같은 절에서 HTTP client-request와 incoming-message stream 항목은 Bun API에
  대응시켰고, 프런트엔드는 임의 Node/Bun에 접근하지 않는다([ADR 0048](./0048-frontend-node-access-and-sync-ipc.md)).

## 결정

1. utility process 전용 공개 API, 플러그인, 권한 표면을 추가하지 않는다. 신뢰된 backend가 Bun 기능을 직접 쓴다.
2. 용도별 대응:

   | 용도 | 사용할 것 | 격리 | 메시지 | 종료와 오류 |
   | --- | --- | --- | --- | --- |
   | 같은 프로세스에서 CPU 작업을 나눈다 | `new Worker(module)` | 스레드. 크래시와 메모리는 공유한다. | `postMessage`, `onmessage` | `onerror`, `terminate()` |
   | 크래시 격리와 별도 메모리가 필요하다 | `Bun.spawn([...], { ipc })` | 프로세스 | `proc.send`, `ipc` 콜백 | `onExit(proc, code, signal)` |
   | 바이트 스트림으로 외부 프로그램을 다룬다 | `process.spawn` (stdin/stdout 파이프) | 프로세스. 호스트가 Job Object와 권한을 관리한다. | 파이프 | `process.spawn`의 종료 상태 |

   `Bun.spawn({ ipc })` 자식은 앱이 실행 파일과 함께 배포하는 Bun 스크립트를 `process.execPath`로 실행하되 환경 변수
   `BUN_BE_BUN=1`을 준다. 이 변수가 있으면 컴파일된 실행 파일이 호스트 대신 일반 Bun으로 동작한다. 앱 실행 파일을 변수
   없이 다시 실행하면 호스트가 새로 시작해 이미 잡힌 앱 잠금을 만나 실행 중인 인스턴스로 인자를 넘기고 끝나므로 ipc
   자식으로 쓸 수 없다(`native/windows/bun/boot.ts`의 시작 순서 기준이며 이 동작을 시험으로 확인하지는 않았다). 번들 sidecar 실행 파일은 이 ADR의 범위가 아니며 sidecar 문서를 따른다.
3. 호스트 빌드는 entry point(`boot.js`, `ui.js`, `host-operations.js`)가 `packages/cli/src/windows-compile.ts`에 고정이고
   앱이 추가할 수 없다. entry point 하나로 컴파일한 실행 파일에서 번들에 들어 있지 않은 모듈 경로를 `new Worker`에 주면
   `ModuleNotFound`로 실패하는 것을 확인했다(이 실패 경로는 시험에 넣지 않았다). Worker는 (a) 앱이 실행 파일과 함께 배포하는 스크립트 파일의
   경로, 또는 (b) 소스 문자열로 만든 Blob URL로 만든다. 둘 다 컴파일된 실행 파일에서 동작한다.
4. Windows에서 앱 프로세스는 데이터 디렉터리를 점유할 때 Job Object(`KILL_ON_JOB_CLOSE`)에 들어가므로 `Bun.spawn`으로 만든
   자식과 그 후손은 앱이 끝나면 함께 종료된다. 자식을 앱보다 오래 두려면 별도 방법이 필요하고 이 결정은 제공하지 않는다.
   macOS의 자식 정리는 이 결정에서 다루지 않는다.
5. 제공하지 않는 것: 사용자 지정 `serviceName`(Task Manager 표시 이름), 프로세스별 샌드박스(backend sandbox 결정을 다시
   정하지 않는다), MessagePort 전달(MessagePort 항목을 다시 정하지 않는다), 자식 stdout/stderr 자동 로그 연결.

## 근거

- Electron은 `utilityProcess`로, Tauri는 sidecar로 대응해 둘이 다르다. 이 저장소의 backend는 이미 Bun이어서 Worker와
  `Bun.spawn`의 `ipc`가 같은 기능을 그대로 제공한다. 코어를 늘리지 않고 쓰는 곳이 확인될 때까지 래퍼를 만들지 않는다.
- backend는 신뢰된 코드이고 경로 제한은 앱 책임이다. 앱이 만든 모듈만 실행하므로 보안 경계가 바뀌지 않는다.
- Windows에서는 호스트 Job Object가 후손을 정리하므로 별도 종료 처리 없이 앱 종료 뒤 자식이 남지 않는다.

## 검증

`tests/lifecycle/windows-utility-process.test.ts`는 호스트 빌드처럼 entry point 하나로 컴파일한 실행 파일로 다음을 확인한다.
앞의 두 항목은 모든 호스트에서, 셋째 항목은 Windows에서만 실행한다.

- 스크립트 파일과 Blob URL로 만든 Worker의 요청과 응답, 처리되지 않은 오류의 `onerror` 전달.
- `BUN_BE_BUN=1`로 실행한 `Bun.spawn({ ipc })` 자식이 별도 프로세스이고 양방향 메시지가 오가며, 종료 코드가 `onExit`으로
  전달되고 부모가 유지됨.
- 앱 Job Object(`containAppProcess`) 안에서 시작한 ipc 자식이 앱 종료 뒤 남지 않음.

이 시험은 실제 호스트 부팅(`boot.js`)을 거치지 않는다. `BUN_BE_BUN`이 호스트를 건너뛰는 것은 컴파일된 Bun 런타임의 동작에
기대며, Windows CI의 시험이 그 가정을 확인한다.

## 결과

- 코드, 이벤트, 권한, 스키마 변경은 없다.
- 사용법을 backend 호스트 API 문서에 적고 `docs/TODO-windows.md`의 해당 항목을 완료로 표시한다.

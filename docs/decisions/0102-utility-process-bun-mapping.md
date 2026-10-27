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
- 이 저장소의 backend는 신뢰된 Bun 코드다. 같은 절의 HTTP client-request와 incoming-message stream 항목은 Bun API에
  대응시켰고, 프런트엔드는 임의 Node/Bun에 접근하지 않는다([ADR 0048](./0048-frontend-node-access-and-sync-ipc.md)).

## 결정

1. utility process 전용 공개 API, 플러그인, 권한 표면을 추가하지 않는다. 신뢰된 backend가 Bun 기능을 직접 쓴다.
2. 용도별 대응:

   | 용도 | 사용할 것 | 격리 | 메시지 | 종료와 오류 |
   | --- | --- | --- | --- | --- |
   | 같은 프로세스에서 CPU 작업을 나눈다 | `new Worker(module)` | 스레드. 크래시와 메모리는 공유한다. | `postMessage`, `onmessage` | `onerror`, `terminate()` |
   | 크래시 격리와 별도 메모리가 필요하다 | `Bun.spawn([...], { ipc })` | 프로세스 | `proc.send`, `ipc` 콜백 | `onExit(proc, code, signal)` |
   | 바이트 스트림으로 외부 프로그램을 다룬다 | `process.spawn` (stdin/stdout 파이프) | 프로세스. 호스트가 Job Object와 권한을 관리한다. | 파이프 | `process.spawn`의 종료 상태 |

   `Bun.spawn({ ipc })` 자식은 같은 앱의 Bun 스크립트나 앱 실행 파일 자신(`process.execPath`와 역할 환경 변수)이다.
   번들 sidecar 실행 파일은 이 ADR의 범위가 아니며 sidecar 문서를 따른다.
3. 컴파일된 backend에서 `new Worker`가 쓰는 모듈은 `bun build --compile`의 추가 entry point로 포함해야 한다.
   포함하지 않으면 실행 파일에서 모듈을 찾지 못한다.
4. 앱 프로세스는 데이터 디렉터리를 점유할 때 Job Object(`KILL_ON_JOB_CLOSE`)에 들어가므로 `Bun.spawn`으로 만든 자식과
   그 후손은 앱이 끝나면 함께 종료된다. 자식을 앱보다 오래 두려면 별도 방법이 필요하고 이 결정은 제공하지 않는다.
5. 제공하지 않는 것: 사용자 지정 `serviceName`(Task Manager 표시 이름), 프로세스별 샌드박스(backend sandbox 결정을 다시
   정하지 않는다), MessagePort 전달(MessagePort 항목을 다시 정하지 않는다), 자식 stdout/stderr 자동 로그 연결.

## 근거

- Electron은 `utilityProcess`로, Tauri는 sidecar로 대응해 둘이 다르다. 이 저장소의 backend는 이미 Bun이어서 Worker와
  `Bun.spawn`의 `ipc`가 같은 기능을 그대로 제공한다. 코어를 늘리지 않고 쓰는 곳이 확인될 때까지 래퍼를 만들지 않는다.
- backend는 신뢰된 코드이고 경로 제한은 앱 책임이다. 앱이 만든 모듈만 실행하므로 보안 경계가 바뀌지 않는다.
- 호스트 Job Object가 후손을 정리하므로 별도 종료 처리 없이 앱 종료 뒤 자식이 남지 않는다.

## 검증

`tests/lifecycle/windows-utility-process.test.ts`는 컴파일한 실행 파일로 다음을 확인한다. 첫 항목은 모든 호스트에서,
둘째 항목은 Windows에서만 실행한다.

- Worker의 요청과 응답, 처리되지 않은 오류의 `onerror` 전달.
- `Bun.spawn({ ipc })` 자식이 별도 프로세스이고 양방향 메시지가 오가며, 종료 코드가 `onExit`으로 전달되고 부모가 유지됨.
- 앱 Job Object 안에서 시작한 ipc 자식이 앱 종료 뒤 남지 않음.

## 결과

- 코드, 이벤트, 권한, 스키마 변경은 없다.
- 사용법을 backend 호스트 API 문서에 적고 `docs/TODO-windows.md`의 해당 항목을 완료로 표시한다.

---
status: accepted
---

# Windows 단일 인스턴스는 인자와 작업 디렉터리만 전달하고 lock 조회와 해제 API를 두지 않는다

결정일: 2026-10-25

Windows 호스트는 같은 앱 데이터 디렉터리를 한 앱 인스턴스만 사용하게 하고, 두 번째 실행의 인자와
작업 디렉터리를 `onOpen`의 `OpenRequest`(`source: "second-instance"`)로 기존 앱에 전달한다.
Electron은 여기에 더해 두 번째 인스턴스가 `requestSingleInstanceLock(additionalData)`로 보내는
추가 데이터, `hasSingleInstanceLock()` 조회, `releaseSingleInstanceLock()` 해제를 제공한다.
이 셋을 제공할지 정한다. macOS 호스트는 실행 인자를 받지 않고 `onOpen`을 시작 때 한 번만 호출하므로
이 결정은 Windows 호스트 기준이다.

## 결정

1. 추가 데이터를 전달하는 API를 두지 않는다. 파이프로 전달하는 데이터는 `argv`와 `cwd`뿐이다. `urls`, `files`, `launchReason`은 호스트가 받은 `argv`에서 파생한다.
2. lock 상태 조회 API를 두지 않는다.
3. lock 해제 API를 두지 않는다.

## 근거

- Tauri의 single-instance 플러그인(2.5.4)은 콜백에 `AppHandle`, 인자, 작업 디렉터리만 넘기며 추가 데이터
  전달 API와 lock 보유 조회 API, JS API가 없다. 공개 함수 `destroy()`는 있으나 종료 때 자원(Windows mutex,
  Linux D-Bus 이름, macOS 소켓 파일)을 정리하는 용도이고 `RunEvent::Exit`에서 자동 호출되며 해제 뒤 다시
  얻는 API는 없다. 두 번째 인스턴스는 앱 실행 전에 바로 종료된다. 이 정리는 Windows 호스트에서 프로세스
  종료가 lock 핸들을 닫는 것으로 이미 이뤄지므로 앱이 부를 API가 필요 없다.
- Electron의 `additionalData`는 두 번째 인스턴스가 `requestSingleInstanceLock(additionalData)`로 보내고
  첫 인스턴스가 `second-instance` 이벤트의 네 번째 인자로 받는다. Electron 문서는 `argv`의 순서가 바뀌거나
  인자가 추가될 수 있으니 정확한 값이 필요하면 `additionalData`를 쓰라고 권한다. 이 호스트의 `argv`는
  두 번째 실행의 앱 인자를 순서와 문자열 그대로 복사하며, 앞에서 떼어내는 것은 프레임워크 시작 인자
  (개발 모드의 `--dev-url`, `--devtools`)와 autostart 표지뿐이고 호스트가 인자를 추가하지 않는다. 그래서
  정확한 값을 위해 별도 추가 데이터가 필요하지 않다. 전달에는 최대 256개 인자와 64 KiB의 JSON 한도가
  적용되며, 별도 추가 데이터 경로를 두면 크기 한도와 오류 처리를 한 벌 더 정의해야 한다.
- 호스트는 앱 코드를 import하기 전에 앱 데이터 디렉터리의 배타적 lock을 얻는다. 얻지 못한 프로세스는
  기존 인스턴스에 인자를 전달하고 종료하므로 앱 코드가 실행 중이면 lock을 보유한 것이고 조회 결과는
  항상 `true`이다. 인스턴스 파이프 bind는 lock 획득 뒤 앱 import 전에 한다.
- lock을 앱이 해제하면 같은 앱 데이터 디렉터리를 둘째 프로세스가 동시에 쓰게 되어 storage, store, 로그의
  단일 쓰기 전제가 깨진다. Tauri에는 정리용 `destroy()`만 있고 재획득이 없으며 쓰는 곳도 없다.
  이 호스트의 lock은 앱 수명과 같다.

## 호환성

공개 API, 권한, 호스트 이벤트, 오류 코드의 변경이 없다. 추후 쓰는 곳이 생기면 별도 결정으로 추가한다.

# Windows B 단계 실행 결과

검증일: 2026-10-04. WebView 없는 C++ 호스트가 앱 패키지의 Bun을 별도 프로세스로
실행하고 실제 파이프로 통신하는 B 단계가 통과했다. 사용자 Bun 설치·PATH에 의존하지 않는다.

## 고정한 배포물과 환경

- Bun **1.4.2**, Windows x64 baseline 공식 배포물. 소스 패치 없음.
- source revision: `744846f844374847c902b5e7fd59b4342a51ef99`
- 실행 파일 SHA-256: `15277c59ccd6c6c20f8dc9716c2b59c1776320d606b6a8658f70be8799519ca4`
- Windows `10.0.26200`, x64. Visual Studio Build Tools 18.3.2,
  MSVC 19.50.35725 / 도구 디렉터리 14.50.35717, Windows SDK 10.0.26100.0.
- CMake 4.3.1, Ninja, C++20 Release, `/MT /W4 /WX /utf-8`.
- `dumpbin /DEPENDENTS`의 호스트 의존성은 `bcrypt.dll`, `KERNEL32.dll`뿐이다.
  별도 MSVC 런타임 설치가 필요 없다.
- JSON 파서 nlohmann/json 3.12.0 단일 헤더. 다운로드·라이선스 해시도 고정.

URL·아카이브·실행 파일·라이선스 해시는
[배포 manifest](../../runtime/build-manifests/windows-x64.json)에 있다.
빌드 스크립트는 다운로드를 검사하고 라이선스와 백엔드·설정·생성 스키마를 패키징한다.
호스트는 Bun과 패키지 자산 해시를 실행 전에 다시 검사한다.

## 재현

개발 환경의 PowerShell 7, MSVC C++ Build Tools, CMake/Ninja를 준비한 뒤 저장소 루트에서 실행한다.

```powershell
mise run install
mise run check
mise run probe:windows
```

빌드 스크립트는 `native/windows/probe/run.ps1`, 네이티브 호스트는 `host.cpp`,
실험 백엔드는 `backend.ts`, 외부 검증기는 `tests/lifecycle/windows-process.ts`다.
`build/windows-probe-package/`에 `bunaway-probe.exe`, `runtime/bun.exe`,
백엔드·설정·스키마·manifest·라이선스를 모은다. 런타임 실행에는 MSVC·mise·개발 Bun이 필요 없다.
호스트의 stdin/stdout을 NDJSON 제어기로 연결해 실행한다. 콘솔 실험 패키지이며 UI는 없다.

검증기는 패키지를 `build/B 단계 한글 package/`로 복사하고, Bun이 없는 시스템 PATH와
별도 cwd로 호스트를 실행한다. 부모 환경의 `BUN_OPTIONS`·임의 환경 변수와 cwd의
`.env`·preload 설정을 넣어도 백엔드에 적용되지 않는 것을 확인한다.
호스트는 `--config=...`·`--tsconfig-override=...`를 각각 하나의 인자로 전달한다.

## 실제 관찰

**Windows 통합 검증 38개, 계약 테스트 33개 통과.**

| 항목 | 확인 결과 |
| --- | --- |
| 번들 실행·PID | 한글·공백 경로, 사용자 Bun 없는 PATH, 다른 cwd에서 ready. OS 자식 PID = Bun PID, 호스트 PID와 다름 |
| 계산 | `2 + 2 → 4`, Promise `→ 42`, 타이머 `→ timer-done`, 동시 요청 ID 매칭 |
| 이벤트 | 구독→sequence 1 이벤트→해제. 해제·구독 컨텍스트 폐기 후 늦은 이벤트 폐기 |
| 오류 | throw·rejection의 안정된 code/message, 원본 오류 정보 제외. exit 17·Bun이 살아 있는 stdout EOF 시 미완료 요청 실패 |
| 로그 | stderr 288 KiB를 별도로 배출하고 전달량 64 KiB로 제한. IPC 응답 완료 |
| 프레이밍 | UTF-8 문자 내부 분할, 여러 프레임 병합, 정확히 1 MiB·깊이 64 수신 |
| 거부·폐기 | 손상 JSON·UTF-8, 1 MiB 초과·깊이 65, 빈 줄·미완성 EOF·stdout 로그, 다른 세대·버전·ID 재사용 거부. 늦은 중복 응답 폐기 |
| JSON 일치 | 큰 숫자는 binary64, 음수 0은 0, 중첩 객체 중복 키는 마지막 값 |
| 스키마 일치 | 공통 입력 47개로 조건 결합·중첩 값 중복·Unicode 길이·단독 surrogate·줄 구분자 경로 검사 일치. 이모지 600자의 오류도 실제 IPC 통과 |
| 문자열 계약 | 단독 surrogate 값·객체 키는 송신 전에 거부해 호스트 연결 유지. 정상 surrogate 쌍은 키·값 모두 IPC 왕복 |
| 과부하 | 128개 미완료 요청 한도 초과 시 실패·프로세스 정리, 남은 요청은 오류로 완료 |
| 정상 종료 | 진행 중 타이머 취소, 종료 응답 이후 실제 Bun 종료·EOF·Job 활성 프로세스 0개 확인 |
| 강제 종료 | 종료를 무시하는 Bun은 2초 기한 후 강제 종료. 호스트를 죽여도 Bun과 자손 정리 |
| 출력 정체 | 80만 자 echo 응답 소비를 중단해도 종료 후 출력 정리 2초 기한으로 동기 I/O 취소. 출력을 다시 읽기 전에 호스트와 Bun 종료 확인 |

2026-10-04 08:14:21 UTC 실행에서 호스트 PID `34164`, OS 자식 PID와 Bun ready PID
`54332`였다. 정상 종료는 `exitCode: 0`, `forced: false`, `failed: false`,
`activeProcesses: 0`으로 끝났다. 테스트 PID는 실행마다 바뀐다.

네이티브 `--watch` 검증기는 종료 전에 `OpenProcess(SYNCHRONIZE)`로 실제 Bun·자손
프로세스 핸들을 잡고 종료 뒤 signal을 기다린다. PID 조회에서 사라진 것만으로 성공을 추정하지 않는다.
호스트 강제 종료는 Bun 내부의 종료 처리 없이 Job kill-on-close가 정리하는지 확인한다.

`build/windows-probe-results.json`에 실행 시각·OS·호스트 해시·패키지 manifest,
테스트별 결과와 실제 PID·ready·요청·응답·이벤트·오류·종료 프레임을 남긴다.
출력이 막힌 경로에서는 오류·최종 진단 프레임이 잘릴 수 있다. 이 테스트는 프레임 대신
호스트 종료 코드와 미리 확보한 OS 프로세스 핸들로 종료를 확인한다.
실험의 `host-started`·`host-stopped`·`host-error`·`host-discarded`는 외부 검증용 진단이며
제품의 Web IPC 메시지가 아니다.

## 다음 단계의 경계

B 실험은 `probe` 런타임·세대 `1`·`probe-view`를 고정하고 테스트 명령만 처리한다.
Host API 요청·응답은 스키마만 정의했다. 제품의 client-sdk·core·WebView2, 세션·origin·frame
검증, 권한 정책과 파일 저장 경계는 C 단계에서 구현한다.
현재 임시 경로는 쓰기 가능한 실험 패키지의 `assets/tmp`다. 설치 앱에서는 읽기 전용
패키지와 앱 데이터·임시 디렉터리를 분리해야 한다.

설치 프로그램·서명·최소 Windows/CPU 지원 범위, macOS·Linux·Android·iOS 실행은
이 결과에 포함하지 않는다. Windows B 성공을 다른 플랫폼의 완료로 확대하지 않는다.

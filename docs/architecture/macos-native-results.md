# macOS 네이티브 회귀 검증 기록

기준일: 2026-10-05. 코드 구현, 과거 실행과 이번 실행을 분리한다.
Windows 실행 기록은 [B](./windows-probe-results.md), [C](./windows-host-results.md)에 보존한다.

2026-10-07 선택형 플러그인 이관 이후에는 아래 저장 API 실행 기록을 현재 지원 근거로
사용하지 않는다. 현재 macOS 어댑터는 네이티브 권한을 거부한다. 통합 fixture는 공통
명령, 이벤트, 탐색과 렌더러 복구를 검사하며 메모 상태는 Bun 메모리에만 유지한다.
네이티브 테스트는 미지원 권한과 작업의 거부, 취소된 요청의 응답 폐기를 검사한다.

## 기존 기록: 이번 실행 결과가 아님

[macOS 포트 PR #7](https://github.com/mathbook3948/bunaway/pull/7)의 최종 검증 기록은
macOS **26.5.2 arm64**, head `2f65d8bfc2d7d23175addbdcee1ad8061246c44c` 기준이다.
probe 50/50, 제품 호스트 8/8, 계약 108개, ad-hoc `.app` 서명 확인과 인자 없는
번들 실행 31개 페이지 검사의 성공을 기록했다. Developer ID, 공증, 설치 검증은 없다.
해당 당시 메모 샘플 `.app`의 시각적 실행 기록도 현재 Windows 다중 창 설정의
macOS 호환성을 증명하지 않는다.

작업 시작 main `5a9641eeac9c44a670d43cefb23069db833ed221`에는 Windows 다중 창 변경이
포함돼 공유 `tests/fixtures/desktop/host/app.json`이 `windows[]` 설정으로 바뀌었다.
macOS 호스트는 단일 `view`/`home`만 읽으므로 기존 “로컬 통과”를 현재 성공으로
취급하지 않았다. 새 최초 실행은 `Configured view is not in the policy.`로 실패했고,
실패 JSON과 stderr를 확인했다. 회귀용 macOS 단일 창 선언을 별도 fixture로 분리했다.
Windows 설정, 백엔드, 정책은 변경하지 않는다. 공유 메모 페이지의 테스트 분기는
Windows 영속 브라우저 프로필을 기본 기대값으로 유지하고, macOS driver만
`browserStorage=ephemeral`로 비영속 `WKWebsiteDataStore`의 재시작 초기화를 검사한다.
저장된 메모는 브라우저 저장소가 아닌 범위 제한 Host API 파일로 계속 복원되어야 한다.

## 이번 검증

| 실행 | 환경 | 새 결과 |
| --- | --- | --- |
| 로컬 재실행(2026-10-05) | macOS 26.5.2 arm64, Darwin 25.5.0 | probe 50/50, 실제 WKWebView host 8/8, 계약 테스트 108/108; format, lint, workspace/tests 타입 검사, 생성 스키마 diff, zsh 문법 검사 통과 |
| 첫 Actions 실행(2026-10-05) | macOS 15.7.9 arm64, Xcode 16.4 | [run 37264442220](https://github.com/mathbook3948/bunaway/actions/runs/37264442220/job/111618163806): CPU/pin 확인과 다운로드 해시 확인 후 probe 컴파일 실패. 실제 WKWebView는 아직 실행되지 않음. [실패 로그 artifact](https://github.com/mathbook3948/bunaway/actions/runs/37264442220/artifacts/11326345199) 업로드 성공(3개 로그, JSON 생성 전 실패) |
| 수정 후 Actions(2026-10-05) | macOS 15.7.9 arm64, Xcode 16.4, `macos-15-arm64` image `20260907.0337.1`, Aqua 세션 | head `e610121d7e4797430b900fc5cca92c32e8f775a8`의 [run 37264579408](https://github.com/mathbook3948/bunaway/actions/runs/37264579408/job/111618580621): probe **50/50**, 실제 WKWebView host **8/8**, skip 없음. [성공 진단 artifact](https://github.com/mathbook3948/bunaway/actions/runs/37264579408/artifacts/11326286235) 업로드 성공(43개 파일, 55,440 bytes) |

수정 후 run은 공통 검사 3개 OS, 기존 Windows native까지 **5/5 job 성공**이다.
Windows 회귀도 이번 run에서 다시 성공했다([job](https://github.com/mathbook3948/bunaway/actions/runs/37264579408/job/111618580420),
[artifact](https://github.com/mathbook3948/bunaway/actions/runs/37264579408/artifacts/11325980985)).
이는 기존 Windows 기록과 별도의 이번 CI 결과이며 로컬 Windows 재실행은 하지 않았다.
실제 WKWebView 페이지 보고서, 리소스 수신/차단, 메모 파일 복원, renderer 강제 종료 후
복구, host 강제 종료 후 Bun 정리를 요구하는 suite가 runner에서 실행되어 통과했다.
artifact 업로드 성공, 파일 수는 Actions 로그로 확인했다.

로컬에는 mise 명령이 없어 `mise.toml`의 동일 Bun/zsh 명령으로 검사했다.
이번 로컬 실행에서는 `.app`, 서명, 공증, 설치를 재검증하지 않았다.

첫 CI는 로컬 macOS 26 SDK에 존재하는 `posix_spawn_file_actions_addchdir`가
macOS 15 SDK에는 없어 컴파일 실패했다. probe, host 양쪽의 cwd 지정에
macOS 10.15부터 제공되는 동등 `posix_spawn_file_actions_addchdir_np`를 사용하도록
수정했다. 로컬 성공을 runner 성공으로 간주하지 않음으로써 이 차이를 확인했다.
현재 26 SDK에서는 해당 이전 이름의 deprecation 경고가 있지만 빌드 실패는 아니다.
또한 격리한 build 복사본의 네이티브 실행 파일을 실패 파일로 바꿔 양 driver의
`ok: false` JSON, 0이 아닌 종료 코드가 `tee` 뒤에도 보존되고 host 진단 파일이
남는 것을 별도로 확인했다(제품 정상 실행 결과와 합산하지 않음).

## 고정 배포물과 재현

- Bun 1.4.2, source revision `744846f844374847c902b5e7fd59b4342a51ef99`, 소스 패치 없음.
- [darwin-aarch64 manifest](../../runtime/build-manifests/darwin-aarch64.json)의 공식
  ZIP SHA-256 `90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f`,
  실행 파일 SHA-256 `35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5`.
- nlohmann/json 3.12.0, Bun/JSON 라이선스도 다운로드 시 해시 검사한다.
- 호스트는 패키지 Bun과 자산 manifest를 시작 시 다시 검증한다.

```sh
mise run install
mise run check
# 공유 캐시의 다운로드/추출 때문에 반드시 직렬 실행
mise run probe:macos
mise run host:macos
```

Apple Silicon, Xcode CLT, 실제 AppKit/WKWebView를 실행할 GUI 세션이 필요하다.
Intel pin은 없으며 현재 스크립트가 다른 CPU를 거부한다.
위 2026-10-05 CI 기록은 `.app` 없이 패키지 실행 파일을 직접 실행한 결과다.
현재 CI는 `run.sh --app`으로 ad-hoc 서명한 `.app`도 실행한다.
코드 커밋 `fae4b80`의 [2026-10-07 실행](https://github.com/mathbook3948/bunaway/actions/runs/37554130779/job/112576288095)은 통과했다.
probe/host는 실패를 throw/nonzero로 전달하며, CI의 bash `-e -o pipefail`은
로그용 `tee` 뒤에서도 실패를 보존한다. skip 또는 GUI 모킹을 사용하지 않는다.

## 회귀 범위와 진단 산출물

- probe: 실제 POSIX spawn, NDJSON IPC, 한글/공백 경로, Bun 없는 PATH, 환경 격리,
  계산, Promise, 타이머, 이벤트, 프레이밍, 과부하, 역압, 정상/강제 종료, guard 정리.
- host: 네이티브 FIFO/스킴 핸들러/리소스 필터와 공통 검증기, 실제 WKWebView의
  SDK, 코어, 정책, frame/origin, 세션, 저장, 취소, 허용/차단 script/image/fetch 요청,
  새 Bun 프로세스의 메모 읽기, WebContent 강제 종료 후 복구와 guard 정리.
- macOS는 단일 창/뷰만 검증한다. 공유 페이지의 요청 ID 테스트가 통과해도
  Windows 다중 창/뷰 격리 검증과 동일한 범위는 아니다.

성공, 실패 모두 `macos-native-diagnostics` artifact로 7일 보관한다.

| 경로 | 내용 |
| --- | --- |
| `build/macos-probe/macos-probe-results.json` | OS/CPU, pin, 호스트 해시, test별 ok/error, 실제 IPC trace |
| `build/macos-host-results.json` | OS/CPU, test별 ok/error, 소요 시간 |
| `build/macos-native-logs/` | runner 환경, install, probe, host 빌드/드라이버 stdout/stderr |
| `build/macos-host-diagnostics/` | native 회귀 stdout/stderr, 실행별 호스트 stderr, test별 logs/temp 보고서 snapshot |

다음 테스트의 `resetData()` 전에 snapshot을 남겨 앞선 호스트/페이지 보고서가
지워지지 않게 한다. 진단 복사에서는 FIFO, 링크, 비정규 파일을 제외한다.
컴파일, 다운로드, 초기 setup 실패나 job 강제 취소 시 JSON 생성 이전일 수 있다.
이미 생성된 로그는 `if: always()`로 업로드하지만 강제 timeout/cancel은 완전한 수집을
보장하지 않는다. artifact 보존 기간 뒤에는 PR의 실행 링크, 이 요약과 재현 명령을 따른다.

## 남은 제약

[지원 표](../platform-support/README.md)를 따른다. Intel, 다중 창/뷰, 최소 OS,
Developer ID, 공증, 설치, 스토어 배포는 미검증이다. `run.sh --app`은 ad-hoc 서명이며
메모 예제는 CLI로 실행하며 회귀용 메모 fixture는 테스트 폴더에 분리되어 있다.
guard는 Bun을 spawn한 뒤 연결되므로 그 짧은 구간의 비정상 호스트 종료 race는 남는다.

# macOS 네이티브 회귀 검증 기록

기준일: 2026-10-05. 코드 구현, 과거 실행과 이번 실행을 분리한다.
Windows 실행 기록은 [B](./windows-probe-results.md)·[C](./windows-host-results.md)에 보존한다.

## 기존 기록 — 이번 실행 결과가 아님

[macOS 포트 PR #7](https://github.com/mathbook3948/bunaway/pull/7)의 최종 검증 기록은
macOS **26.5.2 arm64**, head `2f65d8bfc2d7d23175addbdcee1ad8061246c44c` 기준이다.
probe 50/50, 제품 호스트 8/8, 계약 108개, ad-hoc `.app` 서명 확인과 인자 없는
번들 실행 31개 페이지 검사의 성공을 기록했다. Developer ID·공증·설치 검증은 없다.
해당 당시 메모 샘플 `.app`의 시각적 실행 기록도 현재 Windows 다중 창 설정의
macOS 호환성을 증명하지 않는다.

작업 시작 main `5a9641eeac9c44a670d43cefb23069db833ed221`에는 Windows 다중 창 변경이
포함돼 공유 `native/windows/host/test/app.json`이 `windows[]` 설정으로 바뀌었다.
macOS 호스트는 단일 `view`/`home`만 읽으므로 기존 “로컬 통과”를 현재 성공으로
취급하지 않았다. 새 최초 실행은 `Configured view is not in the policy.`로 실패했고,
실패 JSON과 stderr를 확인했다. 회귀용 macOS 단일 창 선언을 별도 fixture로 분리했다.
Windows 설정·백엔드·정책은 변경하지 않는다. 공유 메모 페이지의 테스트 분기는
Windows 영속 브라우저 프로필을 기본 기대값으로 유지하고, macOS driver만
`browserStorage=ephemeral`로 비영속 `WKWebsiteDataStore`의 재시작 초기화를 검사한다.
저장된 메모는 브라우저 저장소가 아닌 범위 제한 Host API 파일로 계속 복원되어야 한다.

## 이번 검증

| 실행 | 환경 | 새 결과 |
| --- | --- | --- |
| 로컬 재실행(2026-10-05) | macOS 26.5.2 arm64, Darwin 25.5.0 | probe 50/50, 실제 WKWebView host 8/8, 계약 테스트 108/108; format·lint·workspace/tests 타입 검사·생성 스키마 diff·zsh 문법 검사 통과 |
| 이번 GitHub Actions | `macos-15` ARM64 예정 | PR 생성 후 실제 실행 결과를 확인한다. 아직 성공으로 기록하지 않음 |

로컬에는 mise 명령이 없어 `mise.toml`의 동일 Bun/zsh 명령으로 검사했다.
이번 로컬 실행에서는 `.app`·서명·공증·설치를 재검증하지 않았다.

## 고정 배포물과 재현

- Bun 1.4.2, source revision `744846f844374847c902b5e7fd59b4342a51ef99`, 소스 패치 없음.
- [darwin-aarch64 manifest](../../runtime/build-manifests/darwin-aarch64.json)의 공식
  ZIP SHA-256 `90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f`,
  실행 파일 SHA-256 `35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5`.
- nlohmann/json 3.12.0·Bun/JSON 라이선스도 다운로드 시 해시 검사한다.
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
macOS CI는 `.app` 없이 패키지 실행 파일을 직접 실행한다.
probe/host는 실패를 throw/nonzero로 전달하며, CI의 bash `-e -o pipefail`은
로그용 `tee` 뒤에서도 실패를 보존한다. skip 또는 GUI 모킹을 사용하지 않는다.

## 회귀 범위와 진단 산출물

- probe: 실제 POSIX spawn·NDJSON IPC, 한글/공백 경로·Bun 없는 PATH·환경 격리,
  계산·Promise·타이머·이벤트, 프레이밍·과부하·역압, 정상/강제 종료·guard 정리.
- host: 네이티브 FIFO/스킴 핸들러/리소스 필터와 공통 검증기, 실제 WKWebView의
  SDK·코어·정책·frame/origin·세션·저장·취소, 허용/차단 script/image/fetch 요청,
  새 Bun 프로세스의 메모 읽기, WebContent 강제 종료 후 복구와 guard 정리.
- macOS는 단일 창/뷰만 검증한다. 공유 페이지의 요청 ID 테스트가 통과해도
  Windows 다중 창/뷰 격리 검증과 동일한 범위는 아니다.

성공·실패 모두 `macos-native-diagnostics` artifact로 7일 보관한다.

| 경로 | 내용 |
| --- | --- |
| `build/macos-probe/macos-probe-results.json` | OS/CPU·pin·호스트 해시·test별 ok/error·실제 IPC trace |
| `build/macos-host-results.json` | OS/CPU·test별 ok/error·소요 시간 |
| `build/macos-native-logs/` | runner 환경·install·probe·host 빌드/드라이버 stdout/stderr |
| `build/macos-host-diagnostics/` | native 회귀 stdout/stderr, 실행별 호스트 stderr, test별 logs/temp 보고서 snapshot |

다음 테스트의 `resetData()` 전에 snapshot을 남겨 앞선 호스트/페이지 보고서가
지워지지 않게 한다. 진단 복사에서는 FIFO·링크·비정규 파일을 제외한다.
컴파일·다운로드·초기 setup 실패나 job 강제 취소 시 JSON 생성 이전일 수 있다.
이미 생성된 로그는 `if: always()`로 업로드하지만 강제 timeout/cancel은 완전한 수집을
보장하지 않는다. artifact 보존 기간 뒤에는 PR의 실행 링크·이 요약과 재현 명령을 따른다.

## 남은 제약

[지원 표](../platform-support/README.md)를 따른다. Intel·다중 창/뷰·최소 OS,
Developer ID·공증·설치·스토어 배포는 미검증이다. `run.sh --app`은 ad-hoc 서명이며
현재 Windows 다중 창 메모 설정을 복사하는 `--sample`의 실행은 지원하지 않는다.
guard는 Bun을 spawn한 뒤 연결되므로 그 짧은 구간의 비정상 호스트 종료 race는 남는다.

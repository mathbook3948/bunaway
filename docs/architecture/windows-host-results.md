# Windows 제품 호스트 실행 결과

검증일: 2026-10-05. WebView2를 탑재한 네이티브 Win32 호스트가 앱 패키지의 Bun을
별도 프로세스로 실행하고, Web 경계·세션·정책·저장 범위·프로세스 정리를 실제
Windows에서 검증했다. 사용자 Bun 설치·PATH에 의존하지 않는다.
B 실험의 기존 증거는 [별도 실행 결과](./windows-probe-results.md)에 있다. 이번 검증에서는 B 실험을 재실행하지 않았다.

## 고정한 배포물과 환경

- Bun **1.4.2**, Windows x64 baseline 공식 배포물. 소스 패치 없음.
  [B 단계와 같은 manifest와 해시](../../runtime/build-manifests/windows-x64.json).
- WebView2 SDK **1.0.4129.50** NuGet 패키지를 벤더 해시로 고정하고
  `WebView2LoaderStatic.lib`로 정적 링크한다. Evergreen 런타임만 요구한다.
- nlohmann/json **3.12.0** 단일 헤더.
- Windows `10.0.26200`, x64. MSVC 19.50.35725, C++20 `/MT /W4 /WX /utf-8`.
  `dumpbin /DEPENDENTS`의 의존성은 `bcrypt`·`ole32`·`shell32`·`user32`·
  `kernel32`·`advapi32`뿐이다. 별도 MSVC 런타임이 필요 없다.

## 재현

```powershell
mise run install
mise run check
mise run host:windows
```

빌드·패키징 스크립트는 `native/windows/host/run.ps1`, 호스트는 `host.cpp`,
실제 코어를 부팅하는 테스트 백엔드는 `test/backend.ts`, 테스트 Web 앱은 `test/web/`,
외부 검증기는 `tests/lifecycle/windows-host.ts`다.
검증기는 패키지를 `build/C 호스트 한글 package/`로 복사하고, Bun 없는 PATH와
`BUN_OPTIONS` preload·cwd의 `.env`가 심어진 별도 cwd로 실행한다.

## 실제 관찰

**Windows 통합 검증 5개, 페이지 검사 28개, 메모 화면 검사 3회, 네이티브 회귀 항목
8개와 계약 테스트 108개(861 assertions) 통과. 워크스페이스·테스트·메모 앱·호스트
백엔드 타입 검사와 lint·format 검사도 통과.**

`runtime-bun.runBunApp`이 `createCore`를 만들고 WebView는 `createClient`와
`createWebViewTransport`를 사용한다. 초기화 중 Host API를 호출하는 플러그인도
실제 네이티브 로그 왕복을 완료한 뒤 ready가 된다. 첫 탐색은 ready 이후 시작한다.
SDK의 첫 hello가 준비 전 도착해 연결이 멈추던 시작 순서를 수정했다.

메모 샘플은 [별도 패키지](../../examples/memo/README.md)로도 빌드했다. 통합 검증은
동일한 메모 명령·UI에 테스트용 보고 명령을 더한 패키지에서 실행했다.

| 항목 | 확인 결과 |
| --- | --- |
| 번들 실행 | 한글·공백 패키지 경로에서 pinned Bun이 자식 프로세스로 ready. `BUN_OPTIONS`·cwd `.env`·preload 미적용 |
| WebView 경계 | `app.bunaway.local` 가상 호스트에서 로컬 자산 로딩. `example.org` 탐색·리소스 차단(`navigation-blocked`, `web-resource-blocked`) |
| origin·frame | 실제 `args.Source` 문서와 세션 문서를 대조. 자식 iframe이 보낸 `iframe-1` invoke는 백엔드에 도달하지 않음 |
| 메모 샘플 | 저장 버튼 클릭→`memo.save`→`appData/notes/memo.txt` 기록→`memo.saved`→화면 갱신. 호스트와 Bun을 정상 종료한 후 새 프로세스의 `memo.read`로 본문 복원 |
| 렌더러 재생성 | 테스트 앱 user-data 경로로 식별한 WebView 렌더러를 강제 종료. `webview-process-failed`→기존 세션 폐기→새 세션·SDK 연결→메모 본문 복원. Bun 재시작 없음 |
| 세션 | `ctx-<random>` 컨텍스트 발급, 탐색 시 `revoke`+`session-open` 재발급. 폐기된 세션의 늦은 요청 거부 |
| 정책 | 정책 외 명령 `test.notAllowed`와 이벤트 `other.event`는 `PERMISSION_DENIED`로 거부되고 백엔드 카운터 불변 확인 |
| 위조 방지 | Web payload의 `context` 필드 주입·내부 `shutdown` 프레임·비객체·스키마 미달 메시지 거부. 요청 ID 재사용·지난 deadline 거부 |
| 기한·취소 | `deadline` 초과 시 `TIMEOUT`+`cancel`, 늦은 백엔드 응답 폐기, `cancel` 시 `CANCELLED` |
| 이벤트 | listen→sequence 1·2 순서 유지, unlisten 뒤 이벤트 미전달 |
| Host API | `storage.writeText`/`readText` 왕복(한글 본문), `capabilities.get` 4항목, `log.write`가 `app.log`에 기록, host-cancel은 응답을 폐기 |
| 저장 범위 | `appData`는 `notes/` 접두만 허용 — `secrets/`는 `PERMISSION_DENIED`. `..`는 `INVALID_ARGUMENT`. 드라이버가 심은 junction `notes/link`→외부 디렉터리는 실제 파일 open 경계에서 `PERMISSION_DENIED`. `temp` 왕복 성공 |
| 종료 | `taskkill /PID`(WM_CLOSE)로 `shutdown`→`stopping` 왕복, `exitCode:0`, `forced:false`, Job 활성 프로세스 0. `--watch`의 OS 핸들이 Bun 종료 signal 확인 |
| 강제 종료 | 호스트를 죽여도 Job kill-on-close가 번들 Bun을 정리 |
| 스키마 일치 | `--validate`로 공통 회귀 입력을 C++ 검증기가 TypeScript와 동일하게 판정 |

실행 산출물은 `build/windows-host-results.json`에 남는다. 페이지 자산의
성공/실패 상세는 백엔드가 `temp/report*.json`, `write.json`, `read.json`으로 기록한다.
마지막 강제 종료 테스트가 전용 appData를 초기화하므로 페이지 보고 파일은 최종 실행 뒤 남지 않을 수 있다.
`build/host-integration.log`와 `build/contracts.log`에는 이번 검증의 통과 기록이 있다.

## 남은 제약

- 메모 앱은 저장·읽기만 제공한다. 실제 저장 부작용이 끝난 뒤의 취소는 파일 변경을 롤백하지 않는다.
- WebView2 Evergreen 런타임 설치가 필요하다. 설치 프로그램·부트스트래퍼·
  코드 서명·자동 업데이트는 포함하지 않는다.
- 단일 창·단일 뷰(`main`)만 검증했다. 다중 뷰·다중 창·뷰별 정책 분리는 이후다.
- `msedgewebview2` 자식 프로세스는 Job 밖이라 호스트 종료 직후 user-data
  디렉터리를 잠시 잡고 있을 수 있다.
- 최소 Windows 버전·CPU 지원 범위와 다른 플랫폼 완료는 이 결과에 포함하지 않는다.

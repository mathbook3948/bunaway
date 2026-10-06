# Windows 제품 호스트 실행 결과

이 문서는 이전 실행의 기록이다. 2026-10-06 기존 Windows C++ 소스·CMake·실행기·
전용 테스트를 삭제했다. 현재 재현 명령과 결과는 [Bun FFI 실행 기록](./windows-bun-results.md)을 따른다.


검증일: 2026-10-05. WebView2를 탑재한 네이티브 Win32 호스트가 앱 패키지의 Bun을
별도 프로세스로 실행하고, Web 경계·세션·정책·저장 범위·프로세스 정리를 실제
Windows에서 검증했다. 이번 실행에서는 다중 창/뷰와 뷰별 정책 분리를 포함해 검증했다.
사용자 Bun 설치·PATH에 의존하지 않는다.
B 실험의 기존 증거는 [별도 실행 결과](./windows-probe-results.md)에 있다. 이번 검증에서는 B 실험을 재실행하지 않았다.

## 고정한 배포물과 환경

- Bun **1.4.2**, Windows x64 baseline 공식 배포물. 소스 패치 없음.
  [B 단계와 같은 manifest와 해시](../../runtime/build-manifests/windows-x64.json).
- WebView2 SDK **1.0.4129.50** NuGet 패키지를 벤더 해시로 고정하고
  `WebView2LoaderStatic.lib`로 정적 링크한다. Evergreen 런타임만 요구한다.
- nlohmann/json **3.12.0** 단일 헤더.
- Windows Server 2022 Standard, x64. MSVC 19.44.35207, C++20 `/MT /W4 /WX /utf-8`.
  `dumpbin /DEPENDENTS`의 의존성은 `bcrypt`·`ole32`·`shell32`·`user32`·
  `kernel32`·`advapi32`뿐이다. 별도 MSVC 런타임이 필요 없다.

## 실제 관찰

**Windows 통합 검증 5개, 페이지 검사 41개, 메모 화면 검사 3회, 네이티브 회귀 항목
9개와 계약 테스트 108개(861 assertions) 통과. 워크스페이스·테스트·메모 앱·호스트
백엔드 타입 검사와 lint·format 검사도 통과.**

`runtime-bun.runBunApp`이 `createCore`를 만들고 WebView는 `createClient`와
`createWebViewTransport`를 사용한다. 다중 뷰 통합 패키지는 `windows` 선언으로
세 창(주 뷰 `main`, 쓰기 가능 `editor`, 읽기 전용 `reader`)을 열고 하나의
Bun 프로세스를 공유한다. 당시 메모 샘플의 별도 두 창 패키지도 빌드·실행해
두 세션이 하나의 Bun에서 열리고 전체 창 종료로 `host-stopped` 정리를 확인했다.
현재 [메모 예제](../../examples/memo/README.md)는 CLI로 실행하는 단일 창 앱이며,
다중 창과 권한·복원 시나리오는 `tests/fixtures/desktop/host/`에서 검증한다.
기존 `windows` 없는 단일 창 `app.json` 선언도 그대로 동작함을 메모 단계에서 검증했다.

| 항목 | 확인 결과 |
| --- | --- |
| 번들 실행 | 한글·공백 패키지 경로에서 pinned Bun이 자식 프로세스로 ready. `BUN_OPTIONS`·cwd `.env`·preload 미적용. 세 창이 하나의 Bun(`host-started` 1회) 공유 |
| 다중 창/뷰 | `windows` 배열의 세 뷰가 각각 자기 창·WebView2 환경·user-data 디렉터리와 자기 세션을 연다(`webview-ready`·`session-open` 뷰별 관찰) |
| 뷰별 정책 | 읽기 전용 `reader`의 `memo.save` 명령은 `PERMISSION_DENIED`(명령 검사), 같은 뷰의 `test.writeNote`·`test.log`는 저장·로그 권한 부족으로 `PERMISSION_DENIED`(Host 검사), `test.readNote`는 허용된 읽기로 성공. 거부된 `notes/reader.txt`는 파일이 만들어지지 않음 |
| 공유 요청 ID | 주 뷰와 읽기 전용 뷰가 같은 요청 ID(`shared-1`)를 동시에 사용해도 각자 자기 페이로드 응답을 받음. 네이티브 회귀에서도 같은 ID의 per-session 격리 확인 |
| 이벤트 필터 | `test.changed`는 `main` 정책에만 있어 그 세션에만 전달되고 `memo.saved`는 허용된 세 뷰의 구독에 각각 전달(`web-delivered` 컨텍스트 대조) |
| 창 닫기 격리 | `reader`가 `window.close()`로 자기 창만 닫음(`view-close-requested`→`view-window-closed`→`revoke`). 다른 뷰·Bun은 계속 동작하고 폐기 컨텍스트로의 `web-delivered`는 이후 없음 |
| WebView 경계 | `app.bunaway.local` 가상 호스트에서 로컬 자산 로딩. `example.org` 탐색·리소스 차단(`navigation-blocked`, `web-resource-blocked`) |
| origin·frame | 실제 `args.Source` 문서와 세션 문서를 대조. 자식 iframe이 보낸 `iframe-1` invoke는 백엔드에 도달하지 않음 |
| 메모 샘플 | 저장 버튼 클릭→`memo.save`→`appData/notes/memo.txt` 기록→`memo.saved`→화면 갱신. 호스트와 Bun을 정상 종료한 후 새 프로세스의 `memo.read`로 본문 복원 |
| 렌더러 장애 격리 | `editor` 뷰의 user-data 경로로 식별한 렌더러만 강제 종료. `webview-process-failed`→그 뷰의 세션 폐기→같은 창에서 재탐색·새 세션·보고 완료. 다른 뷰 revoke 없음, Bun 재시작 없음(`host-started` 미재발행) |
| 세션 | `ctx-<random>` 컨텍스트 발급, 탐색 시 `revoke`+`session-open` 재발급. 폐기된 세션의 늦은 요청 거부. 네이티브 회귀에서 폐기 컨텍스트 응답·비구독 이벤트의 전달 차단 확인 |
| 정책 | 정책 외 명령 `test.notAllowed`와 이벤트 `other.event`는 `PERMISSION_DENIED`로 거부되고 백엔드 카운터 불변 확인 |
| 위조 방지 | Web payload의 `context` 필드 주입·내부 `shutdown` 프레임·비객체·스키마 미달 메시지 거부. 요청 ID 재사용·지난 deadline 거부 |
| 기한·취소 | `deadline` 초과 시 `TIMEOUT`+`cancel`, 늦은 백엔드 응답 폐기, `cancel` 시 `CANCELLED` |
| 이벤트 | listen→sequence 1·2 순서 유지, unlisten 뒤 이벤트 미전달 |
| Host API | `storage.writeText`/`readText` 왕복(한글 본문), `capabilities.get` 4항목, `log.write`가 `app.log`에 `view:<viewId>` 출처로 기록, host-cancel은 응답을 폐기 |
| 저장 범위 | `appData`는 `notes/` 접두만 허용 — `secrets/`는 `PERMISSION_DENIED`. `..`는 `INVALID_ARGUMENT`. 드라이버가 심은 junction `notes/link`→외부 디렉터리는 실제 파일 open 경계에서 `PERMISSION_DENIED`. `temp` 왕복 성공 |
| 종료 | 모든 창에 WM_CLOSE(세션 로그오프와 같은 경로) → 마지막 창 닫힘 시 `shutdown`→`stopping` 왕복, `exitCode:0`, `forced:false`, Job 활성 프로세스 0. `--watch`의 OS 핸들이 Bun 종료 signal 확인 |
| 강제 종료 | 호스트를 죽여도 Job kill-on-close가 번들 Bun을 정리 |
| 스키마 일치 | `--validate`로 공통 회귀 입력을 C++ 검증기가 TypeScript와 동일하게 판정 |

실행 산출물은 `build/windows-host-results.json`에 남는다. 페이지 자산의
성공/실패 상세는 백엔드가 `temp/report*.json`, `editor.json`, `reader.json`,
`write.json`, `read.json`으로 기록한다.
마지막 강제 종료 테스트가 전용 appData를 초기화하므로 페이지 보고 파일은 최종 실행 뒤 남지 않을 수 있다.
`build/host-integration.log`와 `build/contracts.log`에는 이번 검증의 통과 기록이 있다.

## 남은 제약

- 메모 앱은 저장·읽기만 제공한다. 실제 저장 부작용이 끝난 뒤의 취소는 파일 변경을 롤백하지 않는다.
- WebView2 Evergreen 런타임 설치가 필요하다. 설치 프로그램·부트스트래퍼·
  코드 서명·자동 업데이트는 포함하지 않는다.
- 한 뷰는 한 창에만 붙는다. 창 재생성·뷰의 창 간 이동·프로토콜로 창을 여는
  명령은 없으며, 창 수는 8개로 제한한다. 닫힌 창의 뷰 세션은 복원하지 않고 폐기한다.
- `msedgewebview2` 자식 프로세스는 Job 밖이라 호스트 종료 직후 user-data
  디렉터리를 잠시 잡고 있을 수 있다.
- 최소 Windows 버전·CPU 지원 범위와 다른 플랫폼 완료는 이 결과에 포함하지 않는다.

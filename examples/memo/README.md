# Windows 메모 샘플

현재 Windows 기본 경로는 [Bun FFI 호스트](../../native/windows/bun/README.md)다.
`pwsh -NoProfile -File native/windows/bun/run.ps1`이 같은 메모 앱 정의·화면으로
저장·재실행 복원·렌더러 복구를 실제 검증한다. C++ 빌드 도구는 필요 없다.
새 사용자 앱은 CLI 템플릿의 `windowsApp`에 default export AppDefinition을 지정한다.

실제 `createClient`와 Bun 메인의 `createCore`를 사용하는 앱이다.
`windows` 선언으로 두 창이 하나의 Bun 백엔드를 공유한다. 편집 창(`main` 뷰)의
저장 버튼은 `memo.save`를 호출한다. 백엔드는 Host API로 `appData/notes/memo.txt`에
기록한 뒤 `memo.saved`를 발행하고, 두 창 모두 구독한 `memo.saved`로 화면을 갱신한다.
읽기 전용 창(`reader` 뷰)은 `memo.read`와 `appData/notes` 읽기만 허용되고
`memo.save` 명령이 정책으로 거부된다. 창의 "저장 시도" 버튼으로 그 거부를
직접 확인할 수 있다. 앱 시작·뷰 재생성 시 `memo.read`로 파일을 다시 읽는다.
첫 실행에는 파일이 없어 읽기 실패를 표시하지만 저장 버튼은 사용할 수 있다.

저장소 루트에서 실행한다. 개발 Bun도 고정 버전 1.4.2를 사용한다.

```powershell
pwsh -NoProfile -File native/windows/bun/run.ps1
```

PowerShell 7·고정 Bun·WebView2 Evergreen이 필요하다. 회귀 패키지는
`build/windows-bun-package/`이며 사용자 전역 Bun은 필요 없다.
메모는 `%LOCALAPPDATA%/bunaway/examples.bunaway.memo/data/notes/memo.txt`에 저장된다.
`main` 뷰 정책은 메모 명령·완료 이벤트와 `notes/` 읽기·쓰기만 허용하고,
`reader` 뷰는 읽기만 허용한다.

- `app.ts`: 입력·출력·이벤트 계약과 명령 구현.
- `backend.ts`: Bun 런타임 어댑터 진입점.
- `web/`: SDK·WebView 전송 어댑터를 사용하는 화면.
- `app.json`, `policy.json`: 네이티브 호스트의 창/뷰 선언과 권한.

같은 앱 정의와 화면을 Windows 호스트 통합 테스트에도 번들한다. 테스트 패키지의
별도 명령으로 결과를 수집하며 저장 버튼·완료 이벤트·앱/Bun 재실행·렌더러 장애 후
메모 복원을 검사한다. [실행 결과](../../docs/architecture/windows-host-results.md).

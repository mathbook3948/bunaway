# Windows 메모 샘플

실제 `createClient`와 `runBunApp` 내부의 `createCore`를 사용하는 앱이다.
저장 버튼은 `memo.save`를 호출한다. 백엔드는 Host API로 `appData/notes/memo.txt`에
기록한 뒤 `memo.saved`를 발행하고, 화면은 완료 이벤트로 저장된 내용을 갱신한다.
앱 시작·뷰 재생성 시 `memo.read`로 파일을 다시 읽는다. 첫 실행에는 파일이 없어
읽기 실패를 표시하지만 저장 버튼은 사용할 수 있다.

저장소 루트에서 실행한다. 개발 Bun도 고정 버전 1.4.2를 사용한다.

```powershell
pwsh -NoProfile -File native/windows/host/run.ps1 -Sample -Bun runtime/bun-bundle/vendor/bun-windows-x64-baseline/bun.exe
./build/windows-memo-package/bunaway-host.exe
```

MSVC Build Tools·CMake/Ninja·WebView2 Evergreen이 필요하다. 배포 패키지는
`build/windows-memo-package/`이며 사용자 전역 Bun은 필요 없다.
메모는 `%LOCALAPPDATA%/bunaway/examples.bunaway.memo/data/notes/memo.txt`에 저장된다.
뷰 정책은 메모 명령·완료 이벤트와 `notes/` 읽기·쓰기만 허용한다.

- `app.ts`: 입력·출력·이벤트 계약과 명령 구현.
- `backend.ts`: Bun 런타임 어댑터 진입점.
- `web/`: SDK·WebView 전송 어댑터를 사용하는 화면.
- `app.json`, `policy.json`: 네이티브 호스트 설정과 권한.

같은 앱 정의와 화면을 Windows 호스트 통합 테스트에도 번들한다. 테스트 패키지의
별도 명령으로 결과를 수집하며 저장 버튼·완료 이벤트·앱/Bun 재실행·렌더러 장애 후
메모 복원을 검사한다. [실행 결과](../../docs/architecture/windows-host-results.md).

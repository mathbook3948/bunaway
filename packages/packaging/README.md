# @bunaway/packaging

채널별 패키징 계약과 어댑터 러너. `bunaway build`의 채널 중립 산출물
(`dist/<target>`)을 읽어 채널별 배포물로 포장한다.

- 계약, 검증 규칙: [ADR 0005](../../docs/decisions/0005-packaging-contract.md)
- 단일 소스: `src-bunaway/bunaway.json` v1의 `bundle`
- 진입점: `bunaway package <channel> [directory] [--build]`

채널 어댑터는 `src/channels/<platform>/<channel>.ts`에 두고
`registerAdapter`로 등록한다. 어댑터는 build 산출물을 수정하지 않으며,
서명으로 바뀐 실행 파일은 `packagedSha256`로 기록한다.

입력 검증은 필수 앱 자산, 실행 설정, 플랫폼별 라이선스의 manifest 등재 및 파일 해시를
확인한다. 자산 경로는 상대 경로여야 하며, 입력의 실제 경로가 빌드/패키지 루트 밖으로
벗어나는 symlink/junction도 어댑터 실행 전에 거부한다. Windows 어댑터는 내부 링크도
복사 단계에서 거부하여 서명과 manifest 쓰기가 원본 빌드를 변경하지 않게 한다.
Bun의 최종 해시는 `packagedSha256`이며, 없으면 `executableSha256`을 사용한다.
Windows Bun FFI 패키지는 `runtime/bun.exe`, `launch.ps1`과 manifest에 등재된
부트, 앱, UI 자산을 사용한다. 기존 C++ 호스트 빌드는 현재 CLI로 다시 빌드해야 한다.
서명 단계는 원본 `executableSha256`을 출처 기록으로 유지하고, 서명 후 파일의
`packagedSha256`에 맞춰 배포본 실행기를 갱신한다. 실행기는 Bun을 시작하기 전에
파일 해시를 확인하고 실행 환경을 정리한다.

`ctx.addArtifact(path, kind, { signed, signingRequired })`의 `signingRequired`는 기본 true다.
서명이 필요한 배포물이 모두 서명되어야 `submittable:true`이며, `required-to-run`은
동일한 조건으로 `usable`도 판정한다. 체크리스트 같은 비배포 부가 파일만
`signingRequired:false`로 제외할 수 있다.

## Windows 채널

지원하는 설치 채널은 개발자 자격증명(`signing`)으로 서명한다. 서명이 필요한 채널에서
서명이 없으면 `usable`/`submittable`이 `false`인 진단으로 끝난다.
Inno Setup을 사용하는 `win-direct`와 `win-store-unpackaged`는 6.3 이상이 필요하다.

### `win-direct`: 직접 배포 인스톨러

Inno Setup 스크립트를 생성, 컴파일한다. 앱 바로가기와 설치 후 실행은 시스템
Windows PowerShell로 설치된 `launch.ps1`을 호출한다. 채널 설정:

- `scope`: `perUser`(기본, `%LOCALAPPDATA%\Programs\<identifier>`, 관리자 불필요)
  또는 `perMachine`(`{autopf}`, 관리자 필요).
  새 설치 폴더와 시작 메뉴 그룹은 identifier로 구분하며, 기존 설치의 업데이트는
  이전에 선택한 폴더를 유지한다. 바탕화면 바로가기에도 identifier를 붙인다.
  업데이트는 이름 변경, 설정 변경, 작업 선택 해제로 더 이상 사용하지 않는 앱
  바로가기를 정리하며, 다른 설치를 가리키는 링크와 읽을 수 없는 링크는 유지한다.
- `webView2`: `bootstrap`(기본: 설치 시 런타임이 없으면 Microsoft 공식
  Evergreen 부트스트랩을 무인 실행) 또는 `check`(감지만).
- `desktopShortcut`(기본 false), `startMenuShortcut`(기본 true).
- `uninstall.preserveUserData`(기본 true): 제거해도
  `%LOCALAPPDATA%\bunaway\<appId>`를 지우지 않는다. 업데이트는 상위
  설치(over-install)로 데이터를 유지한다. false는 `perUser`에서만 허용하며,
  `perMachine`과의 조합은 관리자 계정의 데이터를 잘못 삭제하지 않도록 거부한다.

인스톨러는 `x64compatible` 아키텍처에서만 설치할 수 있다.
`targets[].minVersion`을 Inno `MinVersion`으로 전달한다. 기본값은 번들 Bun이 요구하는
Windows 10 1809(`10.0.17763.0`)이며 그보다 오래된 버전은 거부한다.
네 부분 버전의 마지막 값은 0이어야 하며 Inno에는 앞의 세 부분을 전달한다.

WebView2는 레지스트리 `Clients\{F3017226-...}\pv`의 버전이 `0.0.0.0`보다 큰지 확인하고,
없으면 번들된 `MicrosoftEdgeWebview2Setup.exe`를 `/silent /install`로
실행한다(부트스트랩 다운로드가 실패하면 check 모드로 폴백).
부트스트랩 모드에서는 앱 파일 설치 전에 종료 코드와 런타임 존재를 재검사하며,
실행 실패, 설치 실패, 런타임 미검출은 사일런트 설치에서도 실패로 끝난다.

### `win-store-msix`: 현재 차단

Windows Bun FFI 패키지는 MSIX로 생성할 수 없다. 기존 C++ 실행 파일을 대상으로 한
MSIX 실행 설정은 새 구조에 맞지 않으며, Bun 직접 실행은 실행 전 환경 정리와
파일 검증을 우회한다. 안전한 MSIX 실행 경로를 검증하는 후속 작업 전까지
패키징 단계에서 명확한 오류로 거부한다. 일반 설치 파일은 `win-direct` 또는
`win-store-unpackaged`를 사용한다.

### `win-store-unpackaged`: Store EXE/MSI 제출

MSIX와 **다른 업데이트 계약**을 따른다. Store 요구사항에 맞춰:

- standalone 오프라인 인스톨러만 허용: 다운로드 부트스트랩을 쓰지 않는다
  (`webView2`는 `check`만, `bootstrap`은 검증 단계에서 거부).
- 인스톨러와 내부 모든 PE는 신뢰된 루트 CA 체인으로 서명해야 제출 가능.
- 서명 설정이 있으면 payload 전체를 PE 헤더로 검사하여 확장자가 바뀐 실행 파일도
  설치 프로그램 생성 전에 서명, CA 검증한다. 추가 PE는 기존 서명과 자산 해시를 유지하며,
  미서명, 신뢰되지 않은 PE가 있으면 패키징을 중단한다.
- 로컬 Authenticode 신뢰뿐 아니라 Windows의 캐시된 Microsoft AuthRoot CTL에서
  서명 루트의 포함 여부를 검사한다. 개인/테스트 루트나 CTL 검증 실패는 제출 가능
  판정을 거부한다. 오프라인 장비도 유효한 CTL 캐시가 필요하다.
- Inno 컴파일 중 제거 프로그램과 setup 임시 복사본까지 서명, 검증한다.
  비밀번호는 자식 프로세스 환경으로만 전달하며 생성 스크립트에 저장하지 않는다.
- 무인 설치 `/VERYSILENT`를 지원(UAC 허용).
- 버전별 불변 HTTPS URL이 필요: `submission.json`에 체크리스트를 같이 낸다.

Partner Center 제출과 프로덕션 인증서 사용은 자동 테스트 범위에 포함하지 않는다.
MSIX 설치, 앱 실행은 현재 지원하지 않는다.

Windows의 `signing.certificateFile` 상대 경로는 프로젝트 루트를 기준으로 해석한다.
절대 경로는 그대로 사용한다.

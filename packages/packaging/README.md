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
Windows는 `host.kind=bun-compiled`와 `host.executable`에 지정한 앱 EXE,
WebView2Loader.dll 및 라이선스를 요구한다. 웹 자산과 설정은 EXE에 내장된다.
Windows EXE에는 Unix 실행 권한을 요구하지 않는다. macOS 호스트와 번들 Bun은 Unix에서 검사할 때 실행 권한이 필요하다.
서명 단계는 앱 EXE를 서명한 뒤 `host.packagedSha256`을 기록하며 서명한 EXE를 다시 수정하지 않는다.
`host.sha256`과 `bun.executableSha256`은 빌드 및 런타임 출처 기록이다.
이 검사는 빌드에서 패키징으로 전달한 파일을 확인하며, 앱 시작 시 전체 파일 검사는 하지 않는다.
macOS 번들 Bun은 `bun.packagedSha256`이 있으면 사용하고 없으면 `bun.executableSha256`을 사용한다.

`ctx.addArtifact(path, kind, { signed, signingRequired })`의 `signingRequired`는 기본 true다.
서명이 필요한 배포물이 모두 서명되어야 `submittable:true`이며, `required-to-run`은
동일한 조건으로 `usable`도 판정한다. 체크리스트 같은 비배포 부가 파일만
`signingRequired:false`로 제외할 수 있다.

## Windows 채널

지원하는 설치 채널은 개발자 자격증명(`signing`)으로 서명한다. 서명이 필요한 채널에서
서명이 없으면 `usable`/`submittable`이 `false`인 진단으로 끝난다.
Inno Setup을 사용하는 `win-direct`와 `win-store-unpackaged`는 6.3 이상이 필요하다.

### `win-direct`: 직접 배포 인스톨러

Inno Setup 스크립트를 생성, 컴파일한다. 앱 바로가기와 설치 후 실행은
설치된 앱의 GUI 실행 파일을 호출한다. 시작 메뉴, 바탕화면과 제거 화면은 앱 실행 파일의 아이콘을 사용한다. 채널 설정:

- `scope`: `perUser`(기본, `%LOCALAPPDATA%\Programs\<identifier>`, 관리자 불필요)
  또는 `perMachine`(`{autopf}`, 관리자 필요).
  새 설치 폴더와 시작 메뉴 그룹은 identifier로 구분하며, 기존 설치의 업데이트는
  이전에 선택한 폴더를 유지한다. 바탕화면 바로가기에도 identifier를 붙인다.
  관리 범위는 현재 설치 설정으로 정해진 시작 메뉴의 앱 링크와 제거 링크,
  바탕화면의 앱 링크 경로다. 기존 파일이 있으면 삭제하거나 다시 만들지 않는다.
  같은 설치 폴더의 이전 EXE를 가리키는 앱 링크만 실행 대상을 새 EXE로 갱신하고,
  사용자 인자와 작업 디렉터리는 유지한다. 대상이 그대로면 저장하지 않는다.
  아이콘 경로도 이전 EXE와 일치하면 새 EXE로 갱신하고 아이콘 인덱스를 유지한다.
  사용자 지정 아이콘은 변경하지 않는다.
  생성 설정을 끄거나 바탕화면 작업 선택을 해제해도 기존 링크를 삭제하지 않는다.
  제거할 때는 정해진 경로에서 앱 링크의 대상이 해당 설치의 현재 EXE와 일치하는지
  확인한다. 제거 링크도 해당 설치의 제거 프로그램과 일치할 때만 삭제한다.
  검증 실패, 대상 불일치와 읽기 오류가 있으면 링크를 남긴다.
  이름이나 위치가 바뀐 링크는 탐색하지 않는다. 업데이트나 제거 후 남을 수 있으며,
  이전 EXE의 이름이 바뀌면 해당 링크가 작동하지 않을 수 있다.
  정해진 경로에 같은 EXE를 가리키는 복사본을 놓으면 원본과 구분하지 않고 삭제할 수 있다.
  바로가기 경로를 별도로 기록하거나 파일 ID로 추적하지 않으며 AppUserModelID로 관리 대상을 인계하지 않는다.
  모든 생성 링크에 `uninsneveruninstall`을 적용하고 `UninstallLogMode=overwrite`를 유지해
  Inno 자동 삭제와 이전 버전의 제거 기록이 대상 검증을 우회하지 않게 한다.
  `win-direct`와 `win-store-unpackaged`는 각 설치에서 실행 파일명을 Inno 이전 설치 데이터에 기록한다.
  같은 설치 폴더에서 실행 파일명이 바뀌면 바로가기 갱신 후 이전 EXE를 정리한다.
  실행 파일명에 한글 등 Unicode 문자가 있어도 같은 규칙을 적용한다.
  실행 중인 이전 앱도 설치 프로그램의 종료 확인 대상에 포함한다.
  설치 폴더가 바뀌면 이전 EXE를 정리 대상으로 보지 않는다. 실행 파일명이 변경되어도
  실행 파일명이나 설치 경로 기록이 없는 기존 compiled 설치의 이전 EXE는 안전하게 확인할 수 없어
  자동 정리하지 않는다.
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

컴파일된 Windows 앱의 MSIX 활성화와 앱 데이터 경로는 아직 검증하지 않았다. 검증 전까지
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

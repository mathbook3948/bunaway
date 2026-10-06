# @bunaway/packaging

채널별 패키징 계약과 어댑터 러너. `bunaway build`의 채널 중립 산출물
(`dist/<target>`)을 읽어 채널별 배포물로 포장한다.

- 계약·검증 규칙: [ADR 0005](../../docs/decisions/0005-packaging-contract.md)
- 단일 소스: 프로젝트 루트의 `packaging.json`(버전 1)
- 진입점: `bunaway package <channel> [directory] [--build]`

채널 어댑터는 `src/channels/<platform>/<channel>.ts`에 두고
`registerAdapter`로 등록한다. 어댑터는 build 산출물을 수정하지 않으며,
서명으로 바뀐 실행 파일은 `packagedSha256`로 기록한다.

입력 검증은 필수 앱 자산·실행 설정·플랫폼별 라이선스의 manifest 등재 및 파일 해시를
확인한다. 자산 경로는 상대 경로여야 하며, 입력의 실제 경로가 빌드/패키지 루트 밖으로
벗어나는 symlink/junction도 어댑터 실행 전에 거부한다. Windows 어댑터는 내부 링크도
복사 단계에서 거부하여 서명과 manifest 쓰기가 원본 빌드를 변경하지 않게 한다.
Bun의 최종 해시는 `packagedSha256`이며, 없으면 네이티브 호스트와 동일하게
`executableSha256`만 사용한다.

`ctx.addArtifact(path, kind, { signed, signingRequired })`의 `signingRequired`는 기본 true다.
서명이 필요한 배포물이 모두 서명되어야 `submittable:true`이며, `required-to-run`은
동일한 조건으로 `usable`도 판정한다. 체크리스트 같은 비배포 부가 파일만
`signingRequired:false`로 제외할 수 있다.

## Windows 채널

세 채널 모두 개발자 자격증명(`signing`)으로 서명한다. 서명이 필요한 채널에서
서명이 없으면 `usable`/`submittable`이 `false`인 진단으로 끝난다.

### `win-direct` — 직접 배포 인스톨러

Inno Setup 스크립트를 생성·컴파일한다. 채널 설정:

- `scope`: `perUser`(기본, `%LOCALAPPDATA%\Programs\<identifier>`, 관리자 불필요)
  또는 `perMachine`(`{autopf}`, 관리자 필요).
  새 설치 폴더와 시작 메뉴 그룹은 identifier로 구분하며, 기존 설치의 업데이트는
  이전에 선택한 폴더를 유지한다. 바탕화면 바로가기에도 identifier를 붙인다.
- `webView2`: `bootstrap`(기본 — 설치 시 런타임이 없으면 Microsoft 공식
  Evergreen 부트스트랩을 무인 실행) 또는 `check`(감지만).
- `desktopShortcut`(기본 false), `startMenuShortcut`(기본 true).
- `uninstall.preserveUserData`(기본 true): 제거해도
  `%LOCALAPPDATA%\bunaway\<appId>`를 지우지 않는다. 업데이트는 상위
  설치(over-install)로 데이터를 유지한다.

WebView2는 레지스트리 `Clients\{F3017226-...}\pv`의 버전이 `0.0.0.0`보다 큰지 확인하고,
없으면 번들된 `MicrosoftEdgeWebview2Setup.exe`를 `/silent /install`로
실행한다(부트스트랩 다운로드가 실패하면 check 모드로 폴백).

### `win-store-msix` — Microsoft Store MSIX

`AppxManifest.xml`을 생성하고 `makeappx`로 패킹, `signtool`로 서명한다.
`publisher.identity`(예: `CN=...`)와 `icons.windows.square44/square150/
storeLogo`가 필수다. 서명은 **실행에 필수**다(`required-to-run`): 서명 없이는
패키지를 설치할 수 없다. 테스트 인증서는 사용자/머신의 `TrustedPeople` 등에
설치되어 있어야 한다.

Store용 버전은 major가 1 이상이고 `release.build`가 0이어야 한다.
`capabilities`의 일반 기능과 UAP 기능은 각각 기본·`uap` namespace로,
나머지 제한 기능은 `rescap` namespace로 출력한다.

- `unvirtualizedData`(기본 true): `FileSystemWriteVirtualization`을 끄고
  `%LOCALAPPDATA%\bunaway\<appId>`를 제외 디렉터리로 선언해 쓰기 가상화와
  제거 시 데이터 삭제를 막는다. 제한 기능 `unvirtualizedResources`가 필요하며
  **Store 제출 시 Microsoft 승인이 필요**하다. false면 OS 기본 동작(가상화 +
  제거 시 정리)이고, 이 경우 데이터 보존은 보장하지 않는다.
- `maxVersionTested`(기본 `10.0.26100.0`), `capabilities`, `packageName`,
  `minVersion`은 채널 설정으로 바꿀 수 있다.

### `win-store-unpackaged` — Store EXE/MSI 제출

MSIX와 **다른 업데이트 계약**을 따른다. Store 요구사항에 맞춰:

- standalone 오프라인 인스톨러만 허용 — 다운로드 부트스트랩을 쓰지 않는다
  (`webView2`는 `check`만, `bootstrap`은 검증 단계에서 거부).
- 인스톨러와 내부 모든 PE는 신뢰된 루트 CA 체인으로 서명해야 제출 가능.
- Inno 컴파일 중 제거 프로그램과 setup 임시 복사본까지 서명·검증한다.
  비밀번호는 자식 프로세스 환경으로만 전달하며 생성 스크립트에 저장하지 않는다.
- 무인 설치 `/VERYSILENT`를 지원(UAC 허용).
- 버전별 불변 HTTPS URL이 필요 — `submission.json`에 체크리스트를 같이 낸다.

검증 범위: 패키지 생성·서명·사일런트 설치/제거까지 검증했다. Partner Center
제출·프로덕션 인증서·MSIX 인앱 실행은 이 환경에서 검증하지 않았다.

Windows의 `signing.certificateFile` 상대 경로는 프로젝트 루트를 기준으로 해석한다.
절대 경로는 그대로 사용한다.

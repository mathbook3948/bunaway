---
status: accepted
---

# 패키징은 채널별 어댑터가 build 산출물을 소비하고, 서명 후 해시는 별도 필드로 둔다

개발자가 자기 앱을 Windows 직접 배포·Microsoft Store·macOS 직접 배포·Mac App Store로
배포하려면 채널별 패키징이 필요하다. `bunaway build`의 채널 중립 산출물
(`dist/<target>/` + `manifest.json`)을 재사용하면서 채널별 요구사항을 분리하는 계약을
`@bunaway/packaging` 패키지에 둔다.

## 단일 소스와 검증

2026-10-06 생성 앱의 작성 형식은 [통합 설정 v2](./0007-project-settings.md)가 대체한다.
패키징 설정은 `bunaway.json.bundle`에서 읽어 기존 어댑터 입력으로 변환하며, 아래의
v1 `packaging.json`은 기존 앱 호환 형식으로 지원한다. build/package 책임과 산출물
계약은 유지한다.

- 프로젝트 루트의 `packaging.json`(version 1)이 앱 이름·식별자·버전·게시자·아이콘·
  대상 OS/CPU·채널별 설정·서명 참조의 단일 소스다. 앱 ID·버전·제목의 기본값은
  `app.json`/`package.json`에서 가져오며 명시 값이 우선한다.
- `packaging.json`은 없어도 된다. 없으면 `build`·`dev`·`validate`는 그대로 동작하고
  `package`만 사용할 수 없다 — 기존 프로젝트의 마이그레이션은 필요 없다.
- 스키마는 기존 설정 파일들과 같은 규칙을 따른다: 알 수 없는 필드·경로 탈출·형식
  위반을 거부하고, 사용할 채널은 `channels.<id>`에 명시해야 한다(`{}`는 기본값).
- 채널이 스토어의 제약을 강제할 수 있는 범위(예: `win-store-unpackaged`의
  WebView2 `check` 전용 — 오프라인 standalone 요구사항)는 검증 단계에서 거부한다.

## build와 package의 책임 분리

- `bunaway build`는 채널 중립이다. 어댑터는 build 산출물 디렉터리를 읽기 전용으로
  소비하고 스테이징 디렉터리에만 쓴다.
- 어댑터 입력: 산출물 디렉터리·`manifest.json`·`policy.json`·`app.json`·라이선스
  맵·해석된 패키징 메타데이터. runner의 `verify` 단계가 manifest의 자산·Bun 해시로
  입력을 재검증하고 누락/변조는 `PKG_INPUT_MISSING`/`PKG_INPUT_TAMPERED`로 거부한다.
- 자산 맵은 상대 경로와 SHA-256으로 구성된 객체여야 한다. `app.json`·`policy.json`·
  `backend.js`·`bunfig.toml`·`tsconfig.json`, 네이티브 호스트 시작에 필요한
  `process.schema.json`·`message.schema.json`·`host-call.schema.json`·
  `host-operations.json`·`policy.schema.json` 및 Bun·JSON 라이선스는 필수 입력이며,
  Windows는 WebView2 라이선스도 포함한다. 파일뿐 아니라 manifest 등재도 확인한다.
  manifest·호스트는 빌드 산출물 루트, 자산·Bun은 패키지 루트 안의 실제 경로여야 한다.
  외부 symlink/junction 탈출은 `PKG_INPUT_UNEXPECTED`로 어댑터 실행 전에 거부한다.
- macOS는 build가 생성한 XML `Contents/Info.plist`도 필수 입력이다. 번들 안의 정규
  파일이어야 하며, `CFBundleExecutable`이 실제 `Contents/MacOS` 호스트를 가리키고
  `CFBundleIdentifier`가 manifest 앱 ID, `CFBundlePackageType`이 `APPL`이어야 한다.
  XML entity·scalar 값·중첩 array/dict 구조·중복 키·필수 metadata 불일치는 어댑터
  실행 전에 거부하며, macOS에서는 Apple `plutil -lint`로도 전체 문서를 검증한다.
- Bun hello의 런타임 식별에 쓰는 `manifest.bun.version`·`sourceRevision`은 비어 있지
  않은 문자열이어야 한다. `assets/app.json`의 `home`은 호스트 소유 origin을 사용하며,
  URL 경로를 디코딩해 찾은 `assets/web` 내 초기 문서(`/`는 `index.html`)는 실제 파일이고
  manifest에 등재돼 있어야 한다. query는 파일 경로에 포함하지 않으며 웹 루트 밖의
  실제 경로도 거부한다.
- 어댑터는 `resolve → verify → stage → sign → assemble → verify-artifact → report`
  순서의 stage 목록을 정의하고, runner가 단계별 실행·타이밍·실패 포착을 담당한다.
- 진단은 `{stage, code: PKG_*, severity, message, path?}` 형식으로 통일하고 결과는
  `dist/<target>/packaged/<channel>/`과 `packaging-report.<channel>.json`에 남긴다.
  실패한 실행은 직전 정상 산출물을 덮지 않는다(스테이징→원자적 rename).
- staging의 링크는 상대 경로로 내부 파일/디렉터리를 가리켜야 한다. 절대 symlink와
  Windows junction은 게시 후에도 이전 staging을 가리키므로 `PKG_VERIFY_FAILED`로
  거부한다. 등록한 산출물뿐 아니라 부가 파일의 링크도 검사하며, 상대 링크의 외부 탈출과
  끊어진 링크도 거부한다. 기존 Windows 출력의 junction을 재빌드 시 이동 보존하는
  규칙은 유지한다.
- 쓰기·이동·삭제를 소유하는 `dist`·`.bunaway`·타깃·`packaged`·잠금 디렉터리는
  프로젝트 루트 아래의 모든 디렉터리 구성 요소가 실제 디렉터리여야 한다. 내부/외부
  symlink·junction으로 바뀐 루트나 상위 경로는 생성·보존 이동·게시·복구·정리 전에
  공통 검사로 거부한다. 보존할 채널 루트/리포트도 정규 디렉터리/파일이어야 하며,
  정상 패키지 내부 junction의 이동 보존과 읽기 전용 입력의 내부 링크 허용은 유지한다.
  리포트 임시 파일은 기존 링크를 해제한 뒤 exclusive-create로 작성해 링크 대상의
  바이트를 덮어쓰지 않는다. 공개 runner/잠금 진입점도 채널·타깃 이름을 검증한다.
- 리포트도 임시 파일을 원자적 rename하여 저장한다. 성공 리포트 게시 전까지 이전
  산출물 백업을 유지하고 리포트 게시 실패 시 산출물을 복구한다. 실패 리포트를
  저장할 수 없는 경우에도 기존 리포트를 훼손하지 않고 실패 진단을 호출자에게 반환한다.
- runner는 채널별 `<channel>.lock` 파일을 exclusive-create하여 실행·게시·rollback·
  리포트 저장·정리 전체를 프로세스 간 상호 배제한다. 다른 채널은 독립 실행할 수 있다.
  잠금 획득 실패는 `PKG_LOCK_FAILED`로 호출자에게 실패 리포트만 반환하며, 실행 중인
  채널의 디스크 리포트나 출력은 건드리지 않는다. 잠금은 정상 종료·실패 시 해제된다. 프로세스 강제 종료로
  남은 잠금은 자동 탈취하지 않으며, 실행 중인 작업이 없음을 확인한 뒤 수동 삭제한다.
- build 교체와 runner는 교체되는 산출물 밖의 `dist/.bunaway-locks/<target>/`에서
  동기화한다. runner는 manifest 읽기 전부터 정리 완료까지 공유 reader 잠금을 유지하고,
  build는 보존 이동·교체·rollback 전체에 `build.lock` 배타 잠금을 유지한다. 경합 시
  상대 작업의 출력/리포트를 건드리지 않고 실패한다. 다른 채널 reader는 병렬 실행할 수
  있다. Windows는 완성된 채널 디렉터리와 리포트만 staging으로 이동하고 lock/staging/backup은
  제외한다. junction을 재생성하지 않아 symlink 생성 권한이 필요 없으며, 빌드 게시 실패 시
  이동한 항목을 이전 빌드로 복구한다. 강제 종료로 남은 타깃 잠금도 활성 작업이 없음을
  확인한 뒤 수동 삭제한다.
- 어댑터는 registry에 자기 채널을 등록한다. 새 채널은 `src/channels/<platform>/`
  아래 파일만 추가하며 공통 진입점을 수정하지 않는다.

## 서명과 해시 규칙

서명은 어댑터의 선택적 단계로 분리하고 자격증명은 개발자가 제공한다(인증서 파일·
thumbprint·비밀번호 env 이름만 저장소에 참조). 채널은 `signingRequirement`로
`optional`/`required-to-run`/`required-to-submit`을 선언한다. 배포물 중 하나라도 미서명이면
`submittable:false`이며, 실행에 서명이 필요한 채널에서는 `usable:false`다.
`addArtifact`의 `signingRequired`는 기본값이 true다. 체크섬 같은 비배포 부가 파일만
false로 제외할 수 있고, 설치 패키지·실행 파일·제출 번들은 제외할 수 없다.
서명 대상 배포물이 하나 이상 있어야 하며, 그 모두가 서명되어야 실행/제출 요건을
충족한다. `signing.performed`는 서명된 파일이 있는지를 기록할 뿐 이 판정을 대체하지 않는다.

서명으로 바이너리가 바뀌는 채널을 위해 manifest의 해시를 둘로 나눈다.
Bun은 upstream의 `executableSha256`을 보존하고, 서명 후 최종 바이트는
`packagedSha256`에 기록한다. 패키징 검증과 Windows/macOS 런타임 무결성 검사는
Bun의 `packagedSha256`을 우선 읽고 없으면 `executableSha256`만 사용한다.
Bun의 `sha256`/`sourceSha256`은 이 fallback을 대체하지 않는다.
호스트의 `sha256`/`sourceSha256`은 별도 규칙이며, macOS 서명 전 호스트의
`sourceSha256`은 provenance이므로 최종 호스트 바이트와 직접 비교하지 않는다.
최종 호스트 해시(`packagedSha256`/`sha256`)가 없는 macOS build 입력은 기존 번들의
코드 서명을 `codesign --verify --deep --strict`로 검증한다. 정상 ad-hoc 서명도 허용하되
호스트·봉인 자산·서명 손상과 검증 도구 실행 실패는 `PKG_INPUT_TAMPERED`로 어댑터 실행
전에 거부한다. macOS 외 OS에서 최종 호스트 해시도 검증할 수 없으면
`PKG_INPUT_MISSING`으로 거부한다. 이 검사는 빌드 입력 무결성 확인이며 Developer ID·
공증·스토어 제출 가능 여부를 보증하거나 어댑터의 배포 서명을 대신하지 않는다.

## 검토한 대안

- `build` 명령에 채널 플래그를 추가하는 방식은 채널 중립 산출물 재사용을 깨고
  빌드-패키징 책임을 섞어 채택하지 않았다.
- 채널별 manifest를 산출물마다 두는 방식은 단일 소스·검증 규칙이 갈라져 채택하지
  않았다.

근거: [PRD](../PRD.md), [패키지 구현](../../packages/packaging/), [Windows 호스트
](../../native/windows/host/host.cpp).

# CLI · vanilla MVP

기존 SDK/정책/Host API와 네이티브 호스트를 그대로 사용한다. 패키지 런타임은
고정 Bun 1.4.2이며 개발/빌드에도 같은 버전이 필요하다. 공개 npm 배포는 아직 없다.

## 생성 → 개발 → 빌드 → 독립 실행

저장소 체크아웃 없는 설치, SDK/native artifact 구성·버전 규칙·전체 snapshot 업그레이드는
[개발자 설치 안내](../../docs/framework-distribution.md)를 따른다. 로컬 tarball에는 CLI
bin/API JS 번들과 모든 생성 입력이 포함된다. 공개 registry publish는 하지 않는다.
아래는 프레임워크 저장소 기여자용 직접 소스 실행 경로다.

저장소에서 `bun install` 후 실행한다. Windows에서 전역 Bun이 없으면
`runtime/bun-bundle/vendor/bun-windows-x64-baseline/bun.exe`로 아래 `bun`을 대체한다.

```sh
bun packages/cli/src/main.ts create ../my-app
cd ../my-app
bun install
bun run doctor
bun run validate
bun run dev
# 개발 실행 종료 후:
bun run build
```

`create`는 기존 경로를 덮어쓰지 않는다. 설치를 자동 실행하지 않으며 마지막에 다음
단계를 안내한다. 생성 프로젝트는 SDK·CLI·네이티브 소스·스키마·핀의 **로컬 스냅샷**을
포함한다. 생성 후 원본 저장소를 삭제하거나 프로젝트를 이동해도 동작한다.
SDK 의존성은 workspace 이름으로 연결하며 메모 샘플/원본 저장소 경로를 사용하지 않는다.
개발 도구 설치에는 Bun 패키지 레지스트리, 최초 네이티브 빌드에는 고정 런타임/헤더/SDK
다운로드 접근이 필요하다. 앱 실행에는 네트워크나 Bun 설치가 필요 없다.

명령은 `create <new-directory>`와 `dev|validate|build|doctor [directory]`,
`package <channel> [directory] [--build]`다.
옵션/알 수 없는 명령·설정 필드는 오류로 종료한다. `validate`는 버전·앱 ID·소스 경로·홈
자산·단일 뷰/정확한 origin·기존 정책 스키마를 검사한다. `package`는
`packaging.json`(없으면 거부, `validate`는 유무와 무관하게 형식만 검사)을 읽어
`bunaway build`의 채널 중립 산출물을 채널별 패키지로 조립한다. 산출물은
`dist/<target>/packaged/<channel>/`, 결과는 `packaging-report.<channel>.json`에
기록한다. `--build`는 패키징 전에 빌드를 먼저 실행한다. 채널·어댑터 계약·서명/해시
규칙은 `@bunaway/packaging`과 `docs/decisions/0005-packaging-contract.md`에 있다.
권한의 실제 집행은 호스트/코어의 기존 계약을 따른다. 백엔드를 실행해 명령 목록을
추측하거나 자동으로 권한을 추가하지 않는다.

## 생성 구조

```text
my-app/
  package.json, bunaway.json, app.json, policy.json, tsconfig.json
  src/backend/{app.ts,index.ts}
  src/web/{index.html,main.ts,style.css}
  vendor/bunaway/
    packages/{cli,backend-sdk,client-sdk,core,protocol,runtime-bun}/
    native/{windows/host,macos/host,host-api/generated}/
    runtime/build-manifests/, tsconfig.base.json, package.json
  bunaway.lock.json
```

`bunaway.json` v1의 `backend`(파일)와 `frontend`(디렉터리)는 프로젝트 상대 경로다.
프런트엔드의 `.ts`/`.js`는 브라우저 번들로 변환하고 나머지 정적 자산은 복사한다.
`.d.ts`는 배포하지 않는다. CSS 등 번들의 추가 출력까지 정적 자산과 대조해 기록 전에
충돌을 거부한다. 출력 이름은 Windows/macOS 이식성을 위해 대소문자를 구분하지 않고
비교하며 자산 심볼릭 링크도 거부한다.
vanilla MVP는 양쪽 호스트가 공통으로 지원하는 단일 뷰 `app.json` 형식과
`https://app.bunaway.local`의 호스트 소유 로컬 자산만 사용한다. Windows는 가상 호스트,
macOS는 기존 `bunaway://` 매핑이다. HTTP 개발 origin은 여기서 허용하지 않는다.

템플릿은 실제 `createClient`/`command`/`runBunApp`을 사용한다.
`message.save` → 호출 컨텍스트의 Host API `storage.writeText` →
`appData/messages/current.txt` → `message.saved` → UI 갱신이다.
`message.read`로 시작/재실행 시 복원한다. 첫 실행의 파일 없음은 UI에 표시한다.
정책은 `main` 뷰의 두 명령·한 이벤트와 `messages/` 읽기/쓰기만 허용하며
백엔드 자체 작업에는 저장 권한을 주지 않는다.

## 개발 수명주기

프로젝트 소스·설정 변경을 debounce 후 직렬 처리한다(의존성/출력 디렉터리는 제외).
프런트엔드 변경도 **전체 네이티브 호스트/창 재시작**으로 갱신한다. HMR은 후속 범위다.
이전 호스트 종료를 확인한 후 자산을 다시 빌드하고 새 호스트를 시작한다.
호스트가 새 런타임 세대와 새 호출 컨텍스트/세션을 발급한다. 기존 네이티브 Job/guard가
Bun 자식을 정리한다. SDK는 세션 종료 시 미완료 요청/구독을 폐기하며 CLI는 요청을
보관하거나 재전송하지 않는다. 이미 완료된 외부 저장 작업은 롤백하지 않는다.
개발 중 입력하지 않은 UI 상태도 재시작으로 사라지므로 저장 후 확인한다.

빌드 실패 시 이전 프로덕션 산출물을 유지한다. 개발 빌드 실패 시 이전 앱을 다시 띄우지
않고 오류를 출력하며 다음 변경을 기다린다. 빌드 도중 추가 변경은 오래된 결과의 시작을
건너뛰고 최신 소스로 다시 빌드한다. 창을 닫거나 Ctrl+C로 개발 실행을 종료한다.

## 패키지 / 배포 조사용 경계

Windows x64에는 PowerShell 7, MSVC C++ Build Tools, CMake/Ninja와
WebView2 Evergreen이 필요하다. 네이티브 SDK는 기존 스크립트의 핀으로 받는다.
macOS arm64에는 macOS 14+, Xcode CLT, zsh/codesign이 필요하다. 교차 빌드는 없다.

```text
dist/windows-x64/
  bunaway-host.exe
  assets/{web/,backend.js,app.json,policy.json,bunfig.toml,tsconfig.json,*schema.json,host-operations.json}
  runtime/bun.exe
  licenses/{LICENSE.bun,LICENSE.nlohmann-json,License-WebView2.txt}
  manifest.json

dist/macos-arm64/<appId>.app/Contents/
  MacOS/bunaway-host
  Resources/{assets/,runtime/bun,licenses/,manifest.json}
  Info.plist
```

개발 패키지는 동일한 구조로 `.bunaway/<target>/` 아래 생성한다.
호스트 실행 인자는 양쪽 모두 `--package <절대 패키지 경로>`다. macOS 인자의 패키지
경로는 `.app/Contents/Resources`다. Windows는 인자 없이 실행 파일 옆에서,
macOS는 Finder/.app 실행 시 NSBundle Resources에서 패키지를 찾는다.

```powershell
# 다른 cwd에서도, PATH에 Bun이 없어도 실행:
& 'C:\path\my-app\dist\windows-x64\bunaway-host.exe'
```

```sh
open dist/macos-arm64/app.my-app.app
# 또는 명시적 리소스 루트:
dist/macos-arm64/app.my-app.app/Contents/MacOS/bunaway-host --package "$PWD/dist/macos-arm64/app.my-app.app/Contents/Resources"
```

manifest에는 앱/프레임워크 버전, 호스트 target/해시, Bun 버전·소스 revision·다운로드/실행
해시·라이선스 출처/해시와 전체 자산/라이선스 해시를 기록한다. 호스트는 실행 전에
Bun/자산 해시를 검사하고 내부 Bun **절대 경로**를 실행한다. 누락/변조 시 실패하며
전역 Bun fallback은 없다. 사용자 환경·`.env`·preload·자동 의존성 설치를 차단하는
기존 자식 실행 설정을 유지한다. 해시는 무결성 검사이며 서명된 신뢰의 증명은 아니다.

macOS 패키지에는 로컬 실행용 ad-hoc 서명만 적용하며 번들 Bun을 재서명하지 않는다.
manifest의 macOS `host.sourceSha256`은 서명 전 원본 호스트 해시다(서명된 실행 파일을
자신의 서명 대상 manifest에 해싱하는 순환을 피한다). Windows `host.sha256`은 패키지 호스트 해시다.
설치 프로그램, Developer ID 서명,
공증, React/Vue/Svelte, 공개 플러그인 API, 공개 registry publish/라이선스 결정은 후속 범위다.
공통 네이티브 스크립트에 추가한 `-BuildHostOnly`/`--host-only`는 고정 의존성 검증과 호스트
컴파일까지만 실행해 CLI가 테스트/메모 자산 없이 앱 자산을 직접 조립하도록 한다.
기존 샘플/계약 테스트 경로와 기본 빌드 동작은 유지한다.

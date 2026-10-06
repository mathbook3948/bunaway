# 개발자용 프레임워크 설치·버전 관리

bunaway는 개발자가 웹 UI와 TypeScript/Bun 백엔드로 자기 네이티브 앱을 만드는
프레임워크다. Electron/Capacitor를 의존성으로 사용하지 않는다.
프레임워크 **설치 artifact**와 최종 사용자의 **앱 패키지**는 별개다.
이 문서는 로컬 artifact 검증 경로다. registry publish는 하지 않았으며,
패키지 이름의 registry 소유권이나 공개 설치 가능성을 보장하지 않는다.

## 저장소 체크아웃 없이 설치

관리자가 전달한 `bunaway-cli-<version>.tgz`와 개발용 Bun **1.4.2**를 사용한다.
아래 작업 디렉터리는 bunaway 저장소 밖에 두어도 된다. tarball 경로는 절대 경로를
사용한다(Windows에서도 공백이 있는 경로를 따옴표로 감싼다).

```sh
mkdir bunaway-tools
cd bunaway-tools
bun init -y
bun add --exact /absolute/path/bunaway-cli-0.0.0.tgz
bun run bunaway --version
bun run bunaway create ../my-app
cd ../my-app
bun install
bun run validate
bun run doctor
bun run dev
# 개발 실행을 종료한 뒤
bun run build
```

CLI를 전역 설치할 필요는 없다. 설치 artifact의 bin은 Bun용 JS 번들이며 Node.js용
실행 파일이 아니다. 개발용 Bun은 별도 설치한다. 설치 script나 자동 publish는 없다.
생성 후 `bunaway-tools`와 tarball은 삭제할 수 있다. `my-app`을 다른 경로/머신으로
이동한 뒤 `bun install`하면 원본 저장소나 설치 CLI 없이 동작한다. Bun 1.4.2를 가진
개발 머신이라면 생성·검증은 가능하며, 네이티브 dev/build는 아래 두 타깃만 지원한다.

`package.json`, `bun.lock`, `bunaway.lock.json`, `vendor/bunaway`를 앱 저장소에 함께
커밋한다. `node_modules`, 네이티브 다운로드 캐시, `.bunaway`, `dist`는 제외한다.
첫 설치 뒤 재현 설치에는 `bun install --frozen-lockfile`을 쓴다.
생성된 `.gitattributes`도 함께 커밋한다. `vendor/bunaway/** -text`는 Git의
줄바꿈 변환을 막아 Windows/macOS checkout에서도 snapshot과 upstream 라이선스의
원본 바이트 및 잠금 해시를 보존한다.

## Artifact 구성과 SDK 설치 방식

배포 단위는 `@bunaway/cli` 로컬 tarball 하나다. 외부 runtime dependency가 없는 CLI
bin/API 번들과 아래 소스 payload를 함께 포함한다.
CLI API의 `types` export는 생성된 선언 트리를 가리킨다. 내부 `@bunaway/*`
타입 참조도 artifact 안의 상대 경로로 연결하므로 별도 SDK registry 패키지 없이
strict TypeScript에서 `@bunaway/cli`를 import할 수 있다.

| 입력 | 포함 내용 |
| --- | --- |
| CLI/SDK | CLI, backend/client SDK, core, protocol, runtime-bun, packaging의 소스·package.json·타입 설정 |
| 템플릿 | 실제 SDK를 쓰는 vanilla UI/백엔드·정책·설정·gitignore |
| 네이티브 | Windows Bun FFI TypeScript·prepare/launch.ps1·WebView2 deps.json, macOS main.mm·run.sh |
| 계약 | 생성된 Web/IPC/정책/Host API/bootstrap 스키마와 host-operations.json |
| 런타임 핀 | Windows/macOS Bun의 버전·소스 revision·URL·archive/executable/license SHA-256 |
| 버전·고지 | framework.json, artifact.files.json, FRAMEWORK-LICENSE.txt, THIRD-PARTY-NOTICES.txt, 세 upstream 라이선스 원문 |

큰 Bun 실행 파일·네이티브 헤더/SDK·컴파일러는 이 tarball에 넣지 않는다. 기존
네이티브 스크립트가 최초 빌드에 핀을 다운로드하고 해시를 검사한다. 따라서 첫 빌드는
완전 offline이 아니다. 최종 앱은 고정 Bun과 자산·라이선스를 포함하므로 Bun 설치나
개발 의존성 다운로드가 필요 없다. 캐시는 실행한 CLI의 프레임워크 트리에 기록한다.
생성 앱의 CLI는 `vendor/bunaway`, 설치 artifact의 bin/API는 설치 패키지 안에
캐시를 만든다. Artifact 감사는 지정된 `build/`, runtime vendor 및 플랫폼별 native
vendor 캐시만 제외하며, 소스·계약·라이선스와 다른 추가 파일은 계속 검사한다.

SDK를 독립 registry 패키지로 설치하지 않고 tarball의 소스를 `vendor/bunaway`에
복사해 `workspace:*`로 연결한다. 이유와 비용은 [ADR 0005](./decisions/0005-framework-artifact.md)에
기록했다. `package.json`의 `private: true`와 `license: UNLICENSED`는 의도적이다.
소유자의 프레임워크/템플릿 라이선스 결정 전에는 공개 배포를 하지 않는다. upstream
라이선스는 bunaway의 라이선스를 대신하지 않으며 npm tarball 검증도 사용권 부여가 아니다.

## 호환 규칙

| 버전 | 규칙 |
| --- | --- |
| 프레임워크/CLI/SDK/core/runtime-bun | framework.json의 동일한 정확한 릴리스 버전. 범위·caret·다른 registry SDK 혼합은 거부 |
| 네이티브 호스트 | 동일 릴리스 소스와 생성 스키마로 빌드. 잠금 파일의 소스 해시로 부분 교체/변조를 거부 |
| Web 프로토콜 | 현재 1.0. 기존 hello의 major 거부/minor 협상 규칙은 유지 |
| 프로세스 IPC | 별도의 현재 1.0. Web 버전과 독립 관리 |
| 설치 조합 | 릴리스가 명시한 Web/IPC 버전과 정확히 같아야 함. wire 협상이 가능하더라도 임의 교차 릴리스 조합은 지원하지 않음 |
| 개발/번들 Bun | 현재 1.4.2. 두 타깃 핀과 개발용 Bun 버전 일치. final 앱은 내부 실행 파일의 절대 경로·해시만 사용 |

`validate`, `doctor`, `dev`, `build`는 SDK 메타데이터,
핀, vendor 소스/스키마/고지 해시와 앱의 workspace 선언을 확인한다.
잠금에 없는 snapshot 파일도 거부한다. 위에서 지정한 네이티브 build/vendor 캐시와
Bun이 생성하는 각 framework workspace의 node_modules만 제외한다. 앱의
dependencies/devDependencies/optionalDependencies/peerDependencies 모두에서
`@bunaway/*`는 `workspace:*`여야 하며, 외부 SDK로 덮어쓰는 선언은 거부한다.
`overrides`/`resolutions`에서 `@bunaway/*`를 대상으로 하는 선택자도 거부한다
(중첩·버전·경로 선택자 포함). 앱 루트·백엔드·프런트엔드 및 프레임워크 패키지에서
실제로 해석되는 SDK 진입점은 잠긴 vendor 소스와 같은 실제 경로여야 한다.
백엔드와 모든 프런트엔드 진입점을 메모리에서 번들해 실제 import 그래프도 검사한다.
하위 모듈이나 소스 루트 밖에서 import한 모듈의 `tsconfig.json` 경로 별칭도 포함하며,
일반 의존성·로컬 별칭과 잠긴 SDK 소스를 가리키는 별칭은 허용한다. 따라서 검증에는
번들 가능한 앱 소스가 필요하다. 검증과 자산 번들은 각각 새 Bun 프로세스에서 같은
SDK 검사 플러그인을 사용한다. 설치를 복원한 뒤 장기 실행 dev/API 프로세스에 남은
외부 SDK 해석 캐시는 다음 번들에 사용하지 않는다.
선언만 복원하고 외부 SDK 설치를 남겨 두거나 경로 별칭으로 바꾸는 경우도 실패하며,
선언을 수정한 뒤 `bun install`로 vendor workspace 연결을 복원해야 한다. `bunaway.lock.json`
없음(이전 생성 프로젝트), 다른 버전, 부분 변경은 명시적으로 오류가 된다. 전역 CLI가
다른 릴리스라면 프로젝트의 `bun run ...`을 사용하거나 전체 업그레이드를 해야 한다.
잠금 파일은 무결성과 조합 기록이지 서명된 신뢰 증명이나 공격자 방어 경계는 아니다.

현재 `0.0.0`은 기존 코드 버전을 유지한 로컬 개발 artifact다. 공개 릴리스는 같은
버전을 재사용하지 않는다. SemVer를 사용하고 breaking SDK/host 변화는 major(0.x에서는
minor)를 올린다. 호환 수정은 patch, 새 호환 기능은 minor를 올리되 전체 릴리스 검증을
수행한다. wire 버전 변경은 SDK 버전과 별도로 스키마·양쪽 협상/검증기를 갱신한다.

## 앱 업그레이드 (기존 vendor 프로젝트 포함)

현재 자동 in-place 마이그레이션은 제공하지 않는다. 앱 코드·권한을 CLI가 임의로
수정하지 않도록 새 artifact의 **전체 snapshot 교체**를 명시적인 절차로 제공한다.

1. 앱 실행/dev를 종료하고 현재 앱 저장소를 커밋하거나 백업한다. vendor를 수정했다면
   먼저 diff를 분리한다. 새 버전에 필요한 수정은 framework 소스에서 검증해 새 artifact로
   만들어야 하며, 잠금 파일의 해시를 임의로 재작성해 검증을 우회하지 않는다.
2. 별도 도구 디렉터리에 새 tarball을 `bun add --exact <절대 경로>`로 설치하고
   `bun run bunaway create ../upgrade-reference`로 임시 프로젝트를 만든다.
3. 원래 앱의 `vendor/bunaway`와 `bunaway.lock.json`을 백업한 뒤 임시 프로젝트의 두
   항목으로 **함께** 교체한다. 일부 SDK/네이티브/스키마만 복사하지 않는다. 이전 PR #11
   생성 프로젝트도 이 단계에서 처음 잠금 파일을 받는다.
4. 임시 프로젝트 package.json과 비교해 원래 앱의 `packageManager`, `engines.bun`,
   workspace 경로, `@bunaway/*`의 `workspace:*`, TypeScript/@types/bun 핀과 CLI script를
   맞춘다. 자신의 앱 이름·버전·의존성은 보존한다. Bun 핀이 변경됐다면 개발용 Bun도
   먼저 맞춘다. 릴리스의 breaking-change 안내에 따라 앱 코드를 직접 마이그레이션한다.
   기존 `.gitattributes`에도 임시 프로젝트의 `vendor/bunaway/** -text` 규칙을
   반영하여 snapshot 줄바꿈 변환을 막는다. 이미 추적 중인 파일은
   `git add --renormalize vendor/bunaway`로 새 snapshot의 원본 바이트를 index에 기록한다.
5. 원래 앱에서 `bun install`로 앱 bun.lock을 갱신하고 `bun run validate`,
   `bun run typecheck`, `bun run doctor`, `bun run build`를 실행한다. 앱 테스트·기능
   회귀도 확인한다. `src`, `src-bunaway`와 사용자 데이터는 자동 교체하지 않는다.
   앱 설정은 `src-bunaway/bunaway.json` v1의 `build`, `app`, `bundle`과
   `src-bunaway/policy.json`을 사용한다. [설정 작성 형식](./decisions/0007-project-settings.md)을
   따르고 소스 경로는 프로젝트 루트 기준으로 지정한다.
6. 실패하면 백업 vendor/잠금 파일/package.json/bun.lock과 이전 개발용 Bun을 함께
   복원하고 재설치한다. 성공한 앱 소스와 두 잠금 파일을 함께 커밋하고 임시 프로젝트를
   삭제한다. 사용자 데이터 마이그레이션은 앱 개발자의 별도 책임이다.

## 개발 머신과 최종 사용자 요구사항

| 대상 | 개발/create/validate | 네이티브 dev/build | 최종 앱 실행 |
| --- | --- | --- | --- |
| Windows x64 | Bun 1.4.2, 개발 의존성 설치 접근 | PowerShell 7, 공식 WebView2 Loader 핀 다운로드, Evergreen 실행 런타임. C++ 빌드 도구 불필요 | 지원 OS/CPU와 WebView2 Evergreen. 전역 Bun·Node·TypeScript·컴파일러·SDK 불필요 |
| macOS arm64 | Bun 1.4.2, 개발 의존성 설치 접근 | macOS 14+, Xcode CLT(Apple SDK·clang++), zsh·python3·curl·ditto·codesign | 지원 macOS/CPU와 OS WebKit. Bun·Node·Xcode 불필요 |

현재 검증 머신과 정식 최소 OS 지원은 [플랫폼 표](./platform-support/README.md)를
구분해서 읽는다. 교차 컴파일, Intel macOS, Linux/모바일 네이티브 빌드는 지원하지 않는다.
서명·공증·설치 프로그램·Store 제출은 앱 패키징 채널의 별도 책임이다.
macOS build의 ad-hoc 서명을 공개 배포 준비 완료로 표시하지 않는다.
앱 패키지의 Bun이 누락/변조되면 실행을 거부한다. PATH의 Bun으로 fallback하지 않는다.

## 관리자용 pack·누락 검사

저장소 관리자는 고정 Bun으로 실행한다. SDK/native/protocol 버전 변경 시 root와 여섯
패키지의 version, framework.json을 함께 변경하고, Bun 변경은 packageManager/engines,
mise, 템플릿과 두 runtime pin 및 upstream 라이선스 파일을 함께 갱신한다.

```sh
bun install --frozen-lockfile
bun run framework:pack
mkdir extracted
tar -xzf build/framework/bunaway-cli-0.0.0.tgz -C extracted
bun run framework:check extracted/package
bun test tests/cli/distribution.test.ts
# 실제 네이티브 개발 도구가 설치된 Windows x64/macOS arm64에서:
BUNAWAY_NATIVE_DISTRIBUTION_TEST=1 bun test tests/cli/distribution.test.ts
```

Windows PowerShell은 마지막 명령 전에 `$env:BUNAWAY_NATIVE_DISTRIBUTION_TEST = '1'`을
설정한다. 테스트는 **실제 tarball만** 외부 디렉터리에 설치해 등록 bin으로 생성하고,
설치 도구·artifact를 삭제한 뒤 앱을 이동하여 install/validate/typecheck를 수행한다.
옵션은 doctor와 기존 native build를 추가한다. schema 누락(재작성 inventory 포함),
SDK/host/Web/IPC 버전 혼합과 vendor 변조도 거부하는지 검사한다. 공개 publish나
자격증명은 필요 없다. 새 테스트는 기존 공통 CI의 `bun test ./tests`에 포함되지만
옵션 native artifact build가 기존 native CI와 동일하다고 주장하지 않는다.
strict TypeScript 소비자의 Bundler/NodeNext 해석과 잘못된 API 인자의 거부,
Git의 `core.autocrlf=false/true` checkout 후 snapshot 해시 및 frozen install도 검사한다.

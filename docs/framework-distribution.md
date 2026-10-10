# 개발자용 프레임워크 설치, 버전 관리

bunaway는 앱의 package.json과 bun.lock으로 설치하는 개발 의존성이다.
SDK, CLI, 네이티브 빌드 도구를 node_modules에서 찾으며 생성 앱에
vendor/bunaway나 bunaway.lock.json을 만들지 않는다.
최종 사용자의 앱 패키지는 별개이며 번들 Bun으로 실행한다.
공개 registry publish와 프레임워크 라이선스 결정은 아직 하지 않았다.

## 로컬 패키지 묶음으로 시작하기

프레임워크 관리자는 저장소에서 다음 명령으로 같은 버전의 CLI, SDK tarball을 만든다.

```sh
bun run framework:pack --local
```

build/framework/에 bunaway-cli, backend, client, plugin, plugin-api, core, protocol, runtime-bun,
packaging 패키지와 plugin-storage, plugin-log, plugin-capabilities, plugin-windows의 개별 tarball이 생성된다. --local은 서로의 의존성을 이 디렉터리의
절대 tarball 경로로 연결한다. 이는 공개 registry가 없는 동안의 로컬 설치 경로다.
파일을 다른 디렉터리/머신에 옮겼다면 그 위치에서 로컬 묶음을 다시 생성해야 한다.
--local 없이 만들면 패키지 간 의존성은 정확한 릴리스 버전이며 공개 publish는 하지 않는다.

전달받은 로컬 묶음이 있는 개발 머신에서, bunaway 저장소 밖에서도 실행할 수 있다.
Bun은 개발용으로 별도 설치하고 버전 **1.4.2**를 사용한다.

```sh
mkdir bunaway-tools
cd bunaway-tools
bun init -y
bun add --exact /absolute/path/build/framework/bunaway-cli-0.0.0.tgz
bun run bunaway create ../my-app --package-dir /absolute/path/build/framework
cd ../my-app
bun install
bun run validate
bun run typecheck
bun run doctor
bun run dev
# 개발 실행 종료 후:
bun run build
```

create는 설치를 자동 실행하지 않으며 기존 경로를 덮어쓰지 않는다.
--package-dir은 생성 앱의 프레임워크 의존성을 해당 디렉터리의 tarball로 지정한다.
이 옵션을 생략하면 정확한 registry 버전으로 선언하지만 현재 공개 설치는 제공하지 않는다.
생성 후 bunaway-tools 폴더는 삭제해도 된다. 앱은 자기 node_modules의 CLI를 사용한다.
로컬 tarball 묶음은 나중의 깨끗한 재설치를 위해 보관해야 한다. 공개 registry가 생기면
같은 버전의 패키지를 registry에서 설치하고 bun.lock으로 재현할 수 있다.

## 설치 구성

개별 네이티브 패키지는 필요할 때 설치하고 AppDefinition.plugins에 등록한다.
CLI는 직접 설치한 플러그인의 manifest와 SDK peer 버전, 패키지 내부 경로를 검사한다.
dependencies, devDependencies, optionalDependencies와 peerDependencies에 선언한 설치 플러그인을 모두 찾는다.
설치하지 않은 optionalDependencies와 optional로 표시한 peerDependencies는 건너뛴다.
필수 의존성의 누락이나 설치된 플러그인의 잘못된 설정은 오류로 처리한다.
공식 `@bunaway/` 플러그인은 프레임워크와 같은 버전을 사용한다. 외부 플러그인은 자체 버전을 유지하며 SDK peer 버전만 정확히 맞춘다.
화면과 백엔드는 같은 플러그인 패키지를 import한다. 생성 앱의 typecheck는
tsconfig.json의 browser 조건과 src-bunaway/tsconfig.json의 bun 조건을 각각 검사한다.
[ADR 0013](./decisions/0013-optional-native-plugins.md)와 [계약](./architecture/plugins.md)을 참고한다.

- @bunaway/client: 화면에서 `invoke`, `listen`를 사용하는 WebView 클라이언트 SDK.
  [기본 연결과 타입 추론](./architecture/common-api.md#클라이언트와-transport)을 참고한다.
- @bunaway/plugin: 네이티브 플러그인의 선언, 공개 호출 함수와 플랫폼 구현 타입
- @bunaway/backend: 명령, 이벤트, 앱 정의 SDK
- @bunaway/core: 공통 실행 계층
- @bunaway/runtime-bun: macOS 등 별도 프로세스 백엔드 연결
- @bunaway/protocol: 메시지, 정책, Host API 계약
- @bunaway/packaging: 채널 중립 패키징 계약과 어댑터
- @bunaway/cli: 생성, 검증, 개발, 빌드, 패키징 명령과 네이티브 소스, 도구, 런타임 핀

CLI는 SDK를 같은 정확한 버전으로 의존한다. SDK는 각자 source exports를 제공하며
Bun과 TypeScript로 사용할 수 있다. CLI의 공개 API는 JS 번들과 declaration을 제공한다.
CLI 설치 artifact에는 내부 네이티브 소스, 생성 스키마, Bun/Loader 핀, 라이선스 원문과
artifact.files.json 검사 inventory가 있다. 앱에 복사한 별도 잠금 파일은 없다.

앱에서는 package.json, bun.lock, 앱 소스와 설정을 커밋한다.
node_modules, .bunaway, dist는 제외한다. 재현 설치는 다음과 같다.

```sh
bun install --frozen-lockfile
```

CLI는 설치된 패키지의 릴리스 버전, SDK 해석 경로, CLI artifact inventory를 검사한다.
SDK 버전 혼합, SDK를 바꾸는 overrides/resolutions와 다른 소스로 우회하는 TS aliases는
거부한다. 앱이 직접 선언한 SDK는 앱 위치에서, 전이 SDK는 의존성을 선언한 패키지
위치에서 해석한다. Bun isolated 설치와 워크스페이스의 기본 설치도 지원하며 SDK가
앱 루트에 호이스팅될 필요는 없다. 네이티브 소스의 SDK 참조도 같은 설치본으로 연결한다.
`dev`를 생략하면 앱 전체 재시작, 세션 취소 동작은 이전과 같다.
선택적 `dev.command`, `dev.url`로 Vite/Next.js 같은 외부 UI 개발 서버를 연결하면
UI 변경은 서버의 HMR이 처리하고 백엔드 변경만 새 호스트/세션으로 재시작한다.
[개발 서버 안내](./development-server.md)를 따른다. `dev`, `doctor`에서는 아직 없는
프런트엔드 빌드 디렉터리와 UI SDK 번들 그래프 검사를 생략하며, `validate`, `build`는
프로덕션 UI 자산과 SDK 해석을 계속 검사한다.
검사는 악성 개발 도구/백엔드를 샌드박싱하거나 모든 SDK 파일의 변경을 막는 기능이 아니다.
설치 무결성과 재현성은 패키지 관리자에 맡기며, 최종 앱의 의존성 핀과 빌드 산출물 해시는
빌드 및 패키징 과정에서 확인한다. Windows 배포 앱은 시작 시 전체 파일을 해시하지 않는다.

## 버전 변경과 업그레이드

모든 @bunaway 패키지를 같은 릴리스로 설치한다. 공개 배포 전에는 새 버전의 로컬 묶음을
준비하고 CLI의 --package-dir으로 만든 참조 앱과 의존성 선언을 비교한다.
package.json의 프레임워크 의존성을 함께 갱신한 뒤 bun install로 bun.lock을 갱신하고
validate/typecheck/doctor/dev/build 및 앱 회귀를 확인한다. 일부 SDK만 교체하지 않는다.
실패하면 이전 package.json과 bun.lock을 복원하고 bun install --frozen-lockfile로 되돌린다.
로컬 테스트도 이전 tarball 묶음이 남아 있어야 재설치할 수 있다.

배포 전에는 현재 구조만 지원하며 설정 형식은 v1을 유지한다. 이전 vendor 구조나
분리 설정을 읽는 호환 경로와 자동 마이그레이션은 제공하지 않는다.
새 앱은 src/에 UI, src-bunaway/app.ts에 공통 앱 정의를 두고 src-bunaway/bunaway.json에
build, app, bundle을 통합한다. policy.json은 별도 권한 선언이다.
기존 `build.backend`, `build.windowsApp`은 제거하고 AppDefinition을 default export하는
모듈의 경로를 `build.app`에 지정한다. 개발자가 별도 `runBunApp` 부팅 코드를 작성하지 않는다.
자세한 결정은 [통합 설정](./decisions/0007-project-settings.md)과
[패키지 설치](./decisions/0008-installed-framework-packages.md)를 따른다.

## 네이티브 개발과 최종 사용자

Windows x64 dev/build에는 Windows 기본 제공 tar와 WebView2 Evergreen이 필요하다.
최종 앱 실행에는 WebView2 Evergreen가 필요하다.
macOS arm64에는 Xcode CLT와 GUI 세션이 필요하다. 교차 빌드는 지원하지 않는다.
큰 native dependency와 런타임은 설치된 CLI 패키지 안의 생성 캐시에 받는다.
node_modules를 지우면 이 캐시도 없어지지만 원본 소스와 Bun/Loader 핀은 패키지에서 복원한다.
앱 실행은 번들 Bun의 절대 경로를 사용하며 전역 Bun/개발 도구를 필요로 하지 않는다.
macOS ad-hoc 서명은 Developer ID, 공증, 설치 검증과 별개다.

## artifact 검증

```sh
bun run framework:pack --local
mkdir extracted
# CLI artifact의 inventory와 라이선스를 검사한다.
tar -xzf build/framework/bunaway-cli-0.0.0.tgz -C extracted
bun run framework:check extracted/package
bun test tests/cli
```

외부 설치 테스트는 실제 CLI와 SDK tarball만으로 앱을 생성, 이동, 설치하고, 도구 폴더를
삭제한 뒤 앱의 validate/typecheck와 node_modules 삭제 후 frozen install을 검사한다.
패키지 버전 혼합, CLI 입력 누락, 원본 파일 변조, SDK alias, 소스 캐시 회귀도 확인한다.
BUNAWAY_NATIVE_DISTRIBUTION_TEST=1은 대상 머신에서 doctor/build를 추가한다.
Windows PowerShell에서는 실행 전 $env:BUNAWAY_NATIVE_DISTRIBUTION_TEST = '1'로 지정한다.

선택 패키지는 @bunaway/plugin-storage, @bunaway/plugin-log, @bunaway/plugin-capabilities, @bunaway/plugin-windows다. CLI의 의존성에는 포함하지 않는다. 기본 생성 앱은 저장 패키지만 설치하고 등록한다. 플러그인 추가 시 로컬 tarball을 bun add로 설치한 뒤 해당 객체를 plugins 배열에 추가하고 policy.json의 permissions를 허용한다. 현재 Windows 어댑터를 제공한다.

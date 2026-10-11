# macOS 배포 도구

저장소 기여자용 Bun 진입점이다. 구현과 entitlement는
`packages/packaging/src/channels/macos/`가 소유한다.
`bunaway package`의 macOS 채널 지원 여부는 바뀌지 않는다.
명령은 저장소 루트에서 실행한다.

현재 Bun FFI 앱은 `Contents/MacOS/bunaway-host`에 Bun과 백엔드를 포함하며
`Resources/runtime/bun`이나 `Helpers/bun`을 배포하지 않는다. 서명은 앱 실행 파일에
JIT와 FFI 실행 메모리 entitlement를 적용한다. `host.kind=bun-compiled`가 아닌
이전 호스트 패키지는 거부하며 `bunaway build`로 다시 빌드해야 한다.

| Channel | Artifact | Signature |
|---|---|---|
| `mac-direct` | `<name>-<version>.dmg` | Developer ID Application + hardened runtime, then notarized + stapled |
| `mac-store` | `<name>-<version>.pkg` | Apple Distribution + `embedded.provisionprofile`, uploaded via App Store Connect |

Everything is staged: outputs are only moved into place after the step that
produces them succeeds, so a failed run never clobbers the previous artifact.
Certificate material is never printed or stored: the tool takes keychain
item *names* (`--identity`, `--installer-identity`, `--profile`).

## sign: inside-out codesigning

```sh
bun packages/packaging/scripts/macos.ts sign \
  --channel mac-store \
  --app dist/macos-arm64/MyApp.app \
  --out dist/macos-arm64/MyApp-signed.app \
  --identity "Apple Distribution: Acme (ABCD1234EF)" \
  --team-id ABCD1234EF \
  --provisionprofile MyApp_MAS.provisionprofile
```

compiled 앱의 실행 파일을 채널의 app entitlement와 `--options runtime`으로 서명한 뒤
앱 번들을 서명한다. 마지막으로 `codesign --verify --deep --strict`를 실행한다.
원본 Bun의 `bun.executableSha256`과 compiled 실행 파일의 `host.sourceSha256`은
출처 기록으로 유지하며, 서명 뒤의 앱 무결성은 코드 서명으로 검증한다.

Channel layout notes:

- **mac-store** embeds `embedded.provisionprofile` when `--provisionprofile` is passed.
- Without `--provisionprofile`, the provisioned entitlements
  (`application-identifier`, `team-identifier`) are dropped from the store app
  signature: with them but no profile, AMFI kills the app at exec (measured).
  The result is a *store-layout dev build*: fully launchable for pipeline
  validation, **not** submittable.
- Metadata flags (`--bundle-id --version --build-number --display-name
  --icon --min-os`) rewrite `Info.plist` before sealing; a CLI/config layer
  supplies these from project settings.

`Info.plist`에서는 필요한 문자열만 읽고 수정한다. 다른 키의 날짜, 바이너리 데이터와
중첩 배열, 사전은 기존 타입과 값을 보존하며, 이 메타데이터가 있는 앱도 서명하고
DMG 또는 PKG로 조립할 수 있다.

## package: channel artifact

```sh
bun packages/packaging/scripts/macos.ts package --channel mac-direct \
  --app dist/.../MyApp-signed.app --out-dir dist --name MyApp
# -> dist/MyApp-<version>.dmg  (app + /Applications symlink)

bun packages/packaging/scripts/macos.ts package --channel mac-store \
  --app dist/.../MyApp-signed.app --out-dir dist --name MyApp \
  --installer-identity "3rd Party Mac Developer Installer: Acme (ABCD1234EF)"
# -> dist/MyApp-<version>.pkg ; without --installer-identity it builds an
#    UNSIGNED pkg for dev/CI layout checks
```

## notarize: mac-direct only

```sh
xcrun notarytool store-credentials my-notary-profile --apple-id ...  # once
bun packages/packaging/scripts/macos.ts notarize \
  --artifact dist/MyApp-<version>.dmg --profile my-notary-profile [--app MyApp.app]
```

Without `--profile` it prints the setup it needs and exits `2`: **real
notarization is UNVERIFIED in this repo until run with an Apple-issued
credential**, as is `spctl`/`stapler` Gatekeeper acceptance.

For ZIP distribution, the tool extracts the submitted archive, staples and
validates its single top-level `.app`, then rebuilds the ZIP before replacing
the original. ZIP files cannot be stapled directly. An optional `--app` is
stapled and validated separately; the archived app is always processed.

## Regression checks

```sh
bun test tests/packaging/macos-distribution.test.ts
# Include the actual host and pinned Bun built by the native integration suite:
BUNAWAY_DISTRIBUTION_APP=build/Bunaway.app bun test tests/packaging/macos-distribution.test.ts
```

macOS의 기본 `bun test`에서도 실행하며, 다른 OS에서는 건너뛴다.
실제 Bunaway 앱 검증에는 `BUNAWAY_DISTRIBUTION_APP`을 지정한다.
공증 서비스 대체 도구도 Bun으로 실행한다.
서명 fixture는 Bun으로 compile하므로 C 컴파일러가 필요하지 않다.

The existing macOS native CI runs these checks through
`mise run host:macos -- --app`, after the signed host lifecycle suite. They
use real ad-hoc signing, DMG creation/mounting and unsigned PKG assembly,
check source/packaged hashes and both channel layouts, and inject failures
to check output preservation, rollback and temporary-directory cleanup.
Notary submission and tickets are mocked to test ZIP/DMG control flow;
Apple-issued signing, real notarization and Store acceptance remain unverified.

## Entitlement profiles (`../src/channels/macos/entitlements/`)

compiled 앱에서는 app 템플릿에 `cs.allow-jit`와 `cs.allow-unsigned-executable-memory`를 추가해 앱 실행 파일에 서명한다.

| File | Keys | Why |
|---|---|---|
| `mac-direct-app.plist` | none | not sandboxed; notarization needs only `-o runtime` |
| `mac-store-app.plist` | `app-sandbox`, `network.client`, `application-groups`, `application-identifier`, `team-identifier` | MAS minimum; `${TEAM_ID}`/`${BUNDLE_ID}` substituted at signing; provisioned keys dropped without a profile |

**Known open item:** under self-signed/dev identities, sandboxed
`com.apple.WebKit.Networking` exits on its client-entitlement gate even
though the documented checks pass: verified as far as local signing allows;
re-check with a real Apple-issued signature
(`docs/architecture/macos-sandbox-results.md`).

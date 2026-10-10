현재 Bun FFI 앱은 `Contents/MacOS/bunaway-host`에 Bun과 백엔드를 포함하며
`Resources/runtime/bun`이나 `Helpers/bun`을 배포하지 않는다. 서명은 앱 실행 파일에
JIT와 FFI 실행 메모리 entitlement를 적용한다. 아래 child 재배치는 이전 프로세스
패키지의 호환 경로이며 현재 제품 빌드에서는 사용하지 않는다.

# macOS distribution adapters

Turns a canonical bunaway `.app` (the `bunaway build` output:
`Contents/MacOS/bunaway-host` + `Contents/Resources/{runtime/bun, assets,
licenses, manifest.json}`) into the two macOS release artifacts:

| Channel | Artifact | Signature |
|---|---|---|
| `mac-direct` | `<name>-<version>.dmg` | Developer ID Application + hardened runtime, then notarized + stapled |
| `mac-store` | `<name>-<version>.pkg` | Apple Distribution + `embedded.provisionprofile`, uploaded via App Store Connect |

Everything is staged: outputs are only moved into place after the step that
produces them succeeds, so a failed run never clobbers the previous artifact.
Certificate material is never printed or stored: the scripts take keychain
item *names* (`--identity`, `--installer-identity`, `--profile`).

## sign.sh: inside-out codesigning

```sh
zsh native/macos/distribute/sign.sh \
  --channel mac-store \
  --app dist/macos-arm64/MyApp.app \
  --out dist/macos-arm64/MyApp-signed.app \
  --identity "Apple Distribution: Acme (ABCD1234EF)" \
  --team-id ABCD1234EF \
  --provisionprofile MyApp_MAS.provisionprofile
```

Order (measured requirement: see
`docs/architecture/macos-sandbox-results.md`):

1. sign nested executables (`Contents/Helpers/bun` for store,
   `Contents/Resources/runtime/bun` for direct) with the channel's *child*
   entitlements;
2. record the **post-signing** hash in `manifest.json`'s `bun.packagedSha256`,
   preserving the upstream `bun.executableSha256`: the host prefers the
   packaged digest and re-verifies it at launch;
3. sign the host binary and seal the bundle with the channel's *app*
   entitlements (`--options runtime` everywhere);
4. `codesign --verify --deep --strict`.

Channel layout notes:

- **mac-store** relocates the bundled Bun to `Contents/Helpers/bun` (Apple's
  nested-executable convention; `main.mm` resolves the fallback) and embeds
  `embedded.provisionprofile` when `--provisionprofile` is passed.
- Without `--provisionprofile`, the provisioned entitlements
  (`application-identifier`, `team-identifier`) are dropped from the store app
  signature: with them but no profile, AMFI kills the app at exec (measured).
  The result is a *store-layout dev build*: fully launchable for pipeline
  validation, **not** submittable.
- Metadata flags (`--bundle-id --version --build-number --display-name
  --icon --min-os`) rewrite `Info.plist` before sealing; a CLI/config layer
  supplies these from project settings.

## package.sh: channel artifact

```sh
zsh native/macos/distribute/package.sh --channel mac-direct \
  --app dist/.../MyApp-signed.app --out-dir dist --name MyApp
# -> dist/MyApp-<version>.dmg  (app + /Applications symlink)

zsh native/macos/distribute/package.sh --channel mac-store \
  --app dist/.../MyApp-signed.app --out-dir dist --name MyApp \
  --installer-identity "3rd Party Mac Developer Installer: Acme (ABCD1234EF)"
# -> dist/MyApp-<version>.pkg ; without --installer-identity it builds an
#    UNSIGNED pkg for dev/CI layout checks
```

## notarize.sh: mac-direct only

```sh
xcrun notarytool store-credentials my-notary-profile --apple-id ...  # once
zsh native/macos/distribute/notarize.sh \
  --artifact dist/MyApp-<version>.dmg --profile my-notary-profile [--app MyApp.app]
```

Without `--profile` it prints the setup it needs and exits `2`: **real
notarization is UNVERIFIED in this repo until run with an Apple-issued
credential**, as is `spctl`/`stapler` Gatekeeper acceptance.

For ZIP distribution, the script extracts the submitted archive, staples and
validates its single top-level `.app`, then rebuilds the ZIP before replacing
the original. ZIP files cannot be stapled directly. An optional `--app` is
stapled and validated separately; the archived app is always processed.

## Regression checks

```sh
python3 native/macos/distribute/test.py
# Include the actual host and pinned Bun built by the native integration suite:
BUNAWAY_DISTRIBUTION_APP=build/Bunaway.app python3 native/macos/distribute/test.py
```

The existing macOS native CI runs these checks through
`native/macos/bun/run.sh --app`, after the signed host lifecycle suite. They
use real ad-hoc signing, DMG creation/mounting and unsigned PKG assembly,
check source/packaged hashes and both channel layouts, and inject failures
to check output preservation, rollback and temporary-directory cleanup.
Notary submission and tickets are mocked to test ZIP/DMG control flow;
Apple-issued signing, real notarization and Store acceptance remain unverified.

## Entitlement profiles (`entitlements/`)

| File | Keys | Why |
|---|---|---|
| `mac-direct-app.plist` | none | not sandboxed; notarization needs only `-o runtime` |
| `mac-direct-child.plist` | `cs.allow-jit` | Bun JIT under hardened runtime (~22× slowdown otherwise, measured) |
| `mac-store-app.plist` | `app-sandbox`, `network.client`, `application-groups`, `application-identifier`, `team-identifier` | MAS minimum; `${TEAM_ID}`/`${BUNDLE_ID}` substituted at signing; provisioned keys dropped without a profile |
| `mac-store-child.plist` | `app-sandbox`, `inherit`, `cs.allow-jit` | the only child shape the sandbox accepts (measured) |

**Known open item:** under self-signed/dev identities, sandboxed
`com.apple.WebKit.Networking` exits on its client-entitlement gate even
though the documented checks pass: verified as far as local signing allows;
re-check with a real Apple-issued signature
(`docs/architecture/macos-sandbox-results.md`).

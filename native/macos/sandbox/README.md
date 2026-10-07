# macOS App Sandbox validation harness

Reproduces the App Sandbox measurements that bunaway's macOS distribution
channels depend on. Everything here ran on a real Mac (macOS 26.5.2 arm64,
GUI user session); results and verdicts live in
[`docs/architecture/macos-sandbox-results.md`](../../../docs/architecture/macos-sandbox-results.md).

## Files

| Path | Purpose |
|---|---|
| `src/probe.mm` | experiment probe. `report <workdir>` prints NDJSON: HOME/NSHomeDirectory/`_CS_DARWIN_*` paths, `sandbox_check` results, real file writes inside/outside the container, TCP connect errno. `spawn <child> [args]` posix_spawns a child with captured pipes and bounded wait. `xpc <service>` connects to a Mach/XPC service and sends `{"op":"dump"}`. |
| `src/child.m` | minimal spawn target; prints `child-ok` + its own sandbox state. |
| `src/entsrv.mm` | unsandboxed diagnostic XPC echo service (`ai.bunaway.entsrv`): peer audit token, `xpc_connection_copy_entitlement_value`, `SecTaskCreateWithAuditToken`+`SecTaskCopyValueForEntitlement`, and `sandbox_check_by_audit_token` for mach-lookup/file-write. These private SPI diagnostics do not reproduce every check in shipped WebKit. |
| `entitlements/` | plist sets used by the experiments: `app-sandbox`, `app-sandbox-net` (+`network.client`), `app-sandbox-group` (+`application-groups`), `app-wkwebview`, `child` (sandbox+inherit), `child-jit` (+`cs.allow-jit`), `child-jit-mem` (+`allow-unsigned-executable-memory`). |
| `run.sh` | builds the tools, creates signed experiment `.app` bundles, runs the E1/E2 assertions, prints PASS/FAIL. |

## Run

```sh
zsh native/macos/sandbox/run.sh
```

`BUNAWAY_SBX_IDENTITY` selects the codesign identity (`-` ad-hoc by default;
a self-signed `bunaway-dev-codesign` cert in the login keychain works too :
both were verified to behave identically for sandbox activation).

The harness asserts:

- sandbox activates inside the tested `.app` bundle (bare-executable SIGTRAP
  was measured separately; see the results doc)
- `HOME`/`NSHomeDirectory` remap to `~/Library/Containers/<bundle-id>/Data`;
  writes outside are denied `EPERM`
- the tested linker ad-hoc signed custom helper, without explicit inheritance
  entitlements, outside the bundle is denied `EPERM`;
  `/usr/bin/true` and `/bin/echo` outside the bundle run successfully
- the bundled custom helper with `app-sandbox`+`inherit` runs sandboxed;
  the tested child with `app-sandbox` alone is killed (SIGTRAP). Package
  bunaway-owned helpers inside the bundle with the inheritance pair; this
  is not a blanket prohibition on all external executable paths
- re-exec of the bundle's own main binary works (the `--guard` watchdog model)
- `network.client` is the difference between `EPERM` and `ECONNREFUSED` on connect

## WebKit XPC-service gate (important caveat)

Sandboxed WKWebView renders and completes the bunaway IPC/storage flows, but
`com.apple.WebKit.Networking` (and WebContent churns) exits with
`Application does not have permission to communicate with network resources`
under ad-hoc and self-signed signatures, even though every check documented in
the WebKit source (`hasEntitlement(network.client)` via the peer-view API,
`sandbox_check_by_audit_token` mach-lookup for `nsurlsessiond`) returns allowed
for our app. The cause is unresolved: these private SPI checks are not proof
that an Apple-issued identity fixes the shipped service. The old network
audit-token diagnostic was invalid (filter `4` is an AppleEvent destination,
not a socket address) and has been removed. Use the probe's real `connect()`
test for network access, not that diagnostic.

A temporary Mach lookup exception worked in one local diagnostic configuration;
it is not the shipping profile. Temporary exceptions require justification and
Apple review, not categorical MAS exclusion. This specific exception's approval
and stable MAS WKWebView behavior remain **UNVERIFIED**: see the results doc
and [Apple's upload requirements](https://developer.apple.com/help/app-store-connect/reference/app-uploads/app-sandbox-information/).

## Signed product-host lifecycle fixture

```sh
zsh native/macos/host/run.sh --app
```

This runs the ordinary copied-package suite and then the same suite against
the ad-hoc signed **unsandboxed** `build/Bunaway.app`. It checks in-place paths
and code-sign resource seals, not MAS readiness. The runner verifies the app
before testing, re-signs and verifies it before every launch after resource
changes, then restores the original resource bytes/asset permissions and
verifies the final seal even on a test failure. Nested runtime signatures are
left untouched; updating manifest hashes alone cannot repair the app seal.

To test a separately prepared App Sandbox fixture (test package assets, not the
memo-only package), use a **disposable writable app**, signed inside-out with
its existing entitlements and a post-signing Bun hash. Build the native test
binary first via `native/macos/host/run.sh`. For example:

```sh
BUNAWAY_PACKAGE_IN_PLACE=1 \
BUNAWAY_HOST_EXEC="$PWD/build/SandboxTest.app/Contents/MacOS/bunaway-host" \
BUNAWAY_TEST_WORKSPACE="$PWD/build/macos-sandbox-host" \
BUNAWAY_NATIVE_TEST_EXEC="$PWD/build/macos-host/host-native-tests" \
BUNAWAY_TEST_SIGN_IDENTITY=- \
BUNAWAY_DATA_ROOT="$HOME/Library/Containers/<bundle-id>/Data/Library/Application Support/bunaway/tests.bunaway.host" \
  bun tests/lifecycle/macos-host.ts --package "$PWD/build/SandboxTest.app/Contents/Resources"
```

`BUNAWAY_TEST_SIGN_IDENTITY` is required for a signed in-place fixture; use its
signing identity, not `-`, for a certificate-signed fixture. Re-signing preserves
the identifier, entitlements, requirements and hardened-runtime flags/version.
`BUNAWAY_TEST_WORKSPACE` defaults to `build/macos-host-in-place` in in-place
mode; `BUNAWAY_NATIVE_TEST_EXEC` defaults to `build/macos-host/host-native-tests`
independently of the package location. Scratch, diagnostics, HOME and results
stay in the external workspace; `BUNAWAY_DATA_ROOT` must also stay outside any
`.app` (in its container for App Sandbox). App extensions are checked without
regard to case. Symlinked outputs into apps and output paths containing `..`
components are rejected before creating scratch files or mutating the package.
Deletion roots must not contain the fixture, host/native binaries, workspace or
other test outputs, including through symlink aliases. Scratch and result file
leaves are checked before setup; symlinks and non-regular files are rejected.
Output writes use a temporary sibling and rename rather than following an
existing leaf, and the final app seal is checked after publishing the results.
Default copied-package hostile-path and asset-mutation tests remain
unchanged. A sandboxed WKWebView failure is still a failure, not a skipped test.

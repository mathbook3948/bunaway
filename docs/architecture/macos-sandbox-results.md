# macOS App Sandbox validation results

Validation for shipping bunaway apps sandboxed (Mac App Store requires the App
Sandbox; `mac-direct` stays unsandboxed + notarized). All measurements were
made on a real Mac: **macOS 26.5.2 (25D2110c) arm64, Xcode CLT clang 21, GUI
user session**, signing with ad-hoc (`codesign -s -`) and a local self-signed
`bunaway-dev-codesign` certificate — no Apple-issued identity exists on this
machine, so findings split into *observed locally* and *unverified for MAS*.

Harness: `native/macos/sandbox/` (`run.sh` re-runs the automated assertions;
every verdict below was additionally confirmed by hand-driven runs against the
real `bunaway-host` + pinned Bun 1.4.2 bundle).

## Verified locally (ad-hoc and self-signed identities tested)

| # | Question | Result |
|---|----------|--------|
| 1 | Does `app-sandbox` apply? | In the tested `.app` bundle, yes. A bare signed Mach-O exec'd directly gets SIGTRAP during secinitd container setup; the same binary inside `Contents/MacOS/` sandboxes fully. Ad-hoc and self-signed identities behave identically in these tests; other identities were not tested. |
| 2 | Data paths | `HOME`, `NSHomeDirectory()`, `CS_DARWIN_USER_TEMP_DIR` (TMPDIR) all remap to `~/Library/Containers/<bundleId>/Data`. The host's `$HOME/Library/Application Support/bunaway/<appId>` data root lands inside the container unchanged — **no host code change needed** for scoped storage. Writes outside the container: `EPERM`. |
| 3 | Child spawn | The tested **linker ad-hoc signed custom helper without inheritance entitlements** outside the bundle → `EPERM`; `/usr/bin/true` and `/bin/echo` outside the bundle spawn and exit 0 in the ad-hoc control run. The bundled custom helper signed `app-sandbox`+`com.apple.security.inherit` runs and inherits the parent sandbox. The tested child signed `app-sandbox` **without** `inherit` → SIGTRAP, **even with `network.client` added**. Keep bunaway-owned helpers bundled with the inheritance pair; these observations do not establish a universal outside-bundle ban or exhaust all valid signatures. |
| 4 | Re-exec self | Re-exec of the bundle's own main binary works under sandbox (exit 0) → the `--guard <pgid>` watchdog design is sandbox-compatible as-is. |
| 5 | Bun as child | Real pinned Bun runs under the parent sandbox in every signing flavor tested: untouched Oven signature, or re-signed `app-sandbox`+`inherit`, `+cs.allow-jit`, `+allow-unsigned-executable-memory`. Backend `backend.js` comes up (`backend-ready`) and NDJSON IPC over stdin/stdout works. |
| 6 | JIT | Bun **re-signed with hardened runtime (`-o runtime`) needs `com.apple.security.cs.allow-jit`** — without it JIT-compiled JS falls back to the interpreter: correct output but ~22× slower (2.42s vs 0.11s measured). Without hardened runtime the key is a no-op. MAS entitlements for the bun child therefore: `app-sandbox` + `inherit` + `cs.allow-jit` (+ harden the signature). The stock Oven binary already carries `allow-jit`+`allow-unsigned-executable-memory`+`disable-executable-page-protection`. |
| 7 | Network gate | `com.apple.security.network.client` decides whether `connect()` returns `EPERM` or reaches the stack (`ECONNREFUSED` on a closed port). bunaway's bun child does no networking today → `network.client` goes on the **app** (WebKit needs it), not the child. |
| 8 | Orphan cleanup | `SIGKILL` the host → the `--guard` child detects parent death, kills Bun's process group, exits. Verified under sandbox: no bun/guard remnants. |
| 9 | Read-only exec | Host launched from a **read-only DMG mount** (`hdiutil attach -readonly`) starts normally; all writes land in the container. |
| 10 | Signing order | Signing bun changes its hash → `manifest.json`'s `bun.executableSha256` must be re-recorded **after** signing the nested binaries, then the app resealed (inside-out). Verified empirically: a stale hash trips the host's integrity check (`Bun executable hash mismatch`). |

## WebKit XPC behavior (cause and MAS outcome UNVERIFIED)

**Symptom.** With the app signed `app-sandbox` (+`network.client`,
`application-groups`, and variants), `com.apple.WebKit.Networking.xpc` exits
immediately with `Application does not have permission to communicate with
network resources. rc=1 : errno=34` and `WebContent.xpc` terminates ~60×/s.
The WebView still renders between deaths and the full bunaway flow works
(bunaway:// scheme, session-open, invoke/deliver IPC, `storage.writeText`,
WKContentRuleList, iframe policy) in these local experiments. That does not
establish stable WKWebView operation: the WebKit XPC services refuse to stay up.

**Entitlement visibility, not proof of the full WebKit gate.** An unsandboxed XPC
echo service (`entsrv`) was connected from the sandboxed app and ran selected
private SPI queries based on WebKit's
`XPCServiceInitializerDelegate::checkEntitlements` (WebKit 624.x source):

- `xpc_connection_copy_entitlement_value(connection, "com.apple.security.network.client")` → **true**
- `SecTaskCreateWithAuditToken` + `SecTaskCopyValueForEntitlement` → **true** for `app-sandbox`, `network.client`, `network.server`, `application-groups`
- `sandbox_check_by_audit_token(token, "mach-lookup", …)` for `com.apple.nsurlsessiond`, `com.apple.networkd` → **allowed (0)**

These checks passed in the tested configurations, yet the shipped macOS 26
Networking service still exited. They do not cover every condition in that
service. The original network audit-token diagnostic was invalid: filter `4`
is `SANDBOX_FILTER_APPLEEVENT_DESTINATION`, not a sockaddr filter. Both the
unfiltered and incorrectly filtered network queries were removed from
`entsrv`; their return values are not evidence for a signing-identity cause.
The probe's real `connect()` measurement remains the network access test.

**Diagnostic workaround.** In one local configuration, a
`com.apple.security.temporary-exception.mach-lookup.global-name` entitlement
(naming `com.apple.mDNSResponder`) plus `network.client` made the WebView stack
work. This is a diagnostic-only experiment, not a verified shipping solution
or an explanation of the underlying cause. Apple requires usage information
and justification for temporary exceptions, with approval subject to review:
[App Sandbox upload information](https://developer.apple.com/help/app-store-connect/reference/app-uploads/app-sandbox-information/)
and [temporary exception entitlement reference](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/AppSandboxTemporaryExceptionEntitlements.html).
Temporary exceptions are not categorically MAS-ineligible; approval of this
specific exception has not been tested.

**Verdict.** Stable WKWebView under App Sandbox and MAS acceptance remain
**UNVERIFIED**. Whether Apple-issued signing resolves the observed service
failure is an untested hypothesis, not a conclusion that packaging alone
fixes it. A Developer ID test would not establish Apple Distribution /
provisioning behavior or an App Store review outcome. Keep `entsrv` + `probe
xpc` for follow-up diagnostics, and re-run the real host with the intended
identity and entitlements before making a `mac-store` support claim.

## Lifecycle harness regression checks

After separating package paths from test outputs, the full 9-check product-host
suite passed on this VM in three configurations: ordinary copied package,
ad-hoc signed unsandboxed `.app`, and ad-hoc signed App Sandbox `.app` with
`app-wkwebview.plist` (no temporary exception). The sandbox fixture's Bun was
signed with `child-jit.plist` and hardened runtime, then its manifest hash was
updated before signing the app.

Both app fixtures passed `codesign --verify --deep --strict` before and after
the suite. Original app/policy/manifest bytes, asset-directory permissions and
the bundled tmp directory were restored; no scratch or results appeared in
`Contents`. An intentionally failing native test also left the unsandboxed
fixture's signature valid. These checks validate the harness and successful
flow execution, **not** long-term WebKit XPC stability or Apple-issued signing.
CI now runs `native/macos/host/run.sh --app`, covering the ordinary suite and
the signed unsandboxed fixture; the App Sandbox fixture remains a local check.
See the [harness README](../../native/macos/sandbox/README.md#signed-product-host-lifecycle-fixture)
for the in-place workspace/native-binary/signing inputs.

## Entitlement profiles implied for packaging

| File (in `native/macos/distribute/entitlements/`, PR B) | Contents |
|---|---|
| `mac-direct-app.plist` | none — not sandboxed; hardened runtime + notarization only |
| `mac-direct-child.plist` | none needed (bun keeps Oven signature, no re-sign required unless we strip it) |
| `mac-store-app.plist` | `app-sandbox`, `network.client`, `application-groups` (group = `$(TeamID).<appId>` from config), `cs.allow-jit` if host is hardened (not needed — interpreter fallback works; include only if a native JIT consumer appears) |
| `mac-store-child.plist` | `app-sandbox`, `inherit`, `cs.allow-jit` — sign bun with `-o runtime` |

## Deviations / notes

- `posix_spawn_file_actions_addchdir_np` compiles fine but is deprecated on the
  macOS 26 SDK (warning only).
- `codesign --entitlements` requires absolute paths (relative `../` paths fail).
- Bare-executable sandbox tests are meaningless — secinitd needs the bundle.
- `launchctl procinfo` needs root; `bootout`/`kickstart` need the gui domain.

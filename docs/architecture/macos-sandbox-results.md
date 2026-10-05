# macOS App Sandbox validation results

Validation for shipping bunaway apps sandboxed (Mac App Store requires the App
Sandbox; `mac-direct` stays unsandboxed + notarized). All measurements were
made on a real Mac: **macOS 26.5.2 (25D2110c) arm64, Xcode CLT clang 21, GUI
user session**, signing with ad-hoc (`codesign -s -`) and a local self-signed
`bunaway-dev-codesign` certificate — no Apple-issued identity exists on this
machine, so findings split into *verified* and *needs Apple identity*.

Harness: `native/macos/sandbox/` (`run.sh` re-runs the automated assertions;
every verdict below was additionally confirmed by hand-driven runs against the
real `bunaway-host` + pinned Bun 1.4.2 bundle).

## Verified (ad-hoc AND self-signed — signer does not matter)

| # | Question | Result |
|---|----------|--------|
| 1 | Does `app-sandbox` apply? | Only inside a `.app` bundle. A bare signed Mach-O exec'd directly gets SIGTRAP during secinitd container setup; the same binary inside `Contents/MacOS/` sandboxes fully. **Any signer works** — ad-hoc and self-signed behave identically. |
| 2 | Data paths | `HOME`, `NSHomeDirectory()`, `CS_DARWIN_USER_TEMP_DIR` (TMPDIR) all remap to `~/Library/Containers/<bundleId>/Data`. The host's `$HOME/Library/Application Support/bunaway/<appId>` data root lands inside the container unchanged — **no host code change needed** for scoped storage. Writes outside the container: `EPERM`. |
| 3 | Child spawn | `posix_spawn` of a binary **outside** the bundle → `EPERM`. A child inside `Contents/Helpers/` (or `Contents/MacOS/`) signed `app-sandbox`+`com.apple.security.inherit` runs and inherits the parent sandbox. A child signed `app-sandbox` **without** `inherit` → SIGTRAP, **even with `network.client` added**. So: exactly one allowed child entitlement shape. |
| 4 | Re-exec self | Re-exec of the bundle's own main binary works under sandbox (exit 0) → the `--guard <pgid>` watchdog design is sandbox-compatible as-is. |
| 5 | Bun as child | Real pinned Bun runs under the parent sandbox in every signing flavor tested: untouched Oven signature, or re-signed `app-sandbox`+`inherit`, `+cs.allow-jit`, `+allow-unsigned-executable-memory`. Backend `backend.js` comes up (`backend-ready`) and NDJSON IPC over stdin/stdout works. |
| 6 | JIT | Bun **re-signed with hardened runtime (`-o runtime`) needs `com.apple.security.cs.allow-jit`** — without it JIT-compiled JS falls back to the interpreter: correct output but ~22× slower (2.42s vs 0.11s measured). Without hardened runtime the key is a no-op. MAS entitlements for the bun child therefore: `app-sandbox` + `inherit` + `cs.allow-jit` (+ harden the signature). The stock Oven binary already carries `allow-jit`+`allow-unsigned-executable-memory`+`disable-executable-page-protection`. |
| 7 | Network gate | `com.apple.security.network.client` decides whether `connect()` returns `EPERM` or reaches the stack (`ECONNREFUSED` on a closed port). bunaway's bun child does no networking today → `network.client` goes on the **app** (WebKit needs it), not the child. |
| 8 | Orphan cleanup | `SIGKILL` the host → the `--guard` child detects parent death, kills Bun's process group, exits. Verified under sandbox: no bun/guard remnants. |
| 9 | Read-only exec | Host launched from a **read-only DMG mount** (`hdiutil attach -readonly`) starts normally; all writes land in the container. |
| 10 | Signing order | Signing bun changes its hash → `manifest.json`'s `bun.executableSha256` must be re-recorded **after** signing the nested binaries, then the app resealed (inside-out). Verified empirically: a stale hash trips the host's integrity check (`Bun executable hash mismatch`). |

## Needs an Apple-issued identity (UNVERIFIED — blocks MAS WKWebView claim)

**Symptom.** With the app signed `app-sandbox` (+`network.client`,
`application-groups`, and variants), `com.apple.WebKit.Networking.xpc` exits
immediately with `Application does not have permission to communicate with
network resources. rc=1 : errno=34` and `WebContent.xpc` terminates ~60×/s.
The WebView still renders between deaths and the full bunaway flow works
(bunaway:// scheme, session-open, invoke/deliver IPC, `storage.writeText`,
WKContentRuleList, iframe policy) — so the app side is correct; the WebKit
XPC services refuse to stay up.

**Evidence the app's entitlements are present and correct.** An unsigned XPC
echo service (`entsrv`) was connected from the sandboxed app and ran the same
checks WebKit's `XPCServiceInitializerDelegate::checkEntitlements` performs
(WebKit 624.x source):

- `xpc_connection_copy_entitlement_value(connection, "com.apple.security.network.client")` → **true**
- `SecTaskCreateWithAuditToken` + `SecTaskCopyValueForEntitlement` → **true** for `app-sandbox`, `network.client`, `network.server`, `application-groups`
- `sandbox_check_by_audit_token(token, "mach-lookup", …)` for `com.apple.nsurlsessiond`, `com.apple.networkd` → **allowed (0)**

All pass — yet the shipped macOS 26 Networking service still exits. The one
measurable divergence found: `sandbox_check_by_audit_token(token,
"network-outbound"|"network-inbound"|"system-socket")` → **denied (1)** for
our processes (both direct-exec and `open`-launched), while the *live* profile
actually permits the operation (real `connect()` succeeds). This suggests the
audit-token evaluation path does not honor `network.*` entitlements under a
non-Apple signing identity — consistent with the observation that a
`com.apple.security.temporary-exception.mach-lookup.global-name` entitlement
(e.g. naming `com.apple.mDNSResponder`) plus `network.client` makes the full
WebView stack work — but temporary-exception keys are **not MAS-eligible**, so
that config is diagnostic-only.

**Verdict.** The remaining gate is almost certainly resolved by a real
Apple-issued signature (Developer ID / Apple Distribution + provisioning) —
the WebKit check exists precisely to gate store-quality apps. Until a run with
such an identity confirms it, treat "WKWebView under App Sandbox" as
**UNVERIFIED for MAS**, not broken: the app-side code needs no changes, the
packaging profile just needs the real signature. `entsrv` + `probe xpc` are
kept so the check can be re-run quickly on a machine with credentials.

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

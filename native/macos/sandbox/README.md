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
| `src/entsrv.mm` | unsigned XPC echo service (`ai.bunaway.entsrv`) that mirrors the checks WebKit performs on connecting clients: peer audit token, `xpc_connection_copy_entitlement_value`, `SecTaskCreateWithAuditToken`+`SecTaskCopyValueForEntitlement`, and `sandbox_check_by_audit_token` for mach-lookup/file-write/network ops. |
| `entitlements/` | plist sets used by the experiments: `app-sandbox`, `app-sandbox-net` (+`network.client`), `app-sandbox-group` (+`application-groups`), `app-wkwebview`, `child` (sandbox+inherit), `child-jit` (+`cs.allow-jit`), `child-jit-mem` (+`allow-unsigned-executable-memory`). |
| `run.sh` | builds the tools, creates signed experiment `.app` bundles, runs the E1/E2 assertions, prints PASS/FAIL. |

## Run

```sh
zsh native/macos/sandbox/run.sh
```

`BUNAWAY_SBX_IDENTITY` selects the codesign identity (`-` ad-hoc by default;
a self-signed `bunaway-dev-codesign` cert in the login keychain works too —
both were verified to behave identically for sandbox activation).

The harness asserts:

- sandbox activates only inside an `.app` bundle (bare executables get SIGTRAP)
- `HOME`/`NSHomeDirectory` remap to `~/Library/Containers/<bundle-id>/Data`;
  writes outside are denied `EPERM`
- children must live inside the bundle and carry `app-sandbox`+`inherit`;
  a child with `app-sandbox` alone is killed (SIGTRAP)
- re-exec of the bundle's own main binary works (the `--guard` watchdog model)
- `network.client` is the difference between `EPERM` and `ECONNREFUSED` on connect

## WebKit XPC-service gate (important caveat)

Sandboxed WKWebView renders and completes the bunaway IPC/storage flows, but
`com.apple.WebKit.Networking` (and WebContent churns) exits with
`Application does not have permission to communicate with network resources`
under ad-hoc and self-signed signatures, even though every check documented in
the WebKit source (`hasEntitlement(network.client)` via the peer-view API,
`sandbox_check_by_audit_token` mach-lookup for `nsurlsessiond`) returns allowed
for our app. The remaining gate appears tied to an Apple-issued signing
identity; `entsrv` exists to re-run the mirrored checks under a real
Developer ID signature. Until then MAS WKWebView is **UNVERIFIED** — see the
results doc for the full evidence chain.

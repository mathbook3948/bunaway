# macOS product host

ObjC++ AppKit/WKWebView host: a minimal AppKit shell that runs
the bundled Bun backend as a separate child process and bridges a `WKWebView`
to it over NDJSON frames. The backend contract, assets, limits, and log events
reuse the Windows fixtures (`tests/fixtures/desktop/host`). The macOS test app
uses command/event fixtures without native plugins, in-memory memo state and
trusted Bun report output. `test/app.json` requires a single `view`/`home` declaration,
whereas Windows now uses `windows[]`. macOS multi-window/view isolation is not
implemented or tested. See the [support table](../../../docs/platform-support/README.md).

## Platform mapping

- **Virtual host -> custom scheme.** `WKURLSchemeHandler` cannot serve `https`,
  and localhost servers are rejected by PRD. Assets are served under
  `bunaway://`; every comparison point (origin checks, navigation gate, scheme
  handler, home check) normalizes `bunaway://<host>[:port]` -> `https://<host>[:port]` per
  `docs/architecture/protocol.md`, so `policy.json`, the schemas,
  and the boot payload retain the common format. macOS currently accepts only
  empty native permission lists. Normalization applies
  only to the host-owned asset scheme and only after real URL checks, including
  rejection of userinfo and preservation of non-default ports; a
  web-supplied origin is never normalized into trust.
- **Bridge -> `webkit.messageHandlers.bunaway`** plus a `WKUserScript` shim
  exposing `window.chrome.webview` (all frames) so shared test pages run
  unchanged. Host -> page delivery uses `evaluateJavaScript` on
  `__bunawayDeliver(text)` with a document-generation guard. Subframe messages
  are dropped at `message.frameInfo.isMainFrame` and logged as
  `frame-message-ignored`.
- **Resource blocking.** Subresource interception does not exist in WebKit:
  `WKContentRuleList` blocks http(s) loads by default and makes destination-URL
  exceptions for exact declared scheme/host/port tuples (not subdomains).
  The rule list is installed before the first navigation; compilation failure
  fails startup closed. Non-declared loads are blocked silently;
  `web-resource-blocked` is emitted only for blocked subframe navigations and
  is a platform diagnostic, not part of the common contract.
- **Unexposed storage primitives -> `openat` chain + `O_NOFOLLOW` + `F_GETPATH`** under the canonical
  scope root; the final open uses `O_NONBLOCK` so FIFO rejection cannot stall
  a worker or shutdown. Non-regular files, symlinks and hard links (nlink > 1) are
  `PERMISSION_DENIED`. macOS reports `ENOTDIR` (not `ELOOP`) for
  `O_NOFOLLOW|O_DIRECTORY` on a symlink, so intermediate components are
  re-checked with `fstatat`.
  These helpers retain native boundary tests but are not exposed as app APIs.
  Native plugin permissions and operations fail with `UNSUPPORTED` until a
  macOS plugin adapter is implemented.
- **Renderer recovery** -> `webViewWebContentProcessDidTerminate` revokes the
  session, fails pending web requests, and reloads home without restarting Bun.
- **Process cleanup** -> Bun runs in its own process group; a `--guard`
  watchdog kills the group when the host dies (Job Object analogue with a
  documented spawn-window race).

## Layout

```
main.mm   app host (run, --validate, --watch, --guard)
run.sh    build + package + test pipeline (see below)
```

## Build and test

```zsh
./run.sh              # pins -> clang++ -> host package -> tests/lifecycle/macos-host.ts
./run.sh --skip-tests
./run.sh --app        # also produce an ad-hoc signed build/Bunaway.app
mise run host:macos   # same entry point
```

Requires macOS arm64, pinned Bun 1.4.2, Xcode CLT and a GUI session. Run the
probe before the host serially: both populate `runtime/bun-bundle/vendor`.
The regression suite owns an in-memory memo fixture. The standalone memo app
uses the storage plugin and currently requires Windows.

The driver checks the real host: validator agreement, WebView boundary and
command policy, session revocation, renderer kill/recreation, unsupported
native permission rejection before backend startup, and
guard cleanup after `kill -9`. `host-home/` under the package dir is used as a
hermetic HOME; the data root resolves to
`$HOME/Library/Application Support/bunaway/<appId>`.

CI executes this actual WKWebView suite, not a mocked browser. Launch failure
or missing page reports fail the job. Test-level errors are recorded with
`ok: false` in `build/macos-host-results.json`; host stderr and per-test
logs/temp snapshots are under `build/macos-host-diagnostics/`. FIFO/symlink
fixtures are excluded from diagnostic copies. Both success and failure paths
are uploaded by the native workflow. See the [execution record](../../../docs/architecture/macos-native-results.md).

The native regression executable calls the production scheme handler with
default/non-default ports and userinfo, rejects peerless FIFO reads/writes,
and checks destination filters. A separate WKWebView page loads scripts,
images and fetches against two local test servers on different ports: allowed
requests must reach one server and blocked requests must never reach the other.
Native tests also check unsupported Host operations, cancel-first cleanup and
FIFO file primitives. The WebView suite checks graceful shutdown. These tests require
macOS; the servers are test fixtures only, not a production asset-serving path.

### Deterministic cancel test hook

`BUNAWAY_HOST_OP_DELAY_MS=<ms>` makes every host operation wait on its worker
before the pending check, so a cancel deterministically wins the race. The
native regression verifies the cancel-first path directly: `host-request-cancelled` /
`host-response-discarded` prove that late results are blocked and no duplicate
response escapes. Default is `0` (no delay; production behavior unchanged).

## .app packaging

`run.sh --app` lays out `build/Bunaway.app` as
`Contents/{MacOS/bunaway-host, Resources/{runtime/bun, assets, licenses, manifest.json}}`
and ad-hoc signs it. Inside a bundle the binary self-locates the package via
`NSBundle.mainBundle.resourcePath` (`--package` stays explicit for tests).
Release packaging needs Developer ID signing, notarization
(`xcrun notarytool submit`), and a per-channel decision on App Sandbox
entitlements: all deferred to the release milestone.

Ad-hoc signing is not Developer ID signing, notarization, Gatekeeper or
installation verification. The native CI runs `run.sh --app` to build and test the
ad-hoc signed bundle in place, then runs the distribution-script regression checks.

# macOS product host

ObjC++ port of `native/windows/host/host.cpp`: a minimal AppKit shell that runs
the bundled Bun backend as a separate child process and bridges a `WKWebView`
to it over NDJSON frames. The backend contract, assets, limits, and log events
are identical to the Windows host — the test package is assembled from the
same files (`native/windows/host/test`).

## Platform mapping

- **Virtual host -> custom scheme.** `WKURLSchemeHandler` cannot serve `https`,
  and localhost servers are rejected by PRD. Assets are served under
  `bunaway://`; every comparison point (origin checks, navigation gate, scheme
  handler, home check) normalizes `bunaway://<host>` -> `https://<host>` per
  `docs/architecture/protocol.md`, so `policy.json`, `app.json`, the schemas,
  and the boot payload stay byte-identical to Windows. Normalization applies
  only to the host-owned asset scheme and only after real URL checks; a
  web-supplied origin is never normalized into trust.
- **Bridge -> `webkit.messageHandlers.bunaway`** plus a `WKUserScript` shim
  exposing `window.chrome.webview` (all frames) so shared test pages run
  unchanged. Host -> page delivery uses `evaluateJavaScript` on
  `__bunawayDeliver(text)` with a document-generation guard. Subframe messages
  are dropped at `message.frameInfo.isMainFrame` and logged as
  `frame-message-ignored`.
- **Resource blocking.** Subresource interception does not exist in WebKit:
  `WKContentRuleList` blocks non-declared http(s) loads silently;
  `web-resource-blocked` is emitted only for blocked subframe navigations and
  is a platform diagnostic, not part of the common contract.
- **Storage -> `openat` chain + `O_NOFOLLOW` + `F_GETPATH`** under the canonical
  scope root; symlinks, hard links (nlink > 1), and directories are
  `PERMISSION_DENIED`. macOS reports `ENOTDIR` (not `ELOOP`) for
  `O_NOFOLLOW|O_DIRECTORY` on a symlink, so intermediate components are
  re-checked with `fstatat`.
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
./run.sh --sample     # memo sample package
./run.sh --app        # also produce an ad-hoc signed build/Bunaway.app
mise run host:macos   # same entry point
```

The driver runs the full shared suite against the real host: validator
agreement, WebView boundary/policy/storage scope, session revocation,
renderer kill/recreation, memo persistence across a fresh Bun process, and
guard cleanup after `kill -9`. `host-home/` under the package dir is used as a
hermetic HOME; the data root resolves to
`$HOME/Library/Application Support/bunaway/<appId>`.

### Deterministic cancel test hook

`BUNAWAY_HOST_OP_DELAY_MS=<ms>` makes every host operation wait on its worker
before the pending check, so a cancel deterministically wins the race. The
driver uses it to verify the cancel-first path: `host-request-cancelled` /
`host-response-discarded` prove that late results are blocked and no duplicate
response escapes. Default is `0` (no delay; production behavior unchanged).

## .app packaging

`run.sh --app` lays out `build/Bunaway.app` as
`Contents/{MacOS/bunaway-host, Resources/{runtime/bun, assets, licenses, manifest.json}}`
and ad-hoc signs it. Inside a bundle the binary self-locates the package via
`NSBundle.mainBundle.resourcePath` (`--package` stays explicit for tests).
Release packaging needs Developer ID signing, notarization
(`xcrun notarytool submit`), and a per-channel decision on App Sandbox
entitlements — all deferred to the release milestone.

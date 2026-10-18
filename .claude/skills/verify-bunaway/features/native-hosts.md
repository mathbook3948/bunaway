# Native hosts

The Windows Bun host and the macOS Bun host create windows and WebViews, run native plugins
(storage, clipboard, tray, menu, dialogs, notifications and the rest), enforce the WebView boundary
and package apps. They run only on their OS. This file says how to prove them there and what to
report elsewhere.

## Sub-features

- `native-windows` Windows x64 host: windows, WebView2, plugins, installers.
- `native-macos` macOS arm64 host: windows, WKWebView, plugins, DMG.
- `native-android` and `native-ios` process hosts on a device or simulator.

## How to get to it (user POV)

- Run `bun run dev` or `bun run build` inside a project on Windows x64 or macOS arm64.
- Run `bunaway package win-direct --build` on Windows for an installer.

## Driving it with verify-bunaway

Preconditions:

- The repository checkout on the target OS with `mise install` and `mise run install` done.
- A GUI session on macOS; WebView2 Evergreen on Windows.

- **Windows.** Run `mise run host:windows`. It builds the host package and runs
  `tests/lifecycle/run-native.ts --target windows-x64`, which writes
  `build/windows-*-results.json` and host logs under `%LOCALAPPDATA%/bunaway/tests.bunaway.host/logs`.
  Exit code `0` and every results file with `pass` true.
- **macOS.** Run `mise run host:macos`. It runs `tests/lifecycle/run-native.ts --target
  macos-arm64` and writes `build/macos-*-results.json` and `build/macos-*-diagnostics/`.
- **One plugin on its OS.** Run `bun test tests/lifecycle/windows-<plugin>` or
  `bun test tests/lifecycle/macos-<plugin>` for the plugin under test; the table in
  `tests/README.md` names the file for each change.
- **Android and iOS.** Run `mise run host:android` with a device selected, or `mise run host:ios --
  <Simulator UUID>`.
- **Proof.** The results JSON for the feature, the host log lines around it, and the CI job name
  when the proof came from `windows-native` or `macos-native`.

## Gotchas

- Nothing here runs on Linux. Report native behavior as "not verifiable on this OS" and point to
  the CI jobs `Windows native integration` and `macOS native integration (arm64)`.
- The macOS runner has a known intermittent WKWebView startup stall (issue #237). One failure in
  `macos-webview-controls.ts` or `macos-desktop.ts` with a view stuck at `loading: true` and no
  provisional navigation is that stall; a second failure on the same commit is a real signal.
- Windows geometry tests run three times in CI on fresh processes; a single local run can pass
  while CI catches an order-dependent failure.
- The backend drive in [Backend commands and events](./backend-commands.md) answers host
  operations itself. It never substitutes for these runners when a change touches
  `plugins/*/src/platforms/` or `native/`.

# macOS probe host

POSIX port of `native/windows/probe`: verifies the bundled Bun child process
contract end to end — spawn, dedicated-pipe NDJSON IPC, clean/forced shutdown,
and cleanup when the host dies abnormally.

Design deltas from Windows (documented with execution evidence in the probe
workspace history):

- **Job Object -> `--guard` watchdog.** The host spawns Bun in its own process
  group (`posix_spawnattr_setpgroup`) and a second copy of itself as
  `--guard <pgid>` holding the read end of a death pipe. Host death -> EOF ->
  `kill(-pgid, SIGKILL)` removes Bun and its descendants. A residual
  microsecond spawn-window race is a documented constraint, not a full
  Job Object equivalent.
- **Process accounting -> `proc_listpids(PROC_PGRP_ONLY)` + zombie exclusion**
  (`proc_pidinfo` `pbi_status == SZOMB(5)`).
- **`CancelSynchronousIo` -> `poll(2)` stdin loop; `TerminateProcess` ->
  `killpg(SIGKILL)`; blocking stdout writes -> `O_NONBLOCK` + bounded write.**

Build and run (requires Xcode CLT `clang++`, network for the first pin
download):

```zsh
./run.sh              # verify pins -> build -> package -> tests/lifecycle/macos-process.ts
./run.sh --skip-tests
```

Or via mise: `mise run probe:macos`. The script pins `bun-darwin-aarch64`
(see `runtime/build-manifests/darwin-aarch64.json`), compiles `host.cpp`,
bundles `backend.ts` for Bun, writes `build/macos-probe/package`, and runs the
driver, which copies the package to a unicode path and leaves
`macos-probe-results.json` next to it.

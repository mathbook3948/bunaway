# macOS probe host

POSIX runtime probe: verifies the bundled Bun child process
contract end to end: spawn, dedicated-pipe NDJSON IPC, clean/forced shutdown,
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

Controller output keeps a 128-frame queue and a two-second write deadline.
After backend and controller producers stop, teardown waits up to two seconds
for queue capacity so all pending-request errors and `host-stopped` can drain
to a consuming controller. A temporarily full pipe can resume during teardown;
failure or shutdown alone does not discard partially written frames. A stalled
or disconnected controller still causes bounded output failure and process cleanup.
The overload regression covers both flowing stdout and a paused FIFO that resumes
after Bun exits.

Build and run (requires macOS arm64, Xcode CLT `clang++`, network for the first pin
download):

The script verifies the fixed archive/executable hashes, Mach-O arm64 CPU and
Bun version. Run it serially before the macOS host: both populate the same
Bun extraction cache. CI preserves the result JSON (including `ok: false`
entries on test-level failures), IPC traces and build/driver log even when
the job fails. Setup failures may precede JSON creation. See the
[execution record](../../../docs/architecture/macos-native-results.md).

```zsh
./run.sh              # verify pins -> build -> package -> tests/lifecycle/macos-process.ts
./run.sh --skip-tests
```

Or via mise: `mise run probe:macos`. The script pins `bun-darwin-aarch64`
(see `runtime/build-manifests/darwin-aarch64.json`), compiles `host.cpp`,
bundles `backend.ts` for Bun, writes `build/macos-probe/package`, and runs the
driver, which copies the package to a unicode path and leaves
`macos-probe-results.json` next to it.

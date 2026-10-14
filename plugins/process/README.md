# Foreground argv process plugin

Register `processes` to use `processes.run` on Windows. Grant `process.run` independently.
Applications validate the selected executable and all arguments in backend commands. Trusted backend
code can use Bun.spawn directly. See the [public contract](../../docs/site/src/content/docs/reference/plugins/process.mdx).

The plugin uses Bun argv spawning without PATH lookup, shell strings, caller-selected env/cwd, detach,
interactive handles or arbitrary PID termination. Captured binary stdout/stderr share a byte budget.
Public cancellation or a call deadline can reject the caller's promise before cancellation delivery,
direct-child death or pipe cleanup completes. The adapter continues to own termination and both pipe
readers; its internal execution task and disposal wait for direct-child death. Plugin timeout and output
failure use the same owned cleanup path. Public rejection is not a termination barrier.
Existing Windows host Job Object containment remains responsible for descendants at app shutdown.
Per-command descendant termination requires further containment work and is not claimed here.
Desktop restart/exit belongs to the lifecycle implementation.

`tests/lifecycle/process-run.test.ts` spawns real Bun children and verifies exact argv/binary I/O,
combined output bounds and direct-child death after abort. On Windows, a process handle captured before
abort must already be signaled when the internal `runProcess` task returns; PID existence is not treated
as liveness. `tests/lifecycle/windows-process.test.ts` checks the generated Windows adapter's timeout,
capacity and disposal with actual .exe processes. Its real core/client cancellation regression gates
bridge cancellation delivery, observes prompt public rejection while the child is still alive, then
releases delivery and verifies eventual adapter settlement, child death and disposal.
Both liveness tests wait for the child to publish its complete PID file by rename before capturing its
process identity; an opened but still empty file is not a readiness signal.
Both run under `mise run host:windows`. They do not validate third-party tool behavior, installer-provided
sidecars or independent descendant cleanup on a per-command timeout.

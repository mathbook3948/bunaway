# Foreground argv process plugin

Register `processPlugin` to use `processes.run` on Windows. Grant `process.run` independently.
Applications validate the selected executable and all arguments in backend commands. Trusted backend
code can use Bun.spawn directly. See the [public contract](../../docs/site/src/content/docs/reference/plugins/process.mdx).

The plugin uses Bun argv spawning without PATH lookup, shell strings, caller-selected env/cwd, detach,
interactive handles or arbitrary PID termination. Captured binary stdout/stderr share a byte budget.
Cancellation, timeout, output failure and disposal own both pipe readers and wait for direct-child death.
Existing Windows host Job Object containment remains responsible for descendants at app shutdown.
Per-command descendant termination requires further containment work and is not claimed here.
Desktop restart/exit belongs to the lifecycle implementation.

`tests/lifecycle/process-run.test.ts` spawns real Bun children and verifies exact argv/binary I/O,
combined output bounds and direct-child death after abort. `tests/lifecycle/windows-process.test.ts`
checks the generated Windows adapter's timeout, capacity and disposal with actual .exe processes.
Both run under `mise run host:windows`. They do not validate third-party tool behavior, installer-provided
sidecars or independent descendant cleanup on a per-command timeout.

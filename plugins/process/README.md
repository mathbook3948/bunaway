# Foreground argv process plugin

Register `processes` to use `processes.run` on Windows and macOS. Grant `process.run` independently.
Applications validate the selected executable and all arguments in backend commands. Trusted backend
code can use Bun.spawn directly. See the [public contract](../../docs/site/src/content/docs/reference/plugins/process.mdx).

On macOS the plugin uses `Bun.spawn` with an absolute POSIX path; cancellation, timeout, output overflow
and disposal send SIGKILL to the direct child only and wait for it and its pipes. Descendants are not
terminated. The Windows implementation below is separate.

The Windows plugin uses Win32 argv spawning without PATH lookup, shell strings, caller-selected env/cwd, detach,
interactive handles or arbitrary PID termination. Captured binary stdout/stderr share a byte budget.
Public cancellation or a call deadline can reject the caller's promise before cancellation delivery,
process death or pipe cleanup completes. The adapter continues to own termination and both pipe
readers; its internal execution task and disposal wait for the invocation's entire process tree to exit. Plugin timeout and output
failure use the same owned cleanup path. Public rejection is not a termination barrier.
On Windows 10 or later, each invocation creates a private kill-on-close Job Object as part of CreateProcessW, before the child
can run. It preserves the inherited host Job, restricts handle inheritance to standard I/O, and ends
remaining descendants when the foreground root exits. Cancellation, timeout and output failure also
terminate that Job and wait for native process death. Failed Job setup never launches an uncontained
child. Overlapped stdin remains cancellable even if the child never reads the input.
Existing Windows host Job Object containment remains responsible for app shutdown.
Desktop restart/exit belongs to the lifecycle implementation.

`tests/lifecycle/process-run.test.ts` spawns real Bun children and verifies exact argv/binary I/O,
combined output bounds and direct-child death after abort. Windows cases also exercise grandchildren
with inherited pipes on cancellation, timeout, overflow and root completion, full-size binary stdin,
blocked stdin cancellation and repeated startup failure. On Windows, a process handle captured before
abort must already be signaled when the internal `runProcess` task returns; PID existence is not treated
as liveness. `tests/lifecycle/windows-process.test.ts` checks the generated Windows adapter's timeout,
capacity and disposal with actual .exe processes, native handle cleanup, inherited host Job containment
and isolation of concurrent invocation Jobs. Its real core/client cancellation regression gates
bridge cancellation delivery, observes prompt public rejection while the child is still alive, then
releases delivery and verifies eventual adapter settlement, child death and disposal.
Liveness tests wait for the child to publish its complete PID file by rename before capturing its
process identity; an opened but still empty file is not a readiness signal.
Both run under `mise run host:windows`. They do not validate third-party tool behavior, installer-provided
sidecars or third-party tools that deliberately transfer handles to unrelated processes.

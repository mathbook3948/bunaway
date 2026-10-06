import assert from "node:assert/strict";

export function terminateRenderers(pids: number[]): void {
  let terminated = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
      terminated++;
    } catch (cause) {
      // Inventory candidates may exit or belong to a protected WebKit service.
      if (!["ESRCH", "EPERM"].includes((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
    }
  }
  assert.ok(terminated > 0, "no live test renderer was terminated");
}

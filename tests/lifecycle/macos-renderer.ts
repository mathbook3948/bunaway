import assert from "node:assert/strict";

/** Lists the current user's WebContent processes; `pgrep` exit code 1 means the list is empty. */
export async function listWebContentPids(): Promise<number[]> {
  assert.ok(process.getuid, "WebContent inventory requires a POSIX user ID");
  const probe = Bun.spawn(
    [
      "/usr/bin/pgrep",
      "-U",
      String(process.getuid()),
      "-f",
      "com.apple.WebKit.WebContent",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = await new Response(probe.stdout).text();
  const exit = await probe.exited;
  assert.ok(exit === 0 || exit === 1, await new Response(probe.stderr).text());
  return output
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Kills renderer candidates from an earlier inventory, tolerating exits and protected processes. */
export function terminateRenderers(pids: number[]): void {
  let terminated = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
      terminated++;
    } catch (cause) {
      // Inventory candidates may exit or belong to a protected WebKit service.
      if (
        ![
          "ESRCH",
          "EPERM",
        ].includes((cause as NodeJS.ErrnoException).code ?? "")
      ) {
        throw cause;
      }
    }
  }
  assert.ok(terminated > 0, "no live test renderer was terminated");
}

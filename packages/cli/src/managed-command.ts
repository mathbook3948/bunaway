import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Own finite build commands and their descendants until completion or cancellation.
// The Windows Job worker also cleans up if the owner disappears without sending EOF.
export async function runManagedCommand(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
  framework: string,
): Promise<void> {
  signal.throwIfAborted();
  const windows = process.platform === "win32";
  const lease = windows ? await mkdtemp(resolve(tmpdir(), "bunaway-build-command-")) : undefined;
  try {
    signal.throwIfAborted();
    const child = spawn(
      windows ? process.execPath : (args[0] ?? ""),
      windows
        ? [
            resolve(framework, "packages/cli/src/dev-server-worker.ts"),
            lease ?? "",
            JSON.stringify(args),
          ]
        : args.slice(1),
      {
        cwd,
        env: { ...process.env, ...env },
        stdio: [windows ? "pipe" : "ignore", "inherit", "inherit"],
        detached: !windows,
        windowsHide: true,
      },
    );
    let exit: number | undefined;
    let failure: Error | undefined;
    const exited = new Promise<number>((done) => {
      child.once("error", (error) => {
        failure = error;
        exit = 1;
        done(1);
      });
      child.once("exit", (code) => {
        exit = code ?? 1;
        done(exit);
      });
    });
    const killGroup = (kind: NodeJS.Signals): boolean => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, kind);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        return false;
      }
    };
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> =>
      (stopping ??= (async () => {
        if (windows) {
          child.stdin?.end();
          await Promise.race([exited, delay(6000, undefined, { ref: false })]);
          if (exit === undefined) {
            child.kill();
            await exited;
            throw new Error("Build command worker cleanup timed out.");
          }
        } else if (killGroup("SIGTERM")) {
          await delay(200);
          killGroup("SIGKILL");
        }
        await exited;
      })());
    const aborted = () => {
      // The finally block awaits cleanup and reports failures.
      void stop().catch(() => {});
    };
    signal.addEventListener("abort", aborted, { once: true });
    try {
      if (signal.aborted) aborted();
      const code = await exited;
      signal.throwIfAborted();
      if (failure) throw failure;
      if (code !== 0) throw new Error(`${args[0]} failed (exit ${code}).`);
    } finally {
      signal.removeEventListener("abort", aborted);
      await stop();
    }
  } finally {
    if (lease) await rm(lease, { recursive: true, force: true });
  }
}

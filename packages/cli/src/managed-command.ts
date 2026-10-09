import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const inspectProcesses = promisify(execFile);

/** Waits for a Unix process group to release all live members after its leader exits. */
async function waitForProcessGroupExit(pid: number): Promise<void> {
  const deadline = performance.now() + 5000;
  while (true) {
    // Signal-zero probes include zombies and may report EPERM on macOS after
    // exit. Inspect live members instead; zombies have released their resources.
    const { stdout } = await inspectProcesses(
      "/bin/ps",
      [
        "-A",
        "-o",
        "pgid=,stat=",
      ],
      {
        timeout: 1000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    let alive = false;
    for (const line of stdout.trim().split("\n")) {
      const entry = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
      if (!entry) {
        throw new Error("Cannot inspect build command process group.");
      }
      if (Number(entry[1]) === pid && !/^[ZX]/.test(entry[2] ?? "")) {
        alive = true;
      }
    }
    if (!alive) {
      return;
    }
    if (performance.now() >= deadline) {
      throw new Error("Build command process group cleanup timed out.");
    }
    await delay(10);
  }
}

/** Tracks a command's exit and shares one process-tree cleanup operation. */
export interface ManagedProcess {
  readonly exited: Promise<number>;
  readonly exitCode: number | undefined;
  readonly failure: Error | undefined;
  stop(): Promise<void>;
}

/** Starts a command whose process tree can be stopped as one unit.
 * Servers stay owned until stopped; finite commands wait for descendants to exit during cleanup.
 * The optional signal is checked before spawning, so callers own cancellation after startup.
 */
export async function startManagedProcess(
  args: string[],
  cwd: string,
  framework: string,
  purpose: "finite" | "server",
  env?: Record<string, string>,
  signal?: AbortSignal,
): Promise<ManagedProcess> {
  signal?.throwIfAborted();
  const windows = process.platform === "win32";
  const lease = windows
    ? await mkdtemp(
        resolve(
          tmpdir(),
          purpose === "finite"
            ? "bunaway-build-command-"
            : "bunaway-dev-server-",
        ),
      )
    : undefined;
  async function removeLease(): Promise<void> {
    if (lease) {
      await rm(lease, {
        recursive: true,
        force: true,
      });
    }
  }
  try {
    signal?.throwIfAborted();
  } catch (error) {
    await removeLease();
    throw error;
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
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
        ...(env
          ? {
              env: {
                ...process.env,
                ...env,
              },
            }
          : {}),
        stdio: [
          windows || purpose === "server" ? "pipe" : "ignore",
          "inherit",
          "inherit",
        ],
        detached: !windows,
        windowsHide: true,
      },
    );
  } catch (error) {
    await removeLease();
    throw error;
  }
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
    if (!child.pid) {
      return false;
    }
    try {
      process.kill(-child.pid, kind);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
      return false;
    }
  };
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      try {
        if (windows) {
          child.stdin?.end();
          await Promise.race([
            exited,
            delay(6000, undefined, {
              ref: false,
            }),
          ]);
          if (exit === undefined) {
            child.kill();
            await exited;
            throw new Error(
              purpose === "finite"
                ? "Build command worker cleanup timed out."
                : "Development server worker cleanup timed out.",
            );
          }
        } else {
          const sentTerm = killGroup("SIGTERM");
          if (purpose === "server" || sentTerm) {
            await delay(200);
            killGroup("SIGKILL");
          }
          if (purpose === "finite" && child.pid) {
            await waitForProcessGroupExit(child.pid);
          }
        }
        await exited;
      } finally {
        await removeLease();
      }
    })());
  return {
    exited,
    get exitCode() {
      return exit;
    },
    get failure() {
      return failure;
    },
    stop,
  };
}

/** Runs a finite command and rejects on cancellation, spawn failure, or a nonzero exit.
 * On Windows, the Job worker also cleans descendants if the owning CLI disappears.
 */
export async function runManagedCommand(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
  framework: string,
): Promise<void> {
  const command = await startManagedProcess(
    args,
    cwd,
    framework,
    "finite",
    env,
    signal,
  );
  const aborted = () => {
    // The finally block awaits cleanup and reports failures.
    void command.stop().catch(() => {});
  };
  signal.addEventListener("abort", aborted, {
    once: true,
  });
  try {
    if (signal.aborted) {
      aborted();
    }
    const code = await command.exited;
    signal.throwIfAborted();
    if (command.failure) {
      throw command.failure;
    }
    if (code !== 0) {
      throw new Error(`${args[0]} failed (exit ${code}).`);
    }
  } finally {
    signal.removeEventListener("abort", aborted);
    await command.stop();
  }
}

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DevServerConfig } from "./config.ts";
import { frameworkRoot } from "./files.ts";

export interface DevServer {
  exited: Promise<number>;
  stop(): Promise<void>;
}

async function portInUse(url: URL): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    });
    const finish = (used: boolean) => {
      socket.destroy();
      done(used);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

export async function startDevServer(
  config: DevServerConfig,
  cwd: string,
  signal: AbortSignal,
  root = frameworkRoot,
): Promise<DevServer> {
  signal.throwIfAborted();
  const url = new URL(config.url);
  if (await portInUse(url)) {
    throw new Error(
      `Development port is already in use: ${url.origin}. Stop that server; bunaway starts and owns dev.command.`,
    );
  }
  signal.throwIfAborted();
  const command = [...config.command];
  if (command[0] === "bun") command[0] = process.execPath;
  const lease =
    process.platform === "win32"
      ? await mkdtemp(resolve(tmpdir(), "bunaway-dev-server-"))
      : undefined;
  const child = spawn(
    process.platform === "win32" ? process.execPath : (command[0] ?? ""),
    process.platform === "win32"
      ? [
          resolve(root, "packages/cli/src/dev-server-worker.ts"),
          lease ?? "",
          JSON.stringify(command),
        ]
      : command.slice(1),
    {
      cwd,
      stdio: ["pipe", "inherit", "inherit"],
      detached: process.platform !== "win32",
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
  // The Windows worker owns a kill-on-close Job; on POSIX this child owns a process group.
  const killGroup = (kind: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, kind);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      try {
        if (process.platform === "win32") {
          child.stdin?.end(); // EOF asks the worker to terminate and await its Job descendants.
          await Promise.race([exited, delay(6000, undefined, { ref: false })]);
          if (exit === undefined) {
            child.kill();
            await exited;
            throw new Error("Development server worker cleanup timed out.");
          }
        } else {
          killGroup("SIGTERM");
          await delay(200);
          killGroup("SIGKILL"); // Also reap grandchildren after their parent exited.
        }
        await exited;
      } finally {
        if (lease) await rm(lease, { recursive: true, force: true });
      }
    })());
  const aborted = () => {
    // The owner also awaits stop(), which reports any cleanup failure.
    void stop().catch(() => {});
  };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    const deadline = Date.now() + config.timeoutMs;
    console.log(`Starting frontend server: ${config.command.join(" ")}\nWaiting for ${config.url}`);
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (exit !== undefined)
        throw new Error(
          `Development server exited before readiness (exit ${exit}): ${failure?.message ?? config.command[0]}`,
        );
      try {
        const response = await fetch(config.url, {
          redirect: "manual",
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now()))),
          ]),
        });
        const ready = response.ok;
        await response.body?.cancel();
        if (ready) {
          // Do not mask a startup failure with another process listening on the same port.
          await delay(50, undefined, { signal });
          if (exit !== undefined) throw new Error("Development server exited during readiness.");
          console.log(`Frontend server ready: ${config.url}`);
          return {
            exited,
            stop: async () => {
              signal.removeEventListener("abort", aborted);
              await stop();
            },
          };
        }
      } catch (error) {
        signal.throwIfAborted();
        if (exit !== undefined) throw error;
      }
      await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
    throw new Error(
      `Development server did not return HTTP 2xx within ${config.timeoutMs}ms: ${config.url}. Check dev.command, dev.url and the server port.`,
    );
  } catch (error) {
    signal.removeEventListener("abort", aborted);
    await stop();
    throw error;
  }
}

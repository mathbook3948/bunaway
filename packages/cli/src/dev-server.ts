import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { DevServerConfig } from "./config.ts";
import { frameworkRoot } from "./files.ts";
import { startManagedProcess } from "./managed-command.ts";

/** A ready frontend server whose process tree remains owned until stopped. */
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

/** Starts the configured server and waits for an HTTP 2xx response before returning.
 * Rejects on an occupied port, startup failure, timeout, or cancellation and cleans up its process tree.
 */
export async function startDevServer(
  config: DevServerConfig,
  cwd: string,
  signal: AbortSignal,
  root = frameworkRoot,
): Promise<DevServer> {
  signal.throwIfAborted();
  const url = new URL(config.url);
  // Only this command is owned and stopped below; never adopt a listener we did not start.
  if (await portInUse(url)) {
    throw new Error(
      `Development port is already in use: ${url.origin}. Stop that server; bunaway starts and owns dev.command.`,
    );
  }
  signal.throwIfAborted();
  const command = [
    ...config.command,
  ];
  if (command[0] === "bun") {
    command[0] = process.execPath;
  }
  const ownedProcess = await startManagedProcess(command, cwd, root, "server");
  const { exited } = ownedProcess;
  const startupExitError = () =>
    new Error(
      `Development server exited before readiness (exit ${ownedProcess.exitCode}): ${ownedProcess.failure?.message ?? config.command[0]}`,
    );
  const aborted = () => {
    // The owner also awaits stop(), which reports any cleanup failure.
    void ownedProcess.stop().catch(() => {});
  };
  signal.addEventListener("abort", aborted, {
    once: true,
  });
  try {
    const deadline = Date.now() + config.timeoutMs;
    console.log(
      `Starting frontend server: ${config.command.join(" ")}\nWaiting for ${config.url}`,
    );
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (ownedProcess.exitCode !== undefined) {
        throw startupExitError();
      }
      try {
        const response = await fetch(config.url, {
          redirect: "manual",
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(
              Math.min(1000, Math.max(1, deadline - Date.now())),
            ),
          ]),
        });
        const ready = response.ok;
        await response.body?.cancel();
        if (ready) {
          // Do not mask a startup failure with another process listening on the same port.
          await delay(50, undefined, {
            signal,
          });
          if (ownedProcess.exitCode !== undefined) {
            throw startupExitError();
          }
          console.log(`Frontend server ready: ${config.url}`);
          return {
            exited,
            stop: async () => {
              signal.removeEventListener("abort", aborted);
              await ownedProcess.stop();
            },
          };
        }
      } catch {
        signal.throwIfAborted();
        if (ownedProcess.exitCode !== undefined) {
          throw startupExitError();
        }
      }
      await delay(
        Math.min(100, Math.max(1, deadline - Date.now())),
        undefined,
        {
          signal,
        },
      );
    }
    throw new Error(
      `Development server did not return HTTP 2xx within ${config.timeoutMs}ms: ${config.url}. Check dev.command, dev.url and the server port.`,
    );
  } catch (error) {
    signal.removeEventListener("abort", aborted);
    await ownedProcess.stop();
    throw error;
  }
}

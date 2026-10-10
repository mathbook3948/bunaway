import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { DiagnosticLog } from "../../../packages/runtime-bun/src/diagnostic-log.ts";
import { ViewBoundary } from "../../../packages/runtime-bun/src/view-boundary.ts";
import { Channel } from "../../../packages/runtime-bun/src/worker-channel.ts";
import type { MacosConfig } from "./config.ts";
import { macosOrigin } from "./urls.ts";
import { MacosWebview } from "./webview.ts";

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** Own UI, backend Worker, channels and shutdown deadlines for one Bun app process. */
export async function runMacosApp(config: MacosConfig): Promise<void> {
  await mkdir(resolve(config.dataRoot, "logs"), {
    recursive: true,
  });
  await mkdir(resolve(config.dataRoot, "temp"), {
    recursive: true,
  });
  const log = new DiagnosticLog(resolve(config.dataRoot, "logs/host.log"));
  const diagnostic = (event: string, fields: object = {}) => {
    void log
      .write(event, fields)
      .catch((error) => console.error("Host diagnostic failed:", error));
  };
  let stopping = false;
  let ready = false;
  let cleaned = false;
  let failure: unknown;
  let ui: MacosWebview | undefined;
  let channel: Channel | undefined;
  let boundary: ViewBoundary | undefined;
  let forced: ReturnType<typeof setTimeout> | undefined;
  const quit = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    // The deadline also applies when UI setup fails before its event pump starts.
    forced = setTimeout(() => {
      failure ??= new Error("macOS backend cleanup timed out.");
      void worker.terminate().catch((error) => {
        failure ??= error;
      });
    }, SHUTDOWN_TIMEOUT_MS);
    boundary?.revoke("closing");
    diagnostic("closing");
    channel?.notify({
      kind: "shutdown",
    });
  };
  const fail = (error: unknown) => {
    failure ??= error;
    quit();
  };
  const coreReady = Promise.withResolvers<void>();
  const worker = new Worker(new URL("./backend.js", import.meta.url), {
    workerData: config,
    env: {
      HOME: config.dataRoot,
      TMPDIR: resolve(config.dataRoot, "temp"),
      PATH: "/usr/bin:/bin",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      DO_NOT_TRACK: "1",
    },
  });
  const exited = new Promise<number>((done) => worker.once("exit", done));
  worker.on("error", fail);
  channel = new Channel(
    worker,
    config.runtime,
    "macos-main",
    (packet) => {
      if (packet.kind === "ready") {
        if (stopping) {
          return;
        }
        ready = true;
        coreReady.resolve();
        diagnostic("backend-ready", {
          pid: process.pid,
          bunVersion: Bun.version,
        });
        ui?.start();
      } else if (packet.kind === "server") {
        boundary?.send(packet.route, packet.message);
      } else if (packet.kind === "cleaned") {
        cleaned = true;
      } else if (packet.kind === "fatal") {
        fail(new Error(packet.error.message));
      } else {
        throw new Error("Unexpected macOS UI packet.");
      }
    },
    fail,
  );
  const view = config.policy.views.find(
    (view) => view.id === config.window.view,
  );
  if (!view) {
    throw new Error("Missing macOS view policy.");
  }
  boundary = new ViewBoundary(view, {
    origin: macosOrigin,
    source: () => ui?.source() ?? "",
    ready: () => ready && !stopping,
    forward(packet) {
      channel?.notify(packet);
    },
    capacity: (count) =>
      channel?.canSend(count, boundary?.pendingCount) ?? false,
    deliver: (text) => ui?.deliver(text),
    log: diagnostic,
  });
  const startup = setTimeout(
    () => fail(new Error("macOS startup timed out.")),
    STARTUP_TIMEOUT_MS,
  );
  const onSignal = () => quit();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    diagnostic("host-started", {
      hostPid: process.pid,
      backendPid: process.pid,
      transport: "bun-worker",
      runtime: config.runtime,
    });
    ui = new MacosWebview(config, {
      receive(source, raw) {
        // The native navigation delegate revokes replacement documents. A live URL
        // change without replacement comes from History API and keeps the session.
        boundary?.sameDocument(source);
        boundary?.receive(source, raw);
      },
      revoke: (reason) => boundary?.revoke(reason),
      close: quit,
      tick() {
        boundary?.scanDeadlines();
      },
      log: diagnostic,
      fail,
    });
    await Promise.race([
      Promise.all([
        ui.ready,
        coreReady.promise,
      ]),
      exited.then((code) => {
        throw new Error(`macOS backend exited during startup (${code}).`);
      }),
    ]);
    if (ready) {
      ui.start();
    }
    clearTimeout(startup);
    const code = await exited;
    if (code !== 0 || !cleaned || !stopping) {
      failure ??= new Error(`macOS backend exited without cleanup (${code}).`);
    }
    if (failure) {
      throw failure;
    }
  } catch (error) {
    failure ??= error;
    throw error;
  } finally {
    clearTimeout(startup);
    quit();
    // Keep acknowledgements alive until plugin cleanup and actual Worker exit.
    await exited;
    if (forced) {
      clearTimeout(forced);
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    ui?.close();
    channel.close();
    diagnostic("host-stopped", {
      exitCode: failure ? 1 : 0,
      failed: failure !== undefined,
      forced: !cleaned,
      activeProcesses: 0,
    });
    await log.drain();
  }
}

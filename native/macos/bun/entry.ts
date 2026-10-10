import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
  API_LIMITS,
  BunawayError,
  type HostContext,
  type HostResponse,
  type NativeRegistration,
} from "@bunaway/protocol";
import { DiagnosticLog } from "@bunaway/runtime-bun/diagnostic-log";
import { Channel } from "@bunaway/runtime-bun/worker-channel";
import { hostResponse } from "../../host-api/bun/host-response.ts";
import { loadPluginCatalog } from "../../host-api/bun/plugin-catalog.ts";
import {
  operations,
  permissionMatcher,
  pluginRegistry,
} from "../../host-api/bun/plugins.ts";
import { MacosApplication } from "./application.ts";
import type { MacosConfig } from "./config.ts";
import { containMacosProcess } from "./process-group.ts";
import { MacosWindows } from "./windows.ts";

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
  let ui: MacosWindows | undefined;
  let application: MacosApplication | undefined;
  let channel: Channel | undefined;
  const catalog = await loadPluginCatalog(config.assets);
  let adapters: Awaited<ReturnType<typeof operations>> | undefined;
  let registry: ReturnType<typeof pluginRegistry> | undefined;
  const pendingPlugins: NativeRegistration[] = [];
  let matches: Awaited<ReturnType<typeof permissionMatcher>> | undefined;
  const requests = new Map<string, HostContext>();
  const cancelled = new Set<string>();
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let forced = false;
  let descendantCleanup: Promise<void> | undefined;
  const quit = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    pendingPlugins.length = 0;
    clearTimeout(startup);
    // The deadline also applies when UI setup fails before its event pump starts.
    shutdownTimer = setTimeout(() => {
      forced = true;
      failure ??= new Error("macOS backend cleanup timed out.");
      void worker.terminate().catch((error) => {
        failure ??= error;
      });
    }, SHUTDOWN_TIMEOUT_MS);
    ui?.revoke();
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
  const group = await containMacosProcess((error) => {
    failure ??= error;
    if (channel) {
      quit();
    }
  });
  let worker: Worker;
  try {
    if (failure) {
      throw failure;
    }
    worker = new Worker(new URL("./backend.js", import.meta.url), {
      workerData: config,
      env: {
        HOME: config.dataRoot,
        TMPDIR: resolve(config.dataRoot, "temp"),
        PATH: "/usr/bin:/bin",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        DO_NOT_TRACK: "1",
      },
    });
  } catch (error) {
    await group.close();
    throw error;
  }
  const exited = new Promise<number>((done) => worker.once("exit", done));
  worker.on("error", fail);
  channel = new Channel(
    worker,
    config.runtime,
    "macos-main",
    async (packet) => {
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
        ui?.send(packet.route, packet.message);
      } else if (packet.kind === "native-register") {
        if (stopping) {
          return;
        }
        // Fail without rejecting so the Channel still acknowledges registration;
        // the backend awaits that ack before it can observe shutdown and clean up.
        try {
          if (registry) {
            throw new Error("Invalid native registration phase.");
          }
          pendingPlugins.push(...packet.plugins);
          if (!packet.complete) {
            return;
          }
          // Validate the aggregate limits and installed contracts only after the final batch.
          const plugins = pendingPlugins.splice(0);
          registry = pluginRegistry(plugins, catalog);
          registry.validatePolicy(config.policy);
          matches = await permissionMatcher(plugins, catalog);
          if (!ui) {
            throw new Error("Missing window services.");
          }
          adapters = await operations(
            plugins,
            config.dataRoot,
            "ui",
            ui.services,
            catalog,
          );
        } catch (error) {
          fail(error);
        }
      } else if (packet.kind === "cancel") {
        if (requests.get(packet.requestId) === packet.context) {
          cancelled.add(packet.requestId);
        }
      } else if (packet.kind === "operation") {
        if (
          requests.has(packet.requestId) ||
          requests.size >= API_LIMITS.maxPending
        ) {
          throw new Error("Duplicate native request.");
        }
        requests.set(packet.requestId, packet.context);
        let response: HostResponse;
        try {
          const permissions =
            packet.context === config.backendContext
              ? config.policy.backend
              : ui?.boundary(packet.context)?.policy.host;
          const source =
            packet.context === config.backendContext
              ? "backend"
              : `view:${ui?.boundary(packet.context)?.policy.id ?? "invalid"}`;
          if (
            stopping ||
            !permissions ||
            source !== packet.source ||
            !registry ||
            !matches ||
            !registry.allowed(
              permissions,
              registry.validateCall(packet.call),
              matches,
            )
          ) {
            throw new BunawayError({
              code: "PERMISSION_DENIED",
              message: "Host context or policy denied.",
            });
          }
          if (!adapters) {
            throw new Error("Native adapters are not ready.");
          }
          const payload = await adapters.executeUI(
            packet.call.operation,
            packet.call.payload,
            source,
            {
              requestId: packet.requestId,
              permissions,
            },
          );
          response = hostResponse(() => payload);
        } catch (error) {
          response = hostResponse(() => {
            throw error;
          });
        } finally {
          requests.delete(packet.requestId);
        }
        const wasCancelled = cancelled.delete(packet.requestId);
        if (
          !stopping &&
          !wasCancelled &&
          (packet.context === config.backendContext ||
            ui?.boundary(packet.context))
        ) {
          channel?.notify({
            kind: "host-response",
            context: packet.context,
            requestId: packet.requestId,
            response,
          });
        }
      } else if (packet.kind === "cleaned") {
        cleaned = true;
        // Referenced subprocesses can keep an otherwise cleaned Worker alive.
        descendantCleanup = group.stopDescendants();
        await descendantCleanup;
      } else if (packet.kind === "fatal") {
        fail(new Error(packet.error.message));
      } else {
        throw new Error("Unexpected macOS UI packet.");
      }
    },
    fail,
  );
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
      guardPid: group.guardPid,
      transport: "bun-worker",
      runtime: config.runtime,
    });
    application = new MacosApplication({
      quit,
      tick: () => ui?.tick(),
      fail,
    });
    ui = new MacosWindows(config, application, {
      ready: () => ready,
      stopping: () => stopping,
      busy: () => adapters?.busy() ?? false,
      cancelled: (requestId) => {
        const context = requests.get(requestId);
        return (
          cancelled.has(requestId) ||
          !context ||
          (context !== config.backendContext && !ui?.boundary(context))
        );
      },
      forward: (packet) => channel?.notify(packet),
      capacity: (count, pending) => channel?.canSend(count, pending) ?? false,
      log: diagnostic,
      fail,
      quit,
    });
    await Promise.race([
      coreReady.promise,
      exited.then((code) => {
        // Requested exits use the same cleanup and failure checks as a running app.
        if (!stopping) {
          throw new Error(`macOS backend exited during startup (${code}).`);
        }
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
  } catch (error) {
    failure ??= error;
  } finally {
    clearTimeout(startup);
    quit();
    // Keep acknowledgements alive until plugin cleanup and actual Worker exit.
    await exited;
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      await adapters?.dispose();
    } catch (error) {
      failure ??= error;
    }
    ui?.close();
    application?.close();
    channel.close();
    let activeProcesses: number | null = null;
    try {
      await descendantCleanup?.catch((error) => {
        failure ??= error;
      });
      await group.close();
      activeProcesses = 0;
    } catch (error) {
      failure ??= error;
    } finally {
      diagnostic("host-stopped", {
        exitCode: failure ? 1 : 0,
        failed: failure !== undefined,
        forced,
        activeProcesses,
      });
      await log.drain();
    }
  }
  if (failure) {
    throw failure;
  }
}

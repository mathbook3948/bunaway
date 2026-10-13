import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
  BunawayError,
  type HostContext,
  type HostResponse,
  type NativeRegistration,
} from "@bunaway/protocol";
import { DiagnosticLog } from "@bunaway/runtime-bun/diagnostic-log";
import { Channel, type Packet } from "@bunaway/runtime-bun/worker-channel";
import { hostResponse } from "../../host-api/bun/host-response.ts";
import { NativeRequests } from "../../host-api/bun/native-requests.ts";
import { loadPluginCatalog } from "../../host-api/bun/plugin-catalog.ts";
import { operations, pluginRegistry } from "../../host-api/bun/plugins.ts";
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
  let ioWorker: Worker | undefined;
  let ioChannel: Channel | undefined;
  let ioExited: Promise<number> | undefined;
  let ioCleaned = false;
  let ioShutdownRequested = false;
  const catalog = await loadPluginCatalog(config.assets);
  let adapters: Awaited<ReturnType<typeof operations>> | undefined;
  let registry: ReturnType<typeof pluginRegistry> | undefined;
  const pendingPlugins: NativeRegistration[] = [];
  const requests = new NativeRequests();
  const ioCalls = new Map<
    string,
    {
      packet: Extract<
        Packet,
        {
          kind: "operation";
        }
      >;
      signal: AbortSignal;
    }
  >();
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let forced = false;
  let descendantCleanup: Promise<void> | undefined;
  const quit = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    pendingPlugins.length = 0;
    // Admission reserves one cancellation slot per owned I/O call. Send these
    // before releasing ownership so Core stop hooks can await native aborts.
    for (const [requestId, call] of ioCalls) {
      ioChannel?.notify({
        kind: "cancel",
        requestId,
        context: call.packet.context,
      });
    }
    requests.cancelAll();
    ioCalls.clear();
    clearTimeout(startup);
    // The deadline also applies when UI setup fails before its event pump starts.
    shutdownTimer = setTimeout(() => {
      forced = true;
      failure ??= new Error("macOS backend cleanup timed out.");
      void worker.terminate().catch((error) => {
        failure ??= error;
      });
      void ioWorker?.terminate().catch((error) => {
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
  /** Keep shutdown idempotent when backend completion and failure both request it. */
  function stopIO() {
    if (ioChannel && !ioShutdownRequested) {
      ioShutdownRequested = true;
      ioChannel.notify({
        kind: "shutdown",
      });
    }
  }
  /** Resolve authority from the current document, never from adapter-supplied source fields. */
  function authority(context: HostContext) {
    if (context === config.backendContext) {
      return {
        permissions: config.policy.backend,
        source: "backend",
      };
    }
    const boundary = ui?.boundary(context);
    return boundary
      ? {
          permissions: boundary.policy.host,
          source: `view:${boundary.policy.id}`,
        }
      : undefined;
  }
  /** Keep descendants until both Core hooks and native adapter cleanup have completed. */
  function stopDescendants() {
    if (cleaned && (!ioWorker || ioCleaned)) {
      descendantCleanup ??= group.stopDescendants();
    }
    return descendantCleanup;
  }
  /** Start the same bounded I/O queue as Windows, with macOS-specific adapter imports. */
  async function startIO(plugins: NativeRegistration[]) {
    if (
      !catalog.some(
        (entry) =>
          entry.execution === "io" &&
          plugins.some((plugin) => plugin.name === entry.name),
      )
    ) {
      return;
    }
    const started = Promise.withResolvers<void>();
    ioWorker = new Worker(new URL("./host-operations.js", import.meta.url), {
      workerData: {
        runtime: config.runtime,
        assets: config.assets,
        dataRoot: config.dataRoot,
        plugins,
        policy: config.policy,
      },
      env: {
        HOME: config.dataRoot,
        TMPDIR: resolve(config.dataRoot, "temp"),
        PATH: "/usr/bin:/bin",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        DO_NOT_TRACK: "1",
      },
    });
    ioExited = new Promise<number>((done) => ioWorker?.once("exit", done));
    ioWorker.on("error", (error) => {
      started.reject(error);
      fail(error);
    });
    ioWorker.on("exit", (code) => {
      if (!stopping || !ioCleaned || code !== 0) {
        const error = new Error(
          `macOS I/O worker exited without cleanup (${code}).`,
        );
        started.reject(error);
        fail(error);
      }
    });
    ioChannel = new Channel(
      ioWorker,
      config.runtime,
      "main-io",
      async (packet) => {
        if (packet.kind === "ready") {
          started.resolve();
        } else if (
          packet.kind === "authorize-input" ||
          packet.kind === "prepare"
        ) {
          const call = ioCalls.get(packet.requestId);
          const access = authority(packet.context);
          const allowed =
            !!call &&
            call.packet.context === packet.context &&
            !stopping &&
            !call.signal.aborted &&
            !!access &&
            call.packet.source === access.source &&
            !!registry &&
            registry.allowed(
              access.permissions,
              registry.validateCall(call.packet.call),
            );
          await ioChannel?.send({
            kind:
              packet.kind === "authorize-input" ? "input-authorized" : "grant",
            context: packet.context,
            requestId: packet.requestId,
            allowed,
          });
        } else if (packet.kind === "host-response") {
          const call = ioCalls.get(packet.requestId);
          if (!call) {
            return;
          }
          if (call.packet.context !== packet.context) {
            throw new Error("Invalid I/O response context.");
          }
          // The I/O Worker retains resource cancellation until this callback is
          // acknowledged. Hand off to the backend before releasing main ownership.
          if (!stopping && !call.signal.aborted && authority(packet.context)) {
            await channel?.send(packet);
          }
          if (ioCalls.get(packet.requestId) === call) {
            ioCalls.delete(packet.requestId);
            requests.finish(packet.requestId, call.signal);
          }
        } else if (packet.kind === "cleaned") {
          ioCleaned = true;
          await stopDescendants();
        } else if (packet.kind === "fatal") {
          fail(new Error(packet.error.message));
        } else {
          throw new Error("Unexpected macOS I/O packet.");
        }
      },
      fail,
    );
    await started.promise;
    // Shutdown may have arrived while adapter imports were initializing.
    if (stopping) {
      stopIO();
    }
  }
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
          if (!stopping) {
            await startIO(plugins);
          }
        } catch (error) {
          fail(error);
        }
      } else if (packet.kind === "cancel") {
        if (requests.context(packet.requestId) === packet.context) {
          requests.cancel(packet.requestId);
          ioCalls.delete(packet.requestId);
          ioChannel?.notify(packet);
        }
      } else if (packet.kind === "operation") {
        // The backend needs acceptance even while plugin parsing or execution is pending.
        void executeRequest(packet).catch(fail);
      } else if (packet.kind === "cleaned") {
        cleaned = true;
        stopIO();
        await stopDescendants();
      } else if (packet.kind === "fatal") {
        fail(new Error(packet.error.message));
      } else {
        throw new Error("Unexpected macOS UI packet.");
      }
    },
    fail,
  );
  /** Own result settlement separately from operation acceptance, including late parser failures. */
  async function executeRequest(
    packet: Extract<
      Packet,
      {
        kind: "operation";
      }
    >,
  ): Promise<void> {
    const signal = requests.begin(packet.requestId, packet.context);
    let response: HostResponse;
    try {
      const access = authority(packet.context);
      if (
        stopping ||
        !access ||
        access.source !== packet.source ||
        !registry ||
        !registry.allowed(
          access.permissions,
          registry.validateCall(packet.call),
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
      const execution = catalog.find((plugin) =>
        packet.call.operation.startsWith(`${plugin.name}.`),
      )?.execution;
      if (execution === "io") {
        if (!ioChannel?.canSend(1, ioCalls.size)) {
          throw new BunawayError({
            code: "BUSY",
            message: "Host request limit reached.",
          });
        }
        ioCalls.set(packet.requestId, {
          packet,
          signal,
        });
        await ioChannel.send(packet);
        // The I/O channel owns settlement; acceptance must leave cancellation live.
        return;
      }
      const payload = await adapters.executeUI(
        packet.call.operation,
        packet.call.payload,
        access.source,
        {
          requestId: packet.requestId,
          permissions: access.permissions,
          signal,
          beforeExecute() {
            if (
              stopping ||
              signal.aborted ||
              (packet.context !== config.backendContext &&
                !ui?.boundary(packet.context))
            ) {
              throw new BunawayError({
                code: "CANCELLED",
                message: "Host call was cancelled.",
              });
            }
          },
        },
      );
      response = hostResponse(() => payload);
    } catch (error) {
      ioCalls.delete(packet.requestId);
      response = hostResponse(() => {
        throw error;
      });
    }
    const active = requests.finish(packet.requestId, signal);
    if (
      !stopping &&
      active &&
      (packet.context === config.backendContext || ui?.boundary(packet.context))
    ) {
      channel?.notify({
        kind: "host-response",
        context: packet.context,
        requestId: packet.requestId,
        response,
      });
    }
  }

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
        const context = requests.context(requestId);
        return (
          !context ||
          (context !== config.backendContext && !ui?.boundary(context))
        );
      },
      forward: (packet) => {
        if (packet.kind === "revoke") {
          requests.cancelContext(packet.route.context);
          for (const [id, call] of ioCalls) {
            if (call.packet.context === packet.route.context) {
              ioCalls.delete(id);
            }
          }
          ioChannel?.notify({
            kind: "cancel-context",
            context: packet.route.context,
          });
        }
        channel?.notify(packet);
      },
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
    // Failed backend startup may never report cleaned; still dispose native adapters.
    stopIO();
    await ioExited;
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
    ioChannel?.close();
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

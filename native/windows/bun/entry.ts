import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
  type AppDefinition,
  type Core,
  type CoreSession,
  createCore,
} from "@bunaway/core";
import {
  BunawayError,
  type CancellationSignal,
  type HostContext,
  type HostResponse,
  PROTOCOL_VERSION,
} from "@bunaway/protocol";
import { DiagnosticLog } from "@bunaway/runtime-bun/diagnostic-log";
import { loadPluginCatalog } from "../../host-api/bun/plugin-catalog.ts";
import { pluginRegistry } from "../../host-api/bun/plugins.ts";
import { listenForAppReload } from "./app-reload.ts";
import {
  Channel,
  type Packet,
  type Route,
  type UIConfig,
  validatePacket,
} from "./channel.ts";
import { DesktopLifecycle } from "./desktop.ts";
import { DevelopmentApp } from "./development-app.ts";
import type { LaunchArguments, listenForInstances } from "./instance.ts";
import { activeDescendants, containAppProcess } from "./job.ts";

/**
 * Starts the Windows host and Workers, then creates the app Core.
 * Shutdown drains both Workers and rethrows startup or host failures.
 */
export async function runWindowsApp(
  app: AppDefinition,
  config: UIConfig,
  launch?: LaunchArguments,
  inbox?: Awaited<ReturnType<typeof listenForInstances>>,
): Promise<void> {
  const development =
    config.devtools && process.send ? new DevelopmentApp(app) : undefined;
  app = development?.definition ?? app;
  let closeReload: (() => void) | undefined;
  const plugins = (app.plugins ?? []).flatMap((plugin) => {
    const native = plugin.native;
    return native
      ? [
          {
            name: plugin.name,
            version: plugin.version,
            native,
          },
        ]
      : [];
  });
  const packagedPlugins = await loadPluginCatalog(config.assets);
  pluginRegistry(plugins, packagedPlugins).validatePolicy(config.policy);
  config = {
    ...config,
    plugins,
  };
  containAppProcess(config.dataRoot);
  const sessions = new Map<
    HostContext,
    {
      route: Route;
      session: CoreSession;
    }
  >();
  const log = new DiagnosticLog(resolve(config.dataRoot, "logs/host.log"));
  const calls = new Map<
    string,
    {
      context: HostContext;
      signal: CancellationSignal;
      resolve(value: HostResponse): void;
      reject(error: unknown): void;
      abort(): void;
      authorized?: boolean;
    }
  >();
  let stopping = false;
  const failedSessions = new Set<HostContext>();
  let sequence = 0;
  let core: Core | undefined;
  let booting: Promise<Core> | undefined;
  let failure: unknown;
  let cleaned = false;
  let ioCleaned = false;
  let ioReadyResolve: () => void = () => {};
  const ioReady = new Promise<void>((resolve) => {
    ioReadyResolve = resolve;
  });
  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((resolveReady) => {
    readyResolve = resolveReady;
  });
  let stopResolve: () => void = () => {};
  const stopRequested = new Promise<void>((resolveStop) => {
    stopResolve = resolveStop;
  });
  const desktop = new DesktopLifecycle(
    app.desktop,
    (action) =>
      channel.send({
        kind: "desktop-control",
        action,
      }),
    () => {
      stopping = true;
      stopResolve();
    },
    (error) => {
      console.error("Desktop callback failed:", error);
      void log
        .write("desktop-callback-failed", {
          message: error instanceof Error ? error.message : String(error),
        })
        .catch(() => {});
    },
  );
  config = {
    ...config,
    desktop: {
      closeBehavior: app.desktop?.closeBehavior ?? "quit",
      ...(app.desktop?.tray
        ? {
            tray: {
              tooltip: app.desktop.tray.tooltip,
            },
          }
        : {}),
    },
  };
  const workerPath = new URL(
    existsSync(resolve(import.meta.dir, "ui.ts")) ? "./ui.ts" : "./ui.js",
    import.meta.url,
  );
  const worker = new Worker(workerPath, {
    workerData: config,
  });
  const io = new Worker(
    new URL(
      existsSync(resolve(import.meta.dir, "host-operations.ts"))
        ? "./host-operations.ts"
        : "./host-operations.js",
      import.meta.url,
    ),
    {
      workerData: {
        runtime: config.runtime,
        dataRoot: config.dataRoot,
        assets: config.assets,
        plugins,
      },
    },
  );
  let exitResolve: (value: number) => void = () => {};
  const exited = new Promise<number>((resolveExit) => {
    exitResolve = resolveExit;
  });
  const fail = (error: unknown) => {
    failure ??= error;
    stopping = true;
    readyResolve();
    ioReadyResolve();
    stopResolve();
  };
  const channel = new Channel(worker, config.runtime, "main", receive, fail);
  const ioChannel = new Channel(
    io,
    config.runtime,
    "main-io",
    async (packet) => {
      if (packet.kind === "ready") {
        ioReadyResolve();
        return;
      }
      if (packet.kind === "cleaned") {
        ioCleaned = true;
        return;
      }
      if (packet.kind === "fatal") {
        fail(new Error(packet.error.message));
        return;
      }
      if (packet.kind !== "prepare" && packet.kind !== "host-response") {
        throw new Error("Unexpected I/O reply");
      }
      const call = calls.get(packet.requestId);
      if (!call || call.context !== packet.context || stopping) {
        return;
      }
      if (packet.kind === "prepare") {
        await channel.send({
          ...packet,
          kind: "authorize",
        });
      } else if (call.authorized) {
        await channel.send({
          ...packet,
          kind: "host-result",
        });
      } else {
        finishCall(packet.requestId, packet.response);
      }
    },
    fail,
  );
  io.on("error", (error) => {
    fail(error);
    ioChannel.close();
  });
  const ioExited = new Promise<number>((resolveExit) =>
    io.on("exit", (code) => {
      if (!ioCleaned || code !== 0) {
        fail(new Error(`I/O Worker exited without cleanup (${code})`));
      }
      ioChannel.close();
      resolveExit(code);
    }),
  );
  worker.on("error", (error) => {
    fail(error);
    channel.close();
  });
  worker.on("exit", (code) => {
    if (!cleaned || code !== 0) {
      fail(new Error(`UI Worker exited without cleanup (${code})`));
    }
    channel.close();
    exitResolve(code);
  });
  function takeCall(id: string) {
    const call = calls.get(id);
    if (!call) {
      return undefined;
    }
    calls.delete(id);
    call.signal.removeEventListener("abort", call.abort);
    return call;
  }
  function cancelCalls(context?: HostContext) {
    for (const [id, call] of calls) {
      if (context !== undefined && call.context !== context) {
        continue;
      }
      takeCall(id)?.reject(
        new BunawayError({
          code: "CANCELLED",
          message: "Host context closed.",
        }),
      );
    }
    // Revocation cancels a whole context without overflowing per-request control slots.
    if (context !== undefined) {
      channel.notify({
        kind: "cancel-context",
        context,
      });
      ioChannel.notify({
        kind: "cancel-context",
        context,
      });
    }
  }
  async function receive(packet: Packet) {
    if (packet.kind === "diagnostic") {
      await log.write(packet.event, packet.fields);
      return;
    }
    if (packet.kind === "ready") {
      readyResolve();
      return;
    }
    if (packet.kind === "quit-request") {
      // Accept the request immediately so a signal can drain the UI channel
      // while the app is still deciding whether to quit.
      void desktop
        .quit(packet.reason)
        .then(async (allowed) => {
          if (!allowed && !stopping) {
            await channel.send({
              kind: "quit-cancelled",
            });
          }
        })
        .catch(fail);
      return;
    }
    if (packet.kind === "closing") {
      stopping = true;
      stopResolve();
      return;
    }
    if (packet.kind === "fatal") {
      fail(new Error(packet.error.message));
      return;
    }
    if (packet.kind === "cleaned") {
      cleaned = true;
      return;
    }
    if (packet.kind === "revoke") {
      const session = sessions.get(packet.route.context);
      sessions.delete(packet.route.context);
      channel.discardServers(packet.route.context);
      if (!failedSessions.delete(packet.route.context)) {
        cancelCalls(packet.route.context);
      }
      await session?.session.close();
      return;
    }
    if (stopping) {
      return;
    }
    if (packet.kind === "native-event") {
      const session = sessions.get(packet.route.context);
      if (
        !session ||
        session.route.viewId !== packet.route.viewId ||
        session.route.documentGeneration !== packet.route.documentGeneration
      ) {
        return;
      }
      await core?.emitNative(
        packet.route.context,
        packet.event,
        packet.payload,
      );
      return;
    }
    if (packet.kind === "session-open") {
      if (!core || sessions.has(packet.route.context)) {
        throw new Error("Invalid session-open");
      }
      sessions.set(packet.route.context, {
        route: packet.route,
        session: core.openSession(packet.route.context, packet.route.viewId),
      });
    } else if (packet.kind === "client") {
      const session = sessions.get(packet.route.context);
      if (
        !session ||
        session.route.documentGeneration !== packet.route.documentGeneration ||
        session.route.viewId !== packet.route.viewId
      ) {
        throw new Error("Invalid client route");
      }
      await session.session.receive(packet.message);
    } else if (packet.kind === "prepare") {
      const call = calls.get(packet.requestId);
      if (!call || call.context !== packet.context || call.signal.aborted) {
        return;
      }
      await channel.send({
        kind: "grant",
        context: packet.context,
        requestId: packet.requestId,
        allowed: true,
      });
    } else if (packet.kind === "authorized") {
      const call = calls.get(packet.requestId);
      if (!call || call.context !== packet.context) {
        return;
      }
      call.authorized = packet.allowed;
      await ioChannel.send({
        ...packet,
        kind: "grant",
      });
    } else if (packet.kind === "host-response") {
      const call = calls.get(packet.requestId);
      if (!call || call.context !== packet.context) {
        return;
      }
      finishCall(packet.requestId, packet.response);
    } else {
      throw new Error("Unexpected main packet");
    }
  }
  function finishCall(id: string, response: HostResponse) {
    takeCall(id)?.resolve(response);
  }
  const onSignal = () => {
    stopping = true;
    stopResolve();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const startupTimer = setTimeout(
    () => fail(new Error("Windows startup timed out")),
    30000,
  );
  try {
    await mkdir(resolve(config.dataRoot, "logs"), {
      recursive: true,
    });
    await log.write("host-started", {
      pid: process.pid,
      ui: "worker",
      runtime: config.runtime,
    });
    // Wait for both Workers before Core starts routing host calls.
    await Promise.all([
      ready,
      ioReady,
    ]);
    if (failure) {
      throw failure;
    }
    booting = createCore(app, {
      policy: config.policy,
      hello: {
        kind: "hello",
        protocol: PROTOCOL_VERSION,
        features: [],
        buildId: "bunaway",
      },
      platform: "windows",
      backendContext: config.backendContext,
      onPluginError(plugin, phase, cause) {
        if (
          stopping &&
          phase === "setup" &&
          cause instanceof BunawayError &&
          cause.code === "CANCELLED"
        ) {
          return;
        }
        console.error(`Plugin ${plugin} ${phase} failed:`, cause);
        return log.write("plugin-failed", {
          plugin,
          phase,
          message: cause instanceof Error ? cause.message : String(cause),
          ...(cause instanceof Error
            ? {
                stack: cause.stack,
              }
            : {}),
        });
      },
      onCommandError(command, cause) {
        console.error(`Command ${command} failed:`, cause);
        void log
          .write("command-failed", {
            command,
            message: cause instanceof Error ? cause.message : String(cause),
            ...(cause instanceof Error
              ? {
                  stack: cause.stack,
                }
              : {}),
          })
          .catch(() => {});
      },
      runtime: {
        createCancellation: () => new AbortController(),
        now: () => Date.now(),
        schedule: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      send: async (context, message) => {
        const session = sessions.get(context);
        if (!session || stopping || failedSessions.has(context)) {
          return;
        }
        try {
          await channel.send({
            kind: "server",
            route: session.route,
            message,
          });
        } catch (error) {
          if (
            sessions.get(context) !== session ||
            failedSessions.has(context) ||
            stopping
          ) {
            throw error;
          }
          if (error instanceof BunawayError && error.code === "BUSY") {
            // Keep the closed route until UI revocation consumes in-flight input.
            failedSessions.add(context);
            channel.discardServers(context);
            cancelCalls(context);
            channel.notify({
              kind: "session-failure",
              route: session.route,
              error: {
                code: "BUSY",
                message: "Server message queue full.",
              },
            });
            void session.session.close().catch(fail);
            throw error;
          }
          fail(error);
          throw error;
        }
      },
      callHost: (context, call, signal) => {
        if (stopping || signal.aborted) {
          return Promise.reject(
            new BunawayError({
              code: "CANCELLED",
              message: "Host operation cancelled.",
            }),
          );
        }
        // Pending calls reserve cancellation capacity on both Workers until their acks arrive.
        if (
          !channel.canSend(1, calls.size) ||
          !ioChannel.canSend(1, calls.size)
        ) {
          return Promise.reject(
            new BunawayError({
              code: "BUSY",
              message: "Host request limit reached.",
            }),
          );
        }
        const requestId = `host-${++sequence}`;
        const execution = packagedPlugins.find((plugin) =>
          call.operation.startsWith(`${plugin.name}.`),
        )?.execution;
        const source =
          context === config.backendContext
            ? "backend"
            : `view:${sessions.get(context)?.route.viewId ?? "invalid"}`;
        const packet = {
          kind: "operation",
          context,
          requestId,
          call,
          source,
        } as const;
        try {
          validatePacket(packet, execution === "ui" ? "ui" : "io");
        } catch {
          return Promise.reject(
            new BunawayError({
              code: "INVALID_ARGUMENT",
              message: "Invalid host request.",
            }),
          );
        }
        return new Promise<HostResponse>((resolveCall, reject) => {
          const abort = () => {
            const call = takeCall(requestId);
            if (!call) {
              return;
            }
            channel.notify({
              kind: "cancel",
              context,
              requestId,
            });
            ioChannel.notify({
              kind: "cancel",
              context,
              requestId,
            });
            call.reject(
              new BunawayError({
                code: "CANCELLED",
                message: "Host context closed.",
              }),
            );
          };
          calls.set(requestId, {
            context,
            signal,
            resolve: resolveCall,
            reject,
            abort,
          });
          signal.addEventListener("abort", abort);
          void (execution === "ui" ? channel : ioChannel)
            .send(packet)
            .catch((error) => {
              abort();
              fail(error);
            });
        });
      },
    }).then((created) => {
      core = created;
      if (stopping) {
        void created.stop().catch(fail);
      }
      return created;
    });
    core = await Promise.race([
      booting,
      stopRequested.then(() => undefined),
    ]);
    clearTimeout(startupTimer);
    if (core && !stopping) {
      await log.write("backend-ready", {
        pid: process.pid,
        bunVersion: Bun.version,
      });
    }
    if (!stopping) {
      if (development) {
        closeReload = listenForAppReload(development, config.assets);
      }
      // Start the UI before delivering initial or forwarded launch requests.
      await channel.send({
        kind: "start",
      });
      if (launch) {
        desktop.open(launch, "initial");
      }
      inbox?.start((input) => desktop.open(input, "second-instance"));
    }
    await stopRequested;
  } catch (error) {
    fail(error);
  } finally {
    // Stop new work before stopping Core and draining Worker cleanup.
    closeReload?.();
    clearTimeout(startupTimer);
    stopping = true;
    desktop.dispose();
    await inbox?.close().catch(fail);
    cancelCalls();
    const timeout = setTimeout(() => {
      console.error("Windows cleanup timed out; ending failed app process.");
      process.exit(1);
    }, 40000);
    if (!core) {
      core = await booting?.catch((error) => {
        if (failure) {
          fail(error);
        }
        return undefined;
      });
    }
    await core?.stop().catch(fail);
    sessions.clear();
    await channel
      .send({
        kind: "shutdown",
      })
      .catch(fail);
    await ioChannel
      .send({
        kind: "shutdown",
      })
      .catch(fail);
    await Promise.all([
      exited,
      ioExited,
    ]);
    clearTimeout(timeout);
    channel.close();
    ioChannel.close();
    const descendants = activeDescendants();
    await log.write("host-stopped", {
      activeProcesses: cleaned && ioCleaned ? descendants : null,
      forced: descendants > 0,
      failed: !!failure,
    });
    await log.drain();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  if (failure) {
    throw failure;
  }
}

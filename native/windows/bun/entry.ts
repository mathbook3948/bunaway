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
  SDK_READY_FEATURE,
} from "@bunaway/protocol";
import { toAppInfo } from "@bunaway/runtime-bun/app-metadata";
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
import {
  DesktopLifecycle,
  desktopLaunch,
  validateDesktopStartup,
} from "./desktop.ts";
import { DevelopmentApp } from "./development-app.ts";
import type { LaunchArguments, listenForInstances } from "./instance.ts";
import { activeDescendants, containAppProcess } from "./job.ts";
import {
  type HostLaunch,
  relaunchCommand,
  relaunchCommandLine,
  relaunchCommandLineTooLong,
} from "./relaunch.ts";
import { releaseSessionEndWait } from "./session-end.ts";
import { readTrayIcon } from "./tray-icon.ts";
import { readWebViewVersion } from "./webview-version.ts";

/** How an orderly shutdown ended: the process exit code and an optional app-requested relaunch. */
export type WindowsAppResult = {
  readonly exitCode: number;
  /** Arguments for the new process; present only after an approved `relaunch()`. */
  readonly relaunch?: {
    readonly argv: readonly string[];
  };
};

/**
 * Starts the Windows host and Workers, then creates the app Core.
 * Shutdown drains both Workers and rethrows startup or host failures; otherwise it resolves to
 * the exit code and relaunch the caller must apply after this function has released the app.
 */
export async function runWindowsApp(
  app: AppDefinition,
  config: UIConfig,
  launch?: LaunchArguments,
  inbox?: Awaited<ReturnType<typeof listenForInstances>>,
  host?: HostLaunch,
): Promise<WindowsAppResult> {
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
      settled: Promise<void>;
      authorized?: boolean;
    }
  >();
  let stopping = false;
  const failedSessions = new Set<HostContext>();
  let sequence = 0;
  let core: Core | undefined;
  let booting: Promise<Core> | undefined;
  let failure: unknown;
  /** Wait buffer of a confirmed Windows session end; the UI thread blocks on it until app cleanup. */
  let sessionEndRelease: SharedArrayBuffer | undefined;
  /** True once Core stopped or the host failed, so no app cleanup remains for a session end to wait on. */
  let appCleanupSettled = false;
  /** Releases the blocked UI thread, now or as soon as a session end registers its buffer. Repeatable. */
  const settleSessionEnd = () => {
    appCleanupSettled = true;
    if (sessionEndRelease) {
      releaseSessionEndWait(sessionEndRelease);
    }
  };
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
    announceShutdownCommitted,
    (error) => {
      console.error("Desktop callback failed:", error);
      void log
        .write("desktop-callback-failed", {
          message: error instanceof Error ? error.message : String(error),
        })
        .catch(() => {});
    },
    undefined,
    true,
    host
      ? (argv) => {
          // Check the command line the relaunch will really use, so an argument list that
          // passes the public limits but cannot start a process is refused before the quit.
          const command = relaunchCommand(
            host,
            argv ?? desktopLaunch(launch?.argv ?? []).argv,
          );
          if (relaunchCommandLineTooLong(relaunchCommandLine(command))) {
            throw new BunawayError({
              code: "INVALID_ARGUMENT",
              message: "Relaunch command line is too long.",
            });
          }
        }
      : undefined,
  );
  const startHidden = desktopLaunch(launch?.argv ?? []).hidden;
  validateDesktopStartup(config.windows, app.desktop, startHidden);
  config = await withDesktopStart(config, app.desktop, startHidden);
  const worker = new Worker(workerModuleUrl("ui"), {
    workerData: config,
  });
  const io = new Worker(workerModuleUrl("host-operations"), {
    workerData: {
      runtime: config.runtime,
      app: config.app,
      dataRoot: config.dataRoot,
      assets: config.assets,
      plugins,
      policy: config.policy,
    },
  });
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
    // A failed host cannot finish cleanup, so do not keep Windows waiting on the UI thread.
    settleSessionEnd();
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
      if (
        packet.kind !== "authorize-input" &&
        packet.kind !== "prepare" &&
        packet.kind !== "host-response"
      ) {
        throw new Error("Unexpected I/O reply");
      }
      const call = calls.get(packet.requestId);
      if (!call || call.context !== packet.context) {
        return;
      }
      if (stopping) {
        // Inbox cleanup may still be pending. Abort before acknowledging a
        // dropped I/O result so its undelivered resources remain cancellable.
        call.abort();
        return;
      }
      if (packet.kind === "authorize-input") {
        await channel.send(packet);
      } else if (packet.kind === "prepare") {
        await channel.send({
          ...packet,
          kind: "authorize",
        });
      } else if (call.authorized) {
        await channel.send({
          ...packet,
          kind: "host-result",
        });
        // UI acceptance can precede its reply to Core. Retain the I/O Worker's
        // cancellation owner until Core receives the result or the call is cancelled.
        await call.settled;
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
      if (context === undefined) {
        // Shutdown must notify both native Workers before Core hooks can wait
        // for their abort handlers; rejecting the backend promise alone is insufficient.
        call.abort();
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
  /** The session of `route`'s context, only while the route still names its view and document. */
  function currentSession(route: Route) {
    const session = sessions.get(route.context);
    const current =
      session?.route.viewId === route.viewId &&
      session.route.documentGeneration === route.documentGeneration;
    return current ? session : undefined;
  }
  /** The pending host call a packet answers, unless it was settled or belongs to another context. */
  function callFor(packet: { requestId: string; context: HostContext }) {
    const call = calls.get(packet.requestId);
    return call?.context === packet.context ? call : undefined;
  }
  async function revokeSession(route: Route) {
    const session = sessions.get(route.context);
    sessions.delete(route.context);
    channel.discardServers(route.context);
    if (!failedSessions.delete(route.context)) {
      cancelCalls(route.context);
    }
    await session?.session.close();
  }
  /**
   * Packets handled even during shutdown. Returns undefined for any other packet so the caller
   * can apply the shutdown gate before routing it.
   */
  function receiveLifecycle(packet: Packet): Promise<void> | undefined {
    switch (packet.kind) {
      case "diagnostic":
        return log.write(packet.event, packet.fields);
      case "ready":
        readyResolve();
        return Promise.resolve();
      case "quit-request":
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
        return Promise.resolve();
      case "windows-empty":
        if (!stopping) {
          desktop.windowsEmpty();
        }
        return Promise.resolve();
      case "session-end":
        // Windows ends the session regardless of the app: commit before anything else so a pending
        // beforeQuit result is ignored, then run the normal shutdown. The UI thread stays blocked
        // in WM_ENDSESSION until settleSessionEnd(), which is immediate when cleanup already ended.
        sessionEndRelease = packet.release;
        desktop.commitShutdown("session-end");
        stopping = true;
        stopResolve();
        if (appCleanupSettled) {
          settleSessionEnd();
        }
        return Promise.resolve();
      case "closing":
        desktop.commitShutdown(packet.reason);
        stopping = true;
        stopResolve();
        return Promise.resolve();
      case "fatal":
        fail(new Error(packet.error.message));
        return Promise.resolve();
      case "cleaned":
        cleaned = true;
        return Promise.resolve();
      case "revoke":
        return revokeSession(packet.route);
      default:
        return undefined;
    }
  }
  async function receive(packet: Packet) {
    const lifecycle = receiveLifecycle(packet);
    if (lifecycle !== undefined) {
      await lifecycle;
      return;
    }
    if (stopping) {
      return;
    }
    switch (packet.kind) {
      case "native-event": {
        if (currentSession(packet.route)) {
          await core?.emitNative(
            packet.route.context,
            packet.event,
            packet.payload,
          );
        }
        return;
      }
      case "session-open": {
        if (!core || sessions.has(packet.route.context)) {
          throw new Error("Invalid session-open");
        }
        sessions.set(packet.route.context, {
          route: packet.route,
          session: core.openSession(packet.route.context, packet.route.viewId),
        });
        return;
      }
      case "client": {
        const session = currentSession(packet.route);
        if (!session) {
          throw new Error("Invalid client route");
        }
        await session.session.receive(packet.message);
        return;
      }
      default:
        await receiveHostCallPacket(packet);
    }
  }
  /** Authorization and result packets of host calls; anything else is a protocol violation. */
  async function receiveHostCallPacket(packet: Packet) {
    switch (packet.kind) {
      case "prepare": {
        const call = callFor(packet);
        if (!call || call.signal.aborted) {
          return;
        }
        await channel.send({
          kind: "grant",
          context: packet.context,
          requestId: packet.requestId,
          allowed: true,
        });
        return;
      }
      case "input-authorized": {
        const call = callFor(packet);
        if (!call || call.signal.aborted) {
          return;
        }
        await ioChannel.send(packet);
        return;
      }
      case "authorized": {
        const call = callFor(packet);
        if (!call) {
          return;
        }
        call.authorized = packet.allowed;
        await ioChannel.send({
          ...packet,
          kind: "grant",
        });
        return;
      }
      case "host-response":
        if (callFor(packet)) {
          finishCall(packet.requestId, packet.response);
        }
        return;
      default:
        throw new Error("Unexpected main packet");
    }
  }
  function finishCall(id: string, response: HostResponse) {
    takeCall(id)?.resolve(response);
  }
  /**
   * Begins shutdown for a cause the UI thread did not report (an approved api, tray or last-window
   * quit, or a signal). The UI is told before the later `shutdown` packet so it stops emitting window
   * lifecycle events and close requests as soon as the commit is made. Repeatable.
   */
  function announceShutdownCommitted() {
    stopping = true;
    channel.notify({
      kind: "shutdown-committed",
    });
    stopResolve();
  }
  const onSignal = () => {
    desktop.commitShutdown("interrupted");
    announceShutdownCommitted();
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
    const webview = await webViewVersionOrNull(config.loader, log);
    booting = createCore(app, {
      app: toAppInfo(config.appMetadata, {
        bun: Bun.version,
        webview,
      }),
      policy: config.policy,
      hello: {
        kind: "hello",
        protocol: PROTOCOL_VERSION,
        features: [
          SDK_READY_FEATURE,
        ],
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
        const thread = packagedPlugins.find((plugin) =>
          call.operation.startsWith(`${plugin.name}.`),
        )?.thread;
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
          validatePacket(packet, thread === "ui" ? "ui" : "io");
        } catch {
          return Promise.reject(
            new BunawayError({
              code: "INVALID_ARGUMENT",
              message: "Invalid host request.",
            }),
          );
        }
        return new Promise<HostResponse>((resolveCall, reject) => {
          const settled = Promise.withResolvers<void>();
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
            resolve(value) {
              resolveCall(value);
              settled.resolve();
            },
            reject(error) {
              reject(error);
              settled.resolve();
            },
            abort,
            settled: settled.promise,
          });
          signal.addEventListener("abort", abort);
          void (thread === "ui" ? channel : ioChannel)
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
      // A shutdown committed while the start acknowledgement was pending makes open() throw, which
      // would turn an orderly shutdown into a host failure, so skip the launch callbacks.
      if (!stopping) {
        // onReady is queued ahead of the initial open so that open callbacks wait for it.
        desktop.ready(launch);
        inbox?.start((input) => desktop.open(input, "second-instance"));
      }
    }
    await stopRequested;
  } catch (error) {
    fail(error);
  } finally {
    // Stop new work before stopping Core and draining Worker cleanup.
    closeReload?.();
    clearTimeout(startupTimer);
    stopping = true;
    // An orderly shutdown tells the app before Core and window teardown begin;
    // host failures skip this because the app state can no longer be trusted.
    if (!failure) {
      await desktop.willQuit();
    }
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
    // App-level cleanup (onWillQuit and plugin stop hooks) is done: let a blocked session end return.
    // Worker teardown below continues after the UI thread resumes and processes `shutdown`.
    settleSessionEnd();
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
    // Backstop for a session end registered after the release above (repeat-safe).
    settleSessionEnd();
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
    if (!failure) {
      await desktop.quitCompleted();
    }
  }
  if (failure) {
    throw failure;
  }
  return appResult(desktop, launch);
}

/** Adds the resolved desktop startup settings (and hidden-start support) to the UI Worker config. */
async function withDesktopStart(
  config: UIConfig,
  desktop: AppDefinition["desktop"],
  startHidden: boolean,
): Promise<UIConfig> {
  const trayIcon =
    desktop?.tray?.icon === undefined
      ? undefined
      : await readTrayIcon(
          config.appMetadata.paths?.resources,
          desktop.tray.icon,
        );
  const tray = desktop?.tray
    ? {
        tray: {
          tooltip: desktop.tray.tooltip,
          ...(trayIcon === undefined
            ? {}
            : {
                icon: trayIcon,
              }),
        },
      }
    : {};
  return {
    ...config,
    ...(config.app
      ? {
          app: {
            ...config.app,
            supportsHiddenStart: !!desktop?.tray,
          },
        }
      : {}),
    desktop: {
      startHidden,
      closeBehavior: desktop?.closeBehavior ?? "quit",
      ...tray,
    },
  };
}

/** Resolves a Worker entry next to this module: TypeScript in development, bundled JS when packaged. */
function workerModuleUrl(name: "ui" | "host-operations"): URL {
  const source = existsSync(resolve(import.meta.dir, `${name}.ts`));
  return new URL(source ? `./${name}.ts` : `./${name}.js`, import.meta.url);
}

/** The WebView version is informational: failure is logged and exposed as null. */
async function webViewVersionOrNull(
  loader: UIConfig["loader"],
  log: DiagnosticLog,
): Promise<string | null> {
  try {
    return readWebViewVersion(loader);
  } catch (cause) {
    await log.write("webview-version-unavailable", {
      message: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}

/** Exit code and, after an approved relaunch, the arguments of the new process. */
function appResult(
  desktop: DesktopLifecycle,
  launch: LaunchArguments | undefined,
): WindowsAppResult {
  const relaunch = desktop.relaunch;
  return {
    exitCode: desktop.exitCode,
    ...(relaunch
      ? {
          relaunch: {
            // Without explicit arguments the new process repeats the initial launch.
            argv: relaunch.argv ?? desktopLaunch(launch?.argv ?? []).argv,
          },
        }
      : {}),
  };
}

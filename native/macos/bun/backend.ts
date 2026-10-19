import { parentPort, workerData } from "node:worker_threads";
import {
  type Core,
  type CoreSession,
  createCore,
  type ShutdownReason,
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
import {
  Channel,
  type Packet,
  type Route,
} from "@bunaway/runtime-bun/worker-channel";
import { DesktopLifecycle } from "../../windows/bun/desktop.ts";
import { runBackendShutdown } from "./backend-shutdown.ts";
import type { MacosBackendData } from "./config.ts";

const config: MacosBackendData = workerData;
if (!parentPort) {
  throw new Error("macOS backend requires a Bun Worker.");
}
let core: Core | undefined;
let stopping = false;
let booting: Promise<Core> | undefined;
/** Runs the app's `desktop` callbacks; undefined until the app definition loaded, or when loading failed. */
let desktop: DesktopLifecycle | undefined;
/** Settles once loading the app definition ended, in success or failure, so shutdown never races it. */
const appLoaded = Promise.withResolvers<void>();
/**
 * True once an orderly shutdown cause was committed: an approved quit, or `closing` from the main
 * thread. A host failure never sets it, which is what skips `onWillQuit` and `onQuit`.
 */
let orderly = false;
/**
 * True from the moment a shutdown was committed, before the `shutdown` packet arrives (which sets
 * `stopping`). Native events such as window lifecycle and close requests are dropped from then on,
 * so the app sees none after it approved a quit. Separate from `stopping`, which gates `shutdown`.
 */
let shutdownCommitted = false;
/** First cause the main thread reported through `closing`, kept for a lifecycle that does not exist yet. */
let reportedCause: ShutdownReason | undefined;
/** Settles when the main thread has torn down all native resources (`native-stopped`). */
const nativeStopped = Promise.withResolvers<void>();
const sessions = new Map<
  string,
  {
    route: Route;
    session: CoreSession;
  }
>();
let sequence = 0;
const calls = new Map<
  string,
  {
    context: HostContext;
    signal: CancellationSignal;
    abort(): void;
    resolve(response: HostResponse): void;
    reject(error: unknown): void;
  }
>();
function takeCall(requestId: string) {
  const call = calls.get(requestId);
  if (call) {
    calls.delete(requestId);
    call.signal.removeEventListener("abort", call.abort);
  }
  return call;
}
/** Reports a failed app callback or an overrun shutdown hook to the host log; the app keeps running. */
function reportDesktopFailure(error: unknown) {
  console.error("Desktop callback failed:", error);
  // Diagnostics are best effort: a full or closed channel must not turn a callback failure into a host failure.
  void channel
    .send({
      kind: "diagnostic",
      event: "desktop-callback-failed",
      fields: {
        message: (error instanceof Error ? error.message : String(error)).slice(
          0,
          1024,
        ),
      },
    })
    .catch(() => {});
}
let failed = false;
const fail = (error: unknown) => {
  if (failed) {
    return;
  }
  failed = true;
  console.error("macOS backend failed:", error);
  channel.notify({
    kind: "fatal",
    error: {
      code: "INTERNAL",
      message: "Backend failed.",
    },
  });
};
/** Main-thread desktop packets only follow `desktop-config`, which is sent after the lifecycle exists. */
function requireDesktop(): DesktopLifecycle {
  if (!desktop) {
    throw new Error("Desktop lifecycle is not ready.");
  }
  return desktop;
}
/** The session of `route`'s context, only while the route still names its view and document. */
function currentSession(route: Route) {
  const session = sessions.get(route.context);
  const current =
    session?.route.viewId === route.viewId &&
    session.route.documentGeneration === route.documentGeneration;
  return current ? session : undefined;
}
function receiveHostResponse(
  packet: Extract<
    Packet,
    {
      kind: "host-response";
    }
  >,
) {
  const pending = calls.get(packet.requestId);
  if (pending && pending.context !== packet.context) {
    throw new Error("Invalid host response context.");
  }
  takeCall(packet.requestId)?.resolve(packet.response);
}
function receiveOpenUrls(
  packet: Extract<
    Packet,
    {
      kind: "open-urls";
    }
  >,
) {
  if (stopping || shutdownCommitted) {
    // Not a callback failure: the app already approved the quit. The count is enough for
    // diagnostics, since URLs may hold secrets.
    void channel
      .send({
        kind: "diagnostic",
        event: "open-urls-dropped",
        fields: {
          reason: "ending",
          count: packet.urls.length,
        },
      })
      .catch(() => {});
    return;
  }
  try {
    requireDesktop().openUrls(packet.urls);
  } catch (error) {
    // A full or ending open queue loses only this request; the app keeps running.
    reportDesktopFailure(error);
  }
}
/** Begins backend shutdown once: abort pending host calls, then run cleanup in the background. */
function beginBackendShutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  // Setup may await a Host response that shutdown will no longer deliver.
  for (const call of calls.values()) {
    call.abort();
  }
  // Return immediately so the Channel can acknowledge shutdown while cleanup
  // waits for setup and sends its own completion packet.
  void (async () => {
    await appLoaded.promise;
    core ??= await booting?.catch(() => undefined);
    await runBackendShutdown({
      desktop,
      orderly,
      stopCore: async () => {
        await core?.stop();
        sessions.clear();
      },
      reportCleaned: () =>
        channel.send({
          kind: "cleaned",
        }),
      // The main thread owns the process exit. The code goes last, after onQuit, which may
      // still change it through exit().
      reportExitCode: () =>
        channel.send({
          kind: "exit-code",
          exitCode: desktop?.exitCode ?? 0,
        }),
      nativeStopped: nativeStopped.promise,
    });
    await channel.drain();
    channel.close();
    parentPort?.close();
  })().catch(fail);
}
async function revokeSession(route: Route) {
  const session = sessions.get(route.context);
  sessions.delete(route.context);
  channel.discardServers(route.context);
  await session?.session.close();
}
/**
 * Packets handled even once shutdown began. Returns undefined for any other packet so the caller
 * can apply the shutdown gate before routing it.
 */
function receiveAlways(packet: Packet): Promise<void> | undefined {
  switch (packet.kind) {
    case "host-response":
      receiveHostResponse(packet);
      return Promise.resolve();
    case "quit-request":
      // Accept the request immediately so the main thread's shutdown can still be delivered
      // while the app is deciding in beforeQuit.
      void requireDesktop()
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
    case "closing":
      // The main thread decided alone (signal, session end, vanished last window): the first cause wins.
      orderly = true;
      shutdownCommitted = true;
      reportedCause ??= packet.reason;
      desktop?.commitShutdown(packet.reason);
      return Promise.resolve();
    case "open-urls":
      receiveOpenUrls(packet);
      return Promise.resolve();
    case "reopen":
      requireDesktop().reopen({
        hasVisibleWindows: packet.hasVisibleWindows,
      });
      return Promise.resolve();
    case "windows-empty":
      if (!stopping) {
        requireDesktop().windowsEmpty();
      }
      return Promise.resolve();
    case "native-stopped":
      nativeStopped.resolve();
      return Promise.resolve();
    case "shutdown":
      beginBackendShutdown();
      return Promise.resolve();
    case "revoke":
      return revokeSession(packet.route);
    default:
      return undefined;
  }
}
async function receivePacket(packet: Packet) {
  const always = receiveAlways(packet);
  if (always !== undefined) {
    await always;
    return;
  }
  if (stopping) {
    return;
  }
  switch (packet.kind) {
    case "native-event": {
      // A stale route belongs to a revoked or navigated document and is dropped silently.
      if (!shutdownCommitted && currentSession(packet.route)) {
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
        throw new Error("Invalid session-open.");
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
        throw new Error("Invalid client route.");
      }
      await session.session.receive(packet.message);
      return;
    }
    default:
      throw new Error("Unexpected macOS backend packet.");
  }
}
const channel = new Channel(
  parentPort,
  config.runtime,
  "macos-backend",
  receivePacket,
  fail,
);

try {
  // @ts-expect-error app.js is generated by the framework bundler.
  const { default: imported } = await import("./app.js");
  const app: import("@bunaway/core").AppDefinition = imported;
  // The constructor validates the options, so an invalid definition fails before any native setup.
  desktop = new DesktopLifecycle(
    app.desktop,
    (action) =>
      channel.send({
        kind: "desktop-control",
        action,
      }),
    () => {
      // An approved quit: stop delivering native events at once and tell the main thread first, so
      // it begins teardown and sends `shutdown` next.
      orderly = true;
      shutdownCommitted = true;
      channel.notify({
        kind: "shutdown-committed",
      });
    },
    reportDesktopFailure,
    undefined,
    // The macOS host cannot start a replacement process of itself yet.
    false,
  );
  if (reportedCause) {
    desktop.commitShutdown(reportedCause);
  }
  appLoaded.resolve();
  if (app.desktop?.tray) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "macOS menu bar extras (desktop.tray) are not implemented.",
    });
  }
  const plugins = (app.plugins ?? []).flatMap((plugin) =>
    plugin.native
      ? [
          {
            name: plugin.name,
            version: plugin.version,
            native: plugin.native,
          },
        ]
      : [],
  );
  // A shutdown that arrived during loading closes the port itself once cleanup finished.
  if (!stopping) {
    booting = (async () => {
      // The main thread needs the close behavior before it can decide on a window close or a Quit.
      await channel.send({
        kind: "desktop-config",
        closeBehavior:
          app.desktop?.closeBehavior === "keep-alive" ? "keep-alive" : "quit",
        reopenHandler: typeof app.desktop?.onReopen === "function",
      });
      // Each native contract has its own size budget; never combine contracts into one packet.
      const batchCount = Math.max(1, plugins.length);
      for (let index = 0; index < batchCount; index++) {
        const plugin = plugins[index];
        await channel.send({
          kind: "native-register",
          plugins: plugin
            ? [
                plugin,
              ]
            : [],
          complete: index === batchCount - 1,
        });
        if (stopping) {
          throw new BunawayError({
            code: "CANCELLED",
            message: "Backend startup cancelled.",
          });
        }
      }
      return createCore(app, {
        app: toAppInfo(config.appMetadata, {
          bun: Bun.version,
          webview: config.webview,
        }),
        policy: config.policy,
        platform: "macos",
        backendContext: config.backendContext,
        hello: {
          kind: "hello",
          protocol: PROTOCOL_VERSION,
          // Windows parity: SDK acknowledgement drives readiness and showWhenReady.
          features: [
            SDK_READY_FEATURE,
          ],
          buildId: config.runtime.id,
        },
        runtime: {
          createCancellation: () => new AbortController(),
          now: () => Date.now(),
          schedule(callback, delay) {
            const timer = setTimeout(callback, delay);
            return () => clearTimeout(timer);
          },
        },
        onCommandError(command, cause) {
          console.error(`Command ${command} failed:`, cause);
        },
        onPluginError(plugin, phase, cause) {
          console.error(`Plugin ${plugin} ${phase} failed:`, cause);
        },
        async send(context, message) {
          const session = sessions.get(context);
          if (session && !stopping) {
            await channel.send({
              kind: "server",
              route: session.route,
              message,
            });
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
          if (!channel.canSend(1, calls.size)) {
            return Promise.reject(
              new BunawayError({
                code: "BUSY",
                message: "Host request limit reached.",
              }),
            );
          }
          const requestId = `host-${++sequence}`;
          const source =
            context === config.backendContext
              ? "backend"
              : `view:${sessions.get(context)?.route.viewId ?? "invalid"}`;
          return new Promise<HostResponse>((resolve, reject) => {
            const abort = () => {
              if (!takeCall(requestId)) {
                return;
              }
              channel.notify({
                kind: "cancel",
                context,
                requestId,
              });
              reject(
                new BunawayError({
                  code: "CANCELLED",
                  message: "Host operation cancelled.",
                }),
              );
            };
            calls.set(requestId, {
              context,
              signal,
              abort,
              resolve,
              reject,
            });
            signal.addEventListener("abort", abort);
            void channel
              .send({
                kind: "operation",
                context,
                requestId,
                call,
                source,
              })
              .catch((error) => {
                takeCall(requestId)?.reject(error);
              });
          });
        },
      });
    })();
    core = await booting;
    if (!stopping) {
      // The main thread starts the UI while handling `ready`, so the acknowledgement means the
      // startup windows began native creation.
      await channel.send({
        kind: "ready",
      });
      // A shutdown committed while the acknowledgement was pending makes `open` throw, which
      // would turn an orderly shutdown into a host failure, so skip the launch callbacks.
      if (!stopping && !orderly) {
        // onReady is queued ahead of the initial open so that open callbacks wait for it.
        // The macOS host accepts no launch arguments (boot.ts takes only --package and --dev-url).
        desktop.ready({
          argv: [],
          cwd: process.cwd(),
        });
      }
    }
  }
} catch (error) {
  appLoaded.resolve();
  if (
    !(stopping && error instanceof BunawayError && error.code === "CANCELLED")
  ) {
    fail(error);
  }
}

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
import { WILL_QUIT_DEADLINE_MS } from "../../windows/bun/desktop.ts";
import { MacosApplication } from "./application.ts";
import type { MacosBackendData, MacosConfig } from "./config.ts";
import { DesktopRequests } from "./desktop-requests.ts";
import { normalizeOpenUrls } from "./open-urls.ts";
import { containMacosProcess } from "./process-group.ts";
import { RelaunchIntent, relaunchCommand, startRelaunch } from "./relaunch.ts";
import { readWebKitVersion } from "./webkit-version.ts";
import { MacosWindows } from "./windows.ts";

const STARTUP_TIMEOUT_MS = 30_000;
/** Time Core, plugin stop hooks and native cleanup get once shutdown began. */
const SHUTDOWN_TIMEOUT_MS = 5_000;
/**
 * Backstop that terminates the Workers of a shutdown that does not finish. It also covers the
 * app's `onWillQuit` (before Core stops) and `onQuit` (after native teardown), which the backend
 * waits for up to `WILL_QUIT_DEADLINE_MS` each. A shorter backstop would kill an app hook the
 * lifecycle promises to wait for.
 */
const FORCED_SHUTDOWN_DEADLINE_MS =
  SHUTDOWN_TIMEOUT_MS + 2 * WILL_QUIT_DEADLINE_MS;
/**
 * Shutdown causes the main thread decides alone and reports to the backend with `closing`.
 * A cause the backend committed itself (an approved quit) arrives as `shutdown-committed`.
 */
type MainShutdownCause = "interrupted" | "session-end" | "window-destroyed";

/**
 * Own UI, backend Worker, channels and shutdown deadlines for one Bun app process.
 * Resolves to the process exit code the app chose; failures reject instead.
 */
export async function runMacosApp(config: MacosConfig): Promise<number> {
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
  let exitCode = 0;
  /** The app's relaunch request from the backend's last packet, unless a signal or session end cancelled it. */
  const relaunchIntent = new RelaunchIntent();
  // The new process keeps the working directory and environment this host booted with.
  const bootCwd = process.cwd();
  const bootEnvironment = {
    ...process.env,
  };
  /** Starts the process `relaunch()` asked for; a failure is only logged, the exit code stands. */
  const startReplacement = async () => {
    try {
      const launch = config.app?.launch;
      if (!launch) {
        throw new Error("The host has no launch information.");
      }
      await startRelaunch(
        relaunchCommand(
          {
            executablePath: launch.executablePath,
            args: launch.args,
            cwd: bootCwd,
            env: bootEnvironment,
          },
          process.pid,
        ),
      );
      diagnostic("relaunch-started");
    } catch (error) {
      diagnostic("relaunch-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
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
  /** Settles when the backend reports app-level cleanup (hooks, Core and plugin stop hooks) done. */
  const backendCleaned = Promise.withResolvers<void>();
  /**
   * Settles when shutdown begins. The startup wait races it, because the backend only reports
   * `cleaned` after teardown that this thread must perform, so waiting for `ready` would deadlock.
   */
  const shutdownBegun = Promise.withResolvers<void>();
  let nativeTeardown: Promise<void> | undefined;
  const desktopRequests = new DesktopRequests({
    stopping: () => stopping,
    sendQuitRequest: (reason) =>
      channel?.notify({
        kind: "quit-request",
        reason,
      }),
    sendOpenUrls: (urls) =>
      channel?.send({
        kind: "open-urls",
        urls: [
          ...urls,
        ],
      }) ?? Promise.resolve(),
    // An app with `onReopen` decides what a reopen shows. Without it the host brings the windows
    // back when none is visible. Either way a reopen is not an open request. The hook runs only
    // while draining, after construction, so reading `desktopRequests` here is safe.
    deliverReopen: (hasVisibleWindows) => {
      if (desktopRequests.reopenHandler) {
        return (
          channel?.send({
            kind: "reopen",
            hasVisibleWindows,
          }) ?? Promise.resolve()
        );
      }
      if (!hasVisibleWindows) {
        ui?.requestShow();
      }
      return Promise.resolve();
    },
    diagnostic,
  });
  /**
   * Begins shutdown once; later calls do nothing. Every path ends in the same teardown, but only an
   * orderly shutdown runs the app's shutdown hooks, and only a `cause` is reported to the backend.
   *
   * @param cause Set for a cause decided here (signal, session end, last window gone). It is sent
   * as `closing` ahead of `shutdown`. Omitted when the backend committed the shutdown itself, and
   * for a host failure, where the hooks are skipped because the app state cannot be trusted.
   */
  const beginShutdown = (cause?: MainShutdownCause) => {
    if (stopping) {
      return;
    }
    stopping = true;
    shutdownBegun.resolve();
    desktopRequests.abandon();
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
    }, FORCED_SHUTDOWN_DEADLINE_MS);
    ui?.revoke();
    diagnostic(
      "closing",
      cause
        ? {
            cause,
          }
        : {},
    );
    if (cause) {
      channel?.notify({
        kind: "closing",
        reason: cause,
      });
    }
    channel?.notify({
      kind: "shutdown",
    });
  };
  const fail = (error: unknown) => {
    failure ??= error;
    beginShutdown();
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
  /**
   * Keep descendants until both Core hooks and native adapter cleanup have completed. A pending
   * session-end reply is released only afterwards (success or failure), because the OS may end the
   * process right after the reply; the session-end wait still bounds how long it is held back.
   */
  function stopDescendants() {
    if (cleaned && (!ioWorker || ioCleaned)) {
      descendantCleanup ??= group
        .stopDescendants()
        .finally(() => application?.appCleanedUp());
    }
    return descendantCleanup;
  }
  /** Start the same bounded I/O queue as Windows, with macOS-specific adapter imports. */
  async function startIO(plugins: NativeRegistration[]) {
    if (
      !catalog.some(
        (entry) =>
          entry.thread === "worker" &&
          plugins.some((plugin) => plugin.name === entry.name),
      )
    ) {
      return;
    }
    const started = Promise.withResolvers<void>();
    ioWorker = new Worker(new URL("./host-operations.js", import.meta.url), {
      workerData: {
        app: config.app,
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
      (packet) => receiveIoPacket(packet, started),
      fail,
    );
    await started.promise;
    // Shutdown may have arrived while adapter imports were initializing.
    if (stopping) {
      stopIO();
    }
  }
  /**
   * Releases native resources once the app no longer needs them: the I/O Worker, then the UI
   * adapters, then the windows. Shared by every shutdown path, so repeated calls wait for the same
   * teardown instead of releasing twice.
   */
  function tearDownNative(): Promise<void> {
    nativeTeardown ??= (async () => {
      stopIO();
      await ioExited;
      try {
        await adapters?.dispose();
      } catch (error) {
        failure ??= error;
      }
      ui?.close();
    })();
    return nativeTeardown;
  }
  const group = await containMacosProcess((error) => {
    failure ??= error;
    if (channel) {
      beginShutdown();
    }
  });
  let worker: Worker;
  try {
    if (failure) {
      throw failure;
    }
    // The WebView version is informational: failure is logged and exposed as null.
    let webview: string | null = null;
    try {
      webview = readWebKitVersion();
    } catch (cause) {
      diagnostic("webview-version-unavailable", {
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
    worker = new Worker(new URL("./backend.js", import.meta.url), {
      workerData: {
        ...config,
        webview,
      } satisfies MacosBackendData,
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
    receiveUiPacket,
    fail,
  );
  /** Authorization requests of the I/O Worker: grant only a live call the current authority allows. */
  async function answerIoAuthorization(
    packet: Extract<
      Packet,
      {
        kind: "authorize-input" | "prepare";
      }
    >,
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
      kind: packet.kind === "authorize-input" ? "input-authorized" : "grant",
      context: packet.context,
      requestId: packet.requestId,
      allowed,
    });
  }
  /** Hands an I/O result to the backend and releases main ownership of the call. */
  async function receiveIoHostResponse(
    packet: Extract<
      Packet,
      {
        kind: "host-response";
      }
    >,
  ) {
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
  }
  async function receiveIoPacket(
    packet: Packet,
    started: {
      resolve(): void;
    },
  ) {
    switch (packet.kind) {
      case "ready":
        started.resolve();
        return;
      case "authorize-input":
      case "prepare":
        await answerIoAuthorization(packet);
        return;
      case "host-response":
        await receiveIoHostResponse(packet);
        return;
      case "cleaned":
        ioCleaned = true;
        await stopDescendants();
        return;
      case "fatal":
        fail(new Error(packet.error.message));
        return;
      default:
        throw new Error("Unexpected macOS I/O packet.");
    }
  }
  /** The backend finished startup: the UI may start unless shutdown already began. */
  function backendReady() {
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
  }
  /**
   * Collects the native plugin batches and, after the final one, validates them and creates the
   * UI adapters and the I/O Worker. Failures fail the host without rejecting, so the Channel still
   * acknowledges the registration and the backend can observe shutdown and clean up.
   */
  async function registerNativePlugins(
    packet: Extract<
      Packet,
      {
        kind: "native-register";
      }
    >,
  ) {
    if (stopping) {
      return;
    }
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
        undefined,
        {
          events: {
            emit: (event, payload, requiredOperation) =>
              ui?.emitPluginEvent(event, payload, requiredOperation),
          },
        },
      );
      if (!stopping) {
        await startIO(plugins);
      }
    } catch (error) {
      fail(error);
    }
  }
  async function receiveUiPacket(packet: Packet) {
    switch (packet.kind) {
      case "ready":
        backendReady();
        return;
      case "desktop-config":
        desktopRequests.configure({
          closeBehavior: packet.closeBehavior,
          reopenHandler: packet.reopenHandler,
        });
        return;
      case "desktop-control":
        if (packet.action !== "show") {
          // The backend rejects hide itself because macOS has no tray to hide into.
          throw new Error("macOS has no tray to hide the app into.");
        }
        if (!stopping) {
          ui?.requestShow();
        }
        return;
      case "quit-cancelled":
        desktopRequests.quitCancelled();
        return;
      case "shutdown-committed":
        // The app approved a quit (beforeQuit, or an api quit): teardown follows without a cause.
        beginShutdown();
        return;
      case "diagnostic":
        diagnostic(packet.event, packet.fields);
        return;
      case "server":
        ui?.send(packet.route, packet.message);
        return;
      case "native-register":
        await registerNativePlugins(packet);
        return;
      case "cancel":
        if (requests.context(packet.requestId) === packet.context) {
          requests.cancel(packet.requestId);
          ioCalls.delete(packet.requestId);
          ioChannel?.notify(packet);
        }
        return;
      case "operation":
        // The backend needs acceptance even while plugin parsing or execution is pending.
        void executeRequest(packet).catch(fail);
        return;
      case "exit-code":
        // Sent last, after onQuit; the backend drains its channel before the Worker exits, so the
        // code is known when `exited` settles.
        exitCode = packet.exitCode;
        relaunchIntent.request(packet.relaunch);
        return;
      case "cleaned":
        cleaned = true;
        backendCleaned.resolve();
        stopIO();
        await stopDescendants();
        return;
      case "fatal":
        fail(new Error(packet.error.message));
        return;
      default:
        throw new Error("Unexpected macOS UI packet.");
    }
  }
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
      const thread = catalog.find((plugin) =>
        packet.call.operation.startsWith(`${plugin.name}.`),
      )?.thread;
      if (thread === "worker") {
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
      // The response hides non-protocol errors from the caller as INTERNAL, so the host log is the
      // only place that keeps the operation and the original cause.
      if (!(error instanceof BunawayError)) {
        console.error(`Host operation ${packet.call.operation} failed:`, error);
      }
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

  let unrequestedExit = false;
  const startup = setTimeout(
    () => fail(new Error("macOS startup timed out.")),
    STARTUP_TIMEOUT_MS,
  );
  const onSignal = () => {
    // Also when the shutdown is already under way and the backend is not told.
    relaunchIntent.cancel();
    beginShutdown("interrupted");
  };
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
      tick: () => ui?.tick(),
      fail,
      stopping: () => stopping,
      // A Quit command waits for the backend's options like a last-window close does.
      quitRequested: () =>
        desktopRequests.defer("quit-command", () => {
          void desktopRequests.requestQuit("quit-command");
        }),
      // A session end never waits for the app's options or decision.
      sessionEnding: () => {
        relaunchIntent.cancel();
        beginShutdown("session-end");
      },
      reopened: (hasVisibleWindows) =>
        desktopRequests.reopen(hasVisibleWindows),
      openUrlsRequested: (rawUrls, receivedCount) => {
        const { urls, rejected, rejectedAll } = normalizeOpenUrls(
          rawUrls,
          receivedCount,
        );
        if (rejectedAll || rejected.length > 0) {
          // Only counts and reasons: the URLs may hold secrets.
          diagnostic("open-urls-rejected", {
            received: receivedCount,
            rejectedAll,
            rejected,
          });
        }
        if (urls.length > 0) {
          desktopRequests.openUrls(urls);
        }
      },
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
      requestContext: (requestId) => requests.context(requestId),
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
      observes: (host, call) =>
        !!registry &&
        registry.operations.has(call.operation) &&
        registry.allowed(host, call),
      nativeEvent: (packet) => channel?.send(packet) ?? Promise.resolve(),
      capacity: (count, pending) => channel?.canSend(count, pending) ?? false,
      log: diagnostic,
      fail,
      desktop: desktopRequests,
      windowsGone: () => beginShutdown("window-destroyed"),
      windowsEmpty: () =>
        channel?.notify({
          kind: "windows-empty",
        }),
    });
    await Promise.race([
      coreReady.promise,
      // A shutdown begun during startup (an approved quit, a signal) ends the wait: the backend
      // then waits for this thread's native teardown, which only the `finally` below performs.
      shutdownBegun.promise,
      backendCleaned.promise,
      exited.then((code) => {
        // Requested exits use the same cleanup and failure checks as a running app.
        if (!stopping) {
          throw new Error(`macOS backend exited during startup (${code}).`);
        }
      }),
    ]);
    if (ready && !stopping) {
      ui.start();
      clearTimeout(startup);
      // Run until the backend finished its app-level cleanup or ended. Only shutdown asks it to
      // clean up, so an end without a shutdown request was unexpected.
      await Promise.race([
        backendCleaned.promise,
        exited,
      ]);
    }
    // A shutdown begun during startup is a requested one.
    unrequestedExit = !stopping;
  } catch (error) {
    failure ??= error;
  } finally {
    clearTimeout(startup);
    beginShutdown();
    // Windows and adapters must outlive the app's shutdown hooks, Core and plugin stop hooks, so
    // teardown starts once the backend reports them done. A failed backend may never report it;
    // its exit ends the wait.
    await Promise.race([
      backendCleaned.promise,
      exited,
    ]);
    await tearDownNative();
    // The backend runs `onQuit` only after this, so the app sees native resources gone. It is not
    // awaited: a backend that is already closing never acknowledges, and its exit is awaited next.
    channel
      .send({
        kind: "native-stopped",
      })
      .catch(() => {});
    // Keep acknowledgements alive until plugin cleanup and actual Worker exit.
    const code = await exited;
    if (code !== 0 || !cleaned || unrequestedExit) {
      failure ??= new Error(`macOS backend exited without cleanup (${code}).`);
    }
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
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
      if (relaunchIntent.pending && failure === undefined) {
        // After the app, its descendants and the process group are gone. The new process waits
        // for this one to exit, so it never sees the old host's resources.
        await startReplacement();
      }
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
  return exitCode;
}

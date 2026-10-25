import type { Readable, Writable } from "node:stream";
import {
  type AppDefinition,
  type Core,
  type CoreServices,
  type CoreSession,
  createCore,
  type Platform,
} from "@bunaway/core";
import {
  BunawayError,
  type ClientMessage,
  type HostContext,
  type HostResponse,
  negotiateProtocol,
  type Policy,
  PROCESS_IPC_VERSION,
  PROTOCOL_VERSION,
  type ProcessFrame,
  parseProcessFrame,
  type RuntimeIdentity,
  resolveMaxPending,
  serializeProcessFrame,
} from "@bunaway/protocol";
import { type AppMetadata, toAppInfo } from "./app-metadata.ts";
import { LoopbackChannel } from "./loopback-channel.ts";
import { readJsonLines } from "./process-ipc.ts";

// Omit the envelope per variant so each frame keeps its required payload fields.
type OutboundFrame = ProcessFrame extends infer Frame
  ? Frame extends ProcessFrame
    ? Omit<Frame, "ipc" | "runtime">
    : never
  : never;

const PLATFORMS: Record<string, Platform> = {
  win32: "windows",
  darwin: "macos",
  linux: "linux",
  android: "android",
};

function currentPlatform(): Platform {
  const platform = PLATFORMS[process.platform];
  if (!platform) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
  return platform;
}

type FrameOf<Kind extends ProcessFrame["kind"]> = Extract<
  ProcessFrame,
  {
    kind: Kind;
  }
>;

type SessionEntry = {
  session: CoreSession;
  viewId: string;
  channelRequested: boolean;
};

type PendingCall = {
  context: HostContext;
  finish: (response: HostResponse) => void;
};

/** Frames handled once the runtime is ready; the first frame, hello, replies and shutdown are handled earlier. */
type SessionFrame = Exclude<
  ProcessFrame,
  FrameOf<"hello" | "host-response" | "shutdown">
>;

/** A boot frame with the policy and backend context the runtime cannot start without. */
function requireBootConfig(frame: ProcessFrame) {
  if (
    frame.kind !== "boot" ||
    !frame.payload.policy ||
    !frame.payload.backendContext
  ) {
    throw new Error("Host boot configuration required.");
  }
  return {
    frame,
    policy: frame.payload.policy,
    backendContext: frame.payload.backendContext,
  };
}

type BootConfig = ReturnType<typeof requireBootConfig>;

/** Process IPC state for one app: the host control pipe, core, sessions and pending host calls. */
class ProcessRuntime {
  private runtime: RuntimeIdentity | undefined;
  private core: Core | undefined;
  private booting: Promise<Core> | undefined;
  private hello = {
    kind: "hello" as const,
    protocol: PROTOCOL_VERSION,
    features: [] as string[],
    buildId: "bunaway",
  };
  private ready = false;
  private hostHelloSeen = false;
  private stopping = false;
  private sequence = 0;
  private queued = 0;
  private writer = Promise.resolve();
  private policy: Policy | undefined;
  private channel: LoopbackChannel | undefined;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly calls = new Map<string, PendingCall>();

  constructor(
    private readonly app: AppDefinition,
    private readonly metadata: AppMetadata,
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly platform: Platform,
  ) {}

  /** Pending limit from the boot policy; the default until the boot frame arrives. */
  private get maxPending(): number {
    return resolveMaxPending(this.policy);
  }

  /** Reads host frames until shutdown; any failure reports a fatal frame once the runtime booted. */
  async run(): Promise<void> {
    try {
      for await (const line of readJsonLines(this.input)) {
        if (await this.handleFrame(parseProcessFrame(line))) {
          break;
        }
      }
      if (!this.stopping) {
        throw new Error("Unexpected host EOF.");
      }
      await this.writer;
    } catch (error) {
      this.stopping = true;
      await this.channel?.close();
      this.cancelCalls();
      await this.core?.stop().catch(() => {});
      if (this.runtime) {
        await this.send({
          kind: "fatal",
          error: {
            code: "INTERNAL",
            message: "Backend IPC failed.",
          },
        }).catch(() => {});
      }
      throw error;
    } finally {
      await this.channel?.close();
      this.input.destroy();
    }
  }

  private serializeFrame(body: OutboundFrame): string {
    if (!this.runtime) {
      throw new Error("Runtime has not booted.");
    }
    return serializeProcessFrame({
      ...body,
      ipc: PROCESS_IPC_VERSION,
      runtime: this.runtime,
    });
  }

  private send(body: OutboundFrame): Promise<void> {
    const text = `${this.serializeFrame(body)}\n`;
    if (this.queued >= this.maxPending) {
      return Promise.reject(new Error("Output queue full."));
    }
    this.queued++;
    // Serialize writes so concurrent replies cannot interleave.
    this.writer = this.writer.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.output.write(text, (error) => {
            this.queued--;
            error ? reject(error) : resolve();
          });
        }),
    );
    return this.writer;
  }

  // Settle pending host calls so core work does not wait on a closed context.
  private cancelCalls(context?: string) {
    for (const [id, call] of this.calls) {
      if (context !== undefined && call.context !== context) {
        continue;
      }
      this.calls.delete(id);
      call.finish({
        kind: "error",
        error: {
          code: "CANCELLED",
          message: "Runtime context closed.",
        },
      });
    }
  }

  private async closeSession(context: string) {
    const current = this.sessions.get(context);
    this.sessions.delete(context);
    this.channel?.revoke(context as HostContext);
    await current?.session.close();
    this.cancelCalls(context);
  }

  /** Handles one host frame; resolves true once the host asked the runtime to stop. */
  private async handleFrame(frame: ProcessFrame): Promise<boolean> {
    if (frame.ipc.major !== PROCESS_IPC_VERSION.major) {
      throw new Error("Unsupported IPC version.");
    }
    if (!this.runtime) {
      return this.handleFirstFrame(frame);
    }
    if (
      frame.runtime.id !== this.runtime.id ||
      frame.runtime.generation !== this.runtime.generation
    ) {
      throw new Error("Stale runtime frame.");
    }
    if (frame.kind === "host-response") {
      this.completeHostCall(frame);
      return false;
    }
    if (frame.kind === "hello") {
      this.acceptHostHello(frame);
      return false;
    }
    if (frame.kind === "shutdown") {
      await this.shutdown();
      return true;
    }
    if (!this.ready || !this.core) {
      throw new Error("Runtime not ready.");
    }
    await this.handleSessionFrame(frame, this.core);
    return false;
  }

  /** Before boot only a boot frame configures the runtime; an early shutdown just acknowledges. */
  private async handleFirstFrame(frame: ProcessFrame): Promise<boolean> {
    if (frame.kind === "shutdown") {
      this.runtime = frame.runtime;
      this.stopping = true;
      await this.send({
        kind: "stopping",
      });
      return true;
    }
    await this.boot(requireBootConfig(frame));
    return false;
  }

  private async boot(config: BootConfig) {
    const { frame, policy } = config;
    this.runtime = frame.runtime;
    this.policy = policy;
    this.hello = {
      ...this.hello,
      buildId: frame.payload.buildId,
    };
    await this.send({
      kind: "hello",
      payload: this.hello,
    });
    // Keep reading responses while core setup runs plugin callbacks.
    const booting = createCore(this.app, this.coreServices(config));
    this.booting = booting;
    // Report initialization failures even while the reader waits for hello.
    void booting.catch(() => {
      if (!this.stopping) {
        this.input.destroy(new Error("Core initialization failed."));
      }
    });
  }

  private coreServices(config: BootConfig): CoreServices {
    return {
      // These runtimes have no host-reported WebView engine version.
      app: toAppInfo(this.metadata, {
        bun: Bun.version,
        webview: null,
      }),
      policy: config.policy,
      hello: this.hello,
      platform: this.platform,
      backendContext: config.backendContext as HostContext,
      onCommandError: (command, cause) =>
        console.error(`Command ${command} failed:`, cause),
      onPluginError: (plugin, phase, cause) => {
        if (
          this.stopping &&
          phase === "setup" &&
          cause instanceof BunawayError &&
          cause.code === "CANCELLED"
        ) {
          return;
        }
        console.error(`Plugin ${plugin} ${phase} failed:`, cause);
      },
      runtime: {
        createCancellation: () => new AbortController(),
        now: () => Date.now(),
        schedule: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      validateMessage: (context, message) => {
        if (this.channel?.owns(context)) {
          // Core already checked the web message; only pipe delivery adds an envelope.
          return;
        }
        this.serializeFrame({
          kind: "web",
          context,
          payload: message,
        });
      },
      send: async (context, message) => {
        if (!this.sessions.has(context) || this.stopping) {
          return;
        }
        if (this.channel?.owns(context)) {
          this.channel.send(context, message);
          return;
        }
        await this.send({
          kind: "web",
          context,
          payload: message,
        });
      },
      callHost: (context, call, signal) => this.callHost(context, call, signal),
    };
  }

  /** Sends a host request and resolves with the reply matched by request id and context. */
  private callHost(
    ...args: Parameters<CoreServices["callHost"]>
  ): Promise<HostResponse> {
    const [context, call, signal] = args;
    if (this.stopping || signal.aborted) {
      return Promise.reject(
        new BunawayError({
          code: "CANCELLED",
          message: "Host operation cancelled.",
        }),
      );
    }
    if (this.calls.size >= this.maxPending) {
      return Promise.reject(
        new BunawayError({
          code: "BUSY",
          message: "Host request limit reached.",
        }),
      );
    }
    const requestId = `host-${++this.sequence}`;
    // Match replies by request and context, freeing the slot on abort.
    return new Promise<HostResponse>((resolve, reject) => {
      const abort = () => {
        if (!this.calls.delete(requestId)) {
          return;
        }
        signal.removeEventListener("abort", abort);
        void this.send({
          kind: "host-cancel",
          context,
          requestId,
        }).catch(reject);
        reject(
          new BunawayError({
            code: "CANCELLED",
            message: "Host operation cancelled.",
          }),
        );
      };
      this.calls.set(requestId, {
        context,
        finish: (response) => {
          signal.removeEventListener("abort", abort);
          resolve(response);
        },
      });
      signal.addEventListener("abort", abort);
      void this.send({
        kind: "host-request",
        context,
        requestId,
        ...call,
      }).catch((error) => {
        this.calls.delete(requestId);
        signal.removeEventListener("abort", abort);
        reject(error);
      });
    });
  }

  private completeHostCall(frame: FrameOf<"host-response">) {
    // Ignore late responses after cancellation or session closure.
    const call = this.calls.get(frame.requestId);
    if (call?.context === frame.context) {
      this.calls.delete(frame.requestId);
      call.finish(frame.payload);
    }
  }

  private acceptHostHello(frame: FrameOf<"hello">) {
    if (this.hostHelloSeen) {
      throw new Error("Duplicate host hello.");
    }
    this.hostHelloSeen = true;
    negotiateProtocol(this.hello, frame.payload);
    // Do not block host-response dispatch during asynchronous plugin setup.
    void this.booting
      ?.then(async (created) => {
        this.core = created;
        if (this.stopping) {
          return;
        }
        await this.send({
          kind: "ready",
          pid: process.pid,
          bunVersion: Bun.version,
          revision: Bun.revision,
        });
        this.ready = true;
      })
      .catch(() => {
        if (!this.stopping) {
          this.input.destroy(new Error("Core startup failed."));
        }
      });
  }

  private async shutdown() {
    // Stop work before cleanup, then send stopping when cleanup completes.
    this.stopping = true;
    await this.channel?.close();
    this.cancelCalls();
    this.core ??= await this.booting?.catch(() => undefined);
    await this.core?.stop();
    this.cancelCalls();
    this.sessions.clear();
    await this.send({
      kind: "stopping",
    });
  }

  private async handleSessionFrame(frame: SessionFrame, core: Core) {
    if (frame.kind === "session-open") {
      this.openSession(frame, core);
    } else if (frame.kind === "channel-open") {
      await this.openChannel(frame);
    } else if (
      frame.kind === "revoke" ||
      (frame.kind === "web" && frame.payload.kind === "close")
    ) {
      await this.closeSession(frame.context);
    } else if (frame.kind === "web") {
      await this.receiveWeb(frame);
    } else {
      throw new Error("Unexpected host frame.");
    }
  }

  private openSession(frame: FrameOf<"session-open">, core: Core) {
    if (this.sessions.has(frame.context)) {
      throw new Error("Duplicate session context.");
    }
    if (this.sessions.size >= this.maxPending) {
      throw new Error("Session limit reached.");
    }
    this.sessions.set(frame.context, {
      session: core.openSession(frame.context as HostContext, frame.viewId),
      viewId: frame.viewId,
      channelRequested: false,
    });
  }

  /** Grants one direct document channel to a session whose view allows the requesting origin. */
  private async openChannel(frame: FrameOf<"channel-open">) {
    const current = this.sessions.get(frame.context);
    const view = this.policy?.views.find((view) => view.id === current?.viewId);
    if (
      !current ||
      current.channelRequested ||
      !view?.origins.includes(frame.origin)
    ) {
      throw new Error("Invalid document channel request.");
    }
    current.channelRequested = true;
    this.channel ??= this.createChannel();
    await this.send({
      kind: "channel-ready",
      context: frame.context,
      nonce: frame.nonce,
      // WKWebView serializes the packaged iOS origin with its asset scheme.
      // Authorization above still uses the shared HTTPS policy origin.
      url:
        this.channel?.grant(
          frame.context as HostContext,
          this.platform === "ios"
            ? frame.origin.replace(/^https:/, "bunaway:")
            : frame.origin,
        ) ?? "",
    });
  }

  private createChannel(): LoopbackChannel | undefined {
    try {
      return new LoopbackChannel(
        {
          receive: async (context, message) => {
            const active = this.sessions.get(context);
            if (!active || this.stopping) {
              throw new Error("Document session closed.");
            }
            await active.session.receive(message);
          },
          disconnected: (context) => {
            // Document transport failures revoke that session, not the host control pipe.
            void this.closeSession(context).catch(() =>
              this.input.destroy(new Error("Document cleanup failed.")),
            );
          },
        },
        this.maxPending,
      );
    } catch {
      // A mobile host can retain its native bridge when the listener is unavailable.
      return undefined;
    }
  }

  private async receiveWeb(frame: FrameOf<"web">) {
    const session = this.sessions.get(frame.context)?.session;
    if (!session) {
      throw new Error("Unknown session context.");
    }
    if (this.channel?.owns(frame.context as HostContext)) {
      throw new Error("Document uses a direct channel.");
    }
    if (
      ![
        "hello",
        "invoke",
        "cancel",
        "listen",
        "unlisten",
      ].includes(frame.payload.kind)
    ) {
      throw new Error("Invalid web direction.");
    }
    await session.receive(frame.payload as ClientMessage);
  }
}

/**
 * Runs an app over the host's IPC connection, defaulting to process stdin/stdout.
 * Embedded Workers supply their own streams and platform. This function closes
 * the owned input on completion or failure; the caller retains output ownership.
 * Keeps reading while core work waits for host replies.
 * The host sends boot configuration and controls session lifetime and shutdown.
 * The host and runtime exchange hello messages and negotiate the protocol.
 * Rejects malformed or unexpected host frames and unexpected end of control input.
 * Direct document connection failures revoke only their own session.
 */
export async function runBunApp(
  app: AppDefinition,
  connection: {
    /**
     * App name, identifier, package versions, `isPackaged` and `paths` exposed as `ctx.app`.
     * Process runtimes have no file system package, so builds pass `paths: null`.
     */
    app: AppMetadata;
    input?: Readable;
    output?: Writable;
    platform?: Platform;
  },
): Promise<void> {
  const {
    input = process.stdin,
    output = process.stdout,
    platform = currentPlatform(),
  } = connection;
  if (app.desktop !== undefined) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Desktop lifecycle requires the Windows Bun host.",
    });
  }
  await new ProcessRuntime(app, connection.app, input, output, platform).run();
}

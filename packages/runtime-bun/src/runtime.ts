import {
  type AppDefinition,
  type Core,
  type CoreSession,
  createCore,
  type Platform,
} from "@bunaway/core";
import {
  API_LIMITS,
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
  serializeProcessFrame,
} from "@bunaway/protocol";
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

/**
 * Runs an app over the host's stdin/stdout IPC connection.
 * Keeps reading while core work waits for host replies.
 * The host sends boot configuration and controls session lifetime and shutdown.
 * The host and runtime exchange hello messages and negotiate the protocol.
 * Rejects malformed or unexpected host frames and unexpected end of control input.
 * Direct document connection failures revoke only their own session.
 */
export async function runBunApp(app: AppDefinition): Promise<void> {
  if (app.desktop !== undefined) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Desktop lifecycle requires the Windows Bun host.",
    });
  }
  let runtime: RuntimeIdentity | undefined;
  let core: Core | undefined;
  let booting: Promise<Core> | undefined;
  let hello = {
    kind: "hello" as const,
    protocol: PROTOCOL_VERSION,
    features: [] as string[],
    buildId: "bunaway",
  };
  let ready = false;
  let hostHelloSeen = false;
  let stopping = false;
  let sequence = 0;
  let queued = 0;
  let writer = Promise.resolve();
  let policy: Policy | undefined;
  let channel: LoopbackChannel | undefined;
  const sessions = new Map<
    string,
    {
      session: CoreSession;
      viewId: string;
      channelRequested: boolean;
    }
  >();
  const calls = new Map<
    string,
    {
      context: HostContext;
      finish: (response: HostResponse) => void;
    }
  >();
  const serializeFrame = (body: OutboundFrame): string => {
    if (!runtime) {
      throw new Error("Runtime has not booted.");
    }
    return serializeProcessFrame({
      ...body,
      ipc: PROCESS_IPC_VERSION,
      runtime,
    });
  };
  const send = (body: OutboundFrame): Promise<void> => {
    const text = `${serializeFrame(body)}\n`;
    if (queued >= API_LIMITS.maxPending) {
      return Promise.reject(new Error("Output queue full."));
    }
    queued++;
    // Serialize writes so concurrent replies cannot interleave.
    writer = writer.then(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdout.write(text, (error) => {
            queued--;
            error ? reject(error) : resolve();
          });
        }),
    );
    return writer;
  };
  // Settle pending host calls so core work does not wait on a closed context.
  const cancelCalls = (context?: string) => {
    for (const [id, call] of calls) {
      if (context !== undefined && call.context !== context) {
        continue;
      }
      calls.delete(id);
      call.finish({
        kind: "error",
        error: {
          code: "CANCELLED",
          message: "Runtime context closed.",
        },
      });
    }
  };
  const closeSession = async (context: string) => {
    const current = sessions.get(context);
    sessions.delete(context);
    channel?.revoke(context as HostContext);
    await current?.session.close();
    cancelCalls(context);
  };
  try {
    for await (const line of readJsonLines(process.stdin)) {
      const frame = parseProcessFrame(line);
      if (frame.ipc.major !== PROCESS_IPC_VERSION.major) {
        throw new Error("Unsupported IPC version.");
      }
      if (!runtime) {
        if (frame.kind === "shutdown") {
          runtime = frame.runtime;
          stopping = true;
          await send({
            kind: "stopping",
          });
          break;
        }
        if (
          frame.kind !== "boot" ||
          !frame.payload.policy ||
          !frame.payload.backendContext
        ) {
          throw new Error("Host boot configuration required.");
        }
        runtime = frame.runtime;
        policy = frame.payload.policy;
        hello = {
          ...hello,
          buildId: frame.payload.buildId,
        };
        await send({
          kind: "hello",
          payload: hello,
        });
        // Keep reading responses while core setup runs plugin callbacks.
        booting = createCore(app, {
          policy: frame.payload.policy,
          hello,
          platform: currentPlatform(),
          backendContext: frame.payload.backendContext as HostContext,
          onCommandError: (command, cause) =>
            console.error(`Command ${command} failed:`, cause),
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
          },
          runtime: {
            createCancellation: () => new AbortController(),
            now: () => Date.now(),
            schedule: (callback, delay) => {
              const timer = setTimeout(callback, delay);
              return () => clearTimeout(timer);
            },
          },
          validateMessage(context, message) {
            if (channel?.owns(context)) {
              // Core already checked the web message; only pipe delivery adds an envelope.
              return;
            }
            serializeFrame({
              kind: "web",
              context,
              payload: message,
            });
          },
          send: async (context, message) => {
            if (sessions.has(context) && !stopping) {
              if (channel?.owns(context)) {
                channel.send(context, message);
                return;
              }
              await send({
                kind: "web",
                context,
                payload: message,
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
            if (calls.size >= API_LIMITS.maxPending) {
              return Promise.reject(
                new BunawayError({
                  code: "BUSY",
                  message: "Host request limit reached.",
                }),
              );
            }
            const requestId = `host-${++sequence}`;
            // Match replies by request and context, freeing the slot on abort.
            return new Promise<HostResponse>((resolve, reject) => {
              const abort = () => {
                if (!calls.delete(requestId)) {
                  return;
                }
                signal.removeEventListener("abort", abort);
                void send({
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
              calls.set(requestId, {
                context,
                finish: (response) => {
                  signal.removeEventListener("abort", abort);
                  resolve(response);
                },
              });
              signal.addEventListener("abort", abort);
              void send({
                kind: "host-request",
                context,
                requestId,
                ...call,
              }).catch((error) => {
                calls.delete(requestId);
                signal.removeEventListener("abort", abort);
                reject(error);
              });
            });
          },
        });
        // Report initialization failures even while the reader waits for hello.
        void booting.catch(() => {
          if (!stopping) {
            process.stdin.destroy(new Error("Core initialization failed."));
          }
        });
        continue;
      }
      if (
        frame.runtime.id !== runtime.id ||
        frame.runtime.generation !== runtime.generation
      ) {
        throw new Error("Stale runtime frame.");
      }
      if (frame.kind === "host-response") {
        // Ignore late responses after cancellation or session closure.
        const call = calls.get(frame.requestId);
        if (call?.context === frame.context) {
          calls.delete(frame.requestId);
          call.finish(frame.payload);
        }
        continue;
      }
      if (frame.kind === "hello") {
        if (hostHelloSeen) {
          throw new Error("Duplicate host hello.");
        }
        hostHelloSeen = true;
        negotiateProtocol(hello, frame.payload);
        // Do not block host-response dispatch during asynchronous plugin setup.
        void booting
          ?.then(async (created) => {
            core = created;
            if (stopping) {
              return;
            }
            await send({
              kind: "ready",
              pid: process.pid,
              bunVersion: Bun.version,
              revision: Bun.revision,
            });
            ready = true;
          })
          .catch(() => {
            if (!stopping) {
              process.stdin.destroy(new Error("Core startup failed."));
            }
          });
        continue;
      }
      if (frame.kind === "shutdown") {
        // Stop work before cleanup, then send stopping when cleanup completes.
        stopping = true;
        await channel?.close();
        cancelCalls();
        core ??= await booting?.catch(() => undefined);
        await core?.stop();
        cancelCalls();
        sessions.clear();
        await send({
          kind: "stopping",
        });
        break;
      }
      if (!ready || !core) {
        throw new Error("Runtime not ready.");
      }
      if (frame.kind === "session-open") {
        if (sessions.has(frame.context)) {
          throw new Error("Duplicate session context.");
        }
        if (sessions.size >= API_LIMITS.maxPending) {
          throw new Error("Session limit reached.");
        }
        sessions.set(frame.context, {
          session: core.openSession(frame.context as HostContext, frame.viewId),
          viewId: frame.viewId,
          channelRequested: false,
        });
      } else if (frame.kind === "channel-open") {
        const current = sessions.get(frame.context);
        const view = policy?.views.find((view) => view.id === current?.viewId);
        if (
          !current ||
          current.channelRequested ||
          !view?.origins.includes(frame.origin)
        ) {
          throw new Error("Invalid document channel request.");
        }
        current.channelRequested = true;
        if (!channel) {
          try {
            channel = new LoopbackChannel({
              receive: async (context, message) => {
                const active = sessions.get(context);
                if (!active || stopping) {
                  throw new Error("Document session closed.");
                }
                await active.session.receive(message);
              },
              disconnected(context) {
                // Document transport failures revoke that session, not the host control pipe.
                void closeSession(context).catch(() =>
                  process.stdin.destroy(new Error("Document cleanup failed.")),
                );
              },
            });
          } catch {
            // Existing Android projects may lack loopback network permission; keep their bridge.
          }
        }
        await send({
          kind: "channel-ready",
          context: frame.context,
          nonce: frame.nonce,
          url: channel?.grant(frame.context as HostContext, frame.origin) ?? "",
        });
      } else if (
        frame.kind === "revoke" ||
        (frame.kind === "web" && frame.payload.kind === "close")
      ) {
        await closeSession(frame.context);
      } else if (frame.kind === "web") {
        const current = sessions.get(frame.context);
        const session = current?.session;
        if (!session) {
          throw new Error("Unknown session context.");
        }
        if (channel?.owns(frame.context as HostContext)) {
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
      } else {
        throw new Error("Unexpected host frame.");
      }
    }
    if (!stopping) {
      throw new Error("Unexpected host EOF.");
    }
    await writer;
  } catch (error) {
    stopping = true;
    await channel?.close();
    cancelCalls();
    await core?.stop().catch(() => {});
    if (runtime) {
      await send({
        kind: "fatal",
        error: {
          code: "INTERNAL",
          message: "Backend IPC failed.",
        },
      }).catch(() => {});
    }
    throw error;
  } finally {
    await channel?.close();
    process.stdin.destroy();
  }
}

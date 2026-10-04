import { createCore, type AppDefinition, type Core, type CoreSession } from "@bunaway/core";
import {
  API_LIMITS,
  BunawayError,
  type ClientMessage,
  type HostContext,
  type HostResponse,
  type ProcessFrame,
  type RuntimeIdentity,
  PROCESS_IPC_VERSION,
  PROTOCOL_VERSION,
  negotiateProtocol,
  parseProcessFrame,
  serializeProcessFrame,
} from "@bunaway/protocol";
import { readJsonLines } from "./process-ipc.ts";

// Keep the reader free while core setup/commands await replies on the same pipe.
export async function runBunApp(app: AppDefinition): Promise<void> {
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
  const sessions = new Map<string, CoreSession>();
  const calls = new Map<
    string,
    { context: HostContext; finish: (response: HostResponse) => void }
  >();
  const send = (body: Record<string, unknown>): Promise<void> => {
    if (!runtime) return Promise.reject(new Error("Runtime has not booted."));
    const text = `${serializeProcessFrame({ ...body, ipc: PROCESS_IPC_VERSION, runtime } as ProcessFrame)}\n`;
    if (queued >= API_LIMITS.maxPending) return Promise.reject(new Error("Output queue full."));
    queued++;
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
  const cancelCalls = (context?: string) => {
    for (const [id, call] of calls) {
      if (context !== undefined && call.context !== context) continue;
      calls.delete(id);
      call.finish({
        kind: "error",
        error: { code: "CANCELLED", message: "Runtime context closed." },
      });
    }
  };
  try {
    for await (const line of readJsonLines(process.stdin)) {
      const frame = parseProcessFrame(line);
      if (frame.ipc.major !== PROCESS_IPC_VERSION.major)
        throw new Error("Unsupported IPC version.");
      if (!runtime) {
        if (frame.kind === "shutdown") {
          runtime = frame.runtime;
          stopping = true;
          await send({ kind: "stopping" });
          break;
        }
        if (frame.kind !== "boot" || !frame.payload.policy || !frame.payload.backendContext)
          throw new Error("Host boot configuration required.");
        runtime = frame.runtime;
        hello = { ...hello, buildId: frame.payload.buildId };
        await send({ kind: "hello", payload: hello });
        booting = createCore(app, {
          policy: frame.payload.policy,
          hello,
          platform: "windows",
          backendContext: frame.payload.backendContext as HostContext,
          runtime: {
            createCancellation: () => new AbortController(),
            now: () => Date.now(),
            schedule: (callback, delay) => {
              const timer = setTimeout(callback, delay);
              return () => clearTimeout(timer);
            },
          },
          send: async (context, message) => {
            if (sessions.has(context) && !stopping)
              await send({ kind: "web", context, payload: message });
          },
          callHost: (context, call, signal) => {
            if (stopping || signal.aborted)
              return Promise.reject(
                new BunawayError({ code: "CANCELLED", message: "Host operation cancelled." }),
              );
            if (calls.size >= API_LIMITS.maxPending)
              return Promise.reject(
                new BunawayError({ code: "BUSY", message: "Host request limit reached." }),
              );
            const requestId = `host-${++sequence}`;
            return new Promise<HostResponse>((resolve, reject) => {
              const abort = () => {
                if (!calls.delete(requestId)) return;
                signal.removeEventListener("abort", abort);
                void send({ kind: "host-cancel", context, requestId }).catch(reject);
                reject(
                  new BunawayError({ code: "CANCELLED", message: "Host operation cancelled." }),
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
              void send({ kind: "host-request", context, requestId, ...call }).catch((error) => {
                calls.delete(requestId);
                signal.removeEventListener("abort", abort);
                reject(error);
              });
            });
          },
        });
        // Report initialization failures even while the reader waits for hello.
        void booting.catch(() => {
          if (!stopping) process.stdin.destroy(new Error("Core initialization failed."));
        });
        continue;
      }
      if (frame.runtime.id !== runtime.id || frame.runtime.generation !== runtime.generation)
        throw new Error("Stale runtime frame.");
      if (frame.kind === "host-response") {
        const call = calls.get(frame.requestId);
        if (call?.context === frame.context) {
          calls.delete(frame.requestId);
          call.finish(frame.payload);
        }
        continue;
      }
      if (frame.kind === "hello") {
        if (hostHelloSeen) throw new Error("Duplicate host hello.");
        hostHelloSeen = true;
        negotiateProtocol(hello, frame.payload);
        // Do not block host-response dispatch during asynchronous plugin setup.
        void booting
          ?.then(async (created) => {
            core = created;
            if (stopping) return;
            await send({
              kind: "ready",
              pid: process.pid,
              bunVersion: Bun.version,
              revision: Bun.revision,
            });
            ready = true;
          })
          .catch(() => {
            if (!stopping) process.stdin.destroy(new Error("Core startup failed."));
          });
        continue;
      }
      if (frame.kind === "shutdown") {
        stopping = true;
        cancelCalls();
        core ??= await booting?.catch(() => undefined);
        await core?.stop();
        cancelCalls();
        sessions.clear();
        await send({ kind: "stopping" });
        break;
      }
      if (!ready || !core) throw new Error("Runtime not ready.");
      if (frame.kind === "session-open") {
        if (sessions.has(frame.context)) throw new Error("Duplicate session context.");
        if (sessions.size >= API_LIMITS.maxPending) throw new Error("Session limit reached.");
        sessions.set(frame.context, core.openSession(frame.context as HostContext, frame.viewId));
      } else if (frame.kind === "revoke") {
        const session = sessions.get(frame.context);
        sessions.delete(frame.context);
        await session?.close();
        cancelCalls(frame.context);
      } else if (frame.kind === "web") {
        const session = sessions.get(frame.context);
        if (!session) throw new Error("Unknown session context.");
        if (!["hello", "invoke", "cancel", "listen", "unlisten"].includes(frame.payload.kind))
          throw new Error("Invalid web direction.");
        await session.receive(frame.payload as ClientMessage);
      } else throw new Error("Unexpected host frame.");
    }
    if (!stopping) throw new Error("Unexpected host EOF.");
    await writer;
  } catch (error) {
    stopping = true;
    cancelCalls();
    await core?.stop().catch(() => {});
    if (runtime)
      await send({
        kind: "fatal",
        error: { code: "INTERNAL", message: "Backend IPC failed." },
      }).catch(() => {});
    throw error;
  } finally {
    process.stdin.destroy();
  }
}

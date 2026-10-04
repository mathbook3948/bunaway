// Minimal contract backend for verifying the Windows host boundary while the
// client-sdk/core implementations are still pending. Implements the process IPC
// contract (boot/hello/ready/session-open/web/host-*/revoke/shutdown) with a small
// set of test commands. Not the product runtime.
import {
  negotiateProtocol,
  parseProcessFrame,
  PROCESS_IPC_VERSION,
  PROTOCOL_VERSION,
  serializeProcessFrame,
  type Hello,
  type HostOperation,
  type JsonValue,
  type Message,
  type ProcessFrame,
} from "../../../../packages/protocol/src/index.ts";
import { readJsonLines } from "../../../../packages/runtime-bun/src/process-ipc.ts";

const hello: Hello = {
  kind: "hello",
  protocol: PROTOCOL_VERSION,
  features: [],
  buildId: "minimal-contract-backend",
};
let runtime: { id: string; generation: string } | undefined;
let backendContext = "";
let ready = false;
let stopping = false;
let invokeCount = 0;
let hostSeq = 0;
let subSeq = 0;
let writer = Promise.resolve();
let queued = 0;

interface Session {
  viewId: string;
  negotiated: boolean;
  held: Set<string>;
  subscriptions: Map<string, { event: string; sequence: number }>;
}
const sessions = new Map<string, Session>();
const hostCalls = new Map<string, { context: string; resolve: (value: JsonValue) => void }>();

function send(frame: ProcessFrame): Promise<void> {
  const line = `${serializeProcessFrame(frame)}\n`;
  if (queued >= 128) throw new Error("Output queue full.");
  queued++;
  writer = writer.then(
    () =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(line, (cause) => {
          queued--;
          if (cause) reject(cause);
          else resolve();
        });
      }),
  );
  return writer;
}

function web(context: string, message: Message): Promise<void> {
  if (!runtime) throw new Error("No runtime.");
  return send({ kind: "web", ipc: PROCESS_IPC_VERSION, runtime, context, payload: message });
}

function result(context: string, id: string, payload: JsonValue) {
  return web(context, { kind: "result", protocol: PROTOCOL_VERSION, id, payload });
}

function error(context: string, id: string, code: string, message: string) {
  return web(context, {
    kind: "error",
    protocol: PROTOCOL_VERSION,
    id,
    error: { code: code as never, message },
  });
}

// Resolves to the raw host outcome so tests can observe real denials.
function hostCall(
  context: string,
  operation: HostOperation,
  payload: JsonValue,
): Promise<JsonValue> {
  if (!runtime) throw new Error("No runtime.");
  const requestId = `hr-${++hostSeq}`;
  const done = new Promise<JsonValue>((resolve) => hostCalls.set(requestId, { context, resolve }));
  void send({
    kind: "host-request",
    ipc: PROCESS_IPC_VERSION,
    runtime,
    context,
    requestId,
    operation,
    payload,
  });
  return done;
}

async function respondHost(
  context: string,
  id: string,
  operation: HostOperation,
  payload: JsonValue,
) {
  const outcome = await hostCall(context, operation, payload);
  if (outcome && typeof outcome === "object" && "__hostError" in outcome) {
    const { __hostError: denied } = outcome as { __hostError: { code: string; message: string } };
    return result(context, id, { ok: false, code: denied.code });
  }
  return result(context, id, { ok: true, value: outcome });
}

async function dispatchInvoke(
  context: string,
  session: Session,
  message: Extract<Message, { kind: "invoke" }>,
) {
  invokeCount++;
  const payload = message.payload as Record<string, JsonValue> | null;
  switch (message.command) {
    case "test.echo":
      return result(context, message.id, message.payload);
    case "test.ping":
      return result(context, message.id, "pong");
    case "test.count":
      return result(context, message.id, invokeCount);
    case "test.hold":
      session.held.add(message.id);
      return;
    case "test.writeNote":
      return respondHost(context, message.id, "storage.writeText", {
        scope: "appData",
        path: `notes/${payload?.name ?? "a"}.txt`,
        text: payload?.text ?? "",
      });
    case "test.readNote":
      return respondHost(context, message.id, "storage.readText", {
        scope: "appData",
        path: `notes/${payload?.name ?? "a"}.txt`,
      });
    case "test.readEscape":
      return respondHost(context, message.id, "storage.readText", {
        scope: "appData",
        path: String(payload?.path ?? "secrets/x.txt"),
      });
    case "test.tempRead":
      return respondHost(context, message.id, "storage.readText", {
        scope: "temp",
        path: String(payload?.path ?? "scratch.txt"),
      });
    case "test.tempWrite":
      return respondHost(context, message.id, "storage.writeText", {
        scope: "temp",
        path: String(payload?.path ?? "scratch.txt"),
        text: String(payload?.text ?? ""),
      });
    case "test.capabilities":
      return respondHost(context, message.id, "capabilities.get", null);
    case "test.log":
      return respondHost(context, message.id, "log.write", {
        level: "info",
        message: String(payload?.message ?? "log-test"),
        details: payload?.details ?? null,
      });
    case "test.emit": {
      for (const [targetContext, target] of sessions) {
        for (const [subscriptionId, sub] of target.subscriptions) {
          await web(targetContext, {
            kind: "event",
            protocol: PROTOCOL_VERSION,
            subscriptionId,
            source: "backend",
            target: target.viewId,
            event: sub.event,
            sequence: ++sub.sequence,
            payload: message.payload,
          });
        }
      }
      return result(context, message.id, null);
    }
    case "test.hostCancel": {
      if (!runtime) throw new Error("No runtime.");
      const rt = runtime;
      const requestId = `hr-${++hostSeq}`;
      const done = new Promise<JsonValue>((resolve) =>
        hostCalls.set(requestId, { context, resolve }),
      );
      void send({
        kind: "host-request",
        ipc: PROCESS_IPC_VERSION,
        runtime: rt,
        context,
        requestId,
        operation: "storage.readText",
        payload: { scope: "temp", path: "cancel-me.txt" },
      });
      void send({
        kind: "host-cancel",
        ipc: PROCESS_IPC_VERSION,
        runtime: rt,
        context,
        requestId,
      });
      const outcome = await Promise.race([
        done,
        new Promise<string>((resolve) => setTimeout(() => resolve("no-response"), 1500)),
      ]);
      hostCalls.delete(requestId);
      return result(context, message.id, { outcome });
    }
    case "test.report":
      return respondHost(context, message.id, "storage.writeText", {
        scope: "temp",
        path: String(payload?.file ?? "report.json"),
        text: JSON.stringify(payload?.report ?? null),
      });
    default:
      return error(context, message.id, "INVALID_ARGUMENT", "Unknown test command.");
  }
}

async function dispatch(frame: ProcessFrame) {
  if (!runtime) {
    if (frame.kind !== "boot") throw new Error("First frame must be boot.");
    runtime = frame.runtime;
    backendContext = frame.payload.backendContext ?? "";
    await send({ kind: "hello", ipc: PROCESS_IPC_VERSION, runtime, payload: hello });
    return;
  }
  if (frame.runtime.id !== runtime.id || frame.runtime.generation !== runtime.generation) {
    throw new Error("Stale runtime.");
  }
  if (frame.kind === "shutdown") {
    stopping = true;
    for (const [context, session] of sessions) {
      for (const id of session.held) await error(context, id, "CANCELLED", "Runtime stopped.");
    }
    for (const [, pending] of hostCalls) {
      pending.resolve({ __hostError: { code: "CANCELLED", message: "Runtime stopped." } });
    }
    hostCalls.clear();
    sessions.clear();
    await send({ kind: "stopping", ipc: PROCESS_IPC_VERSION, runtime });
    process.stdin.destroy();
    return;
  }
  if (frame.kind === "hello") {
    negotiateProtocol(hello, frame.payload);
    ready = true;
    await send({
      kind: "ready",
      ipc: PROCESS_IPC_VERSION,
      runtime,
      pid: process.pid,
      bunVersion: Bun.version,
      revision: Bun.revision,
    });
    return;
  }
  if (!ready || stopping) throw new Error("Runtime not ready.");
  if (frame.kind === "session-open") {
    if (sessions.has(frame.context)) throw new Error("Duplicate session context.");
    sessions.set(frame.context, {
      viewId: frame.viewId,
      negotiated: false,
      held: new Set(),
      subscriptions: new Map(),
    });
    return;
  }
  if (frame.kind === "revoke") {
    sessions.delete(frame.context);
    for (const [requestId, pending] of hostCalls) {
      if (pending.context === frame.context) {
        hostCalls.delete(requestId);
        pending.resolve({ __hostError: { code: "CANCELLED", message: "Session revoked." } });
      }
    }
    return;
  }
  if (frame.kind === "host-response") {
    const pending = hostCalls.get(frame.requestId);
    if (!pending) return; // late or cancelled host results are discarded
    hostCalls.delete(frame.requestId);
    const body = frame.payload;
    pending.resolve(body.kind === "result" ? body.payload : { __hostError: body.error });
    return;
  }
  if (frame.kind !== "web") throw new Error(`Unexpected frame: ${frame.kind}`);
  const session = sessions.get(frame.context);
  if (!session || frame.context === backendContext) throw new Error("Unknown session context.");
  const message = frame.payload;
  if (message.kind === "hello") {
    if (session.negotiated) throw new Error("Duplicate hello.");
    session.negotiated = true;
    await web(frame.context, { ...hello });
    return;
  }
  if (!session.negotiated) throw new Error("Unnegotiated session message.");
  if (message.kind === "invoke") {
    await dispatchInvoke(frame.context, session, message);
    return;
  }
  if (message.kind === "cancel") {
    const target = sessions.get(frame.context);
    if (target?.held.has(message.id)) {
      target.held.delete(message.id);
      await error(frame.context, message.id, "CANCELLED", "Request cancelled.");
    }
    return;
  }
  if (message.kind === "listen") {
    if (session.subscriptions.size >= 128)
      return error(frame.context, message.id, "BUSY", "Too many subscriptions.");
    if (message.event !== "test.changed")
      return error(frame.context, message.id, "INVALID_ARGUMENT", "Unknown event.");
    const subscriptionId = `sub-${++subSeq}`;
    session.subscriptions.set(subscriptionId, { event: message.event, sequence: 0 });
    return result(frame.context, message.id, { subscriptionId });
  }
  if (message.kind === "unlisten") {
    session.subscriptions.delete(message.subscriptionId);
    return result(frame.context, message.id, null);
  }
  throw new Error("Invalid client message.");
}

async function fatal() {
  try {
    await send({
      kind: "fatal",
      ipc: PROCESS_IPC_VERSION,
      runtime: runtime ?? { id: "unknown", generation: "0" },
      error: { code: "INTERNAL", message: "Backend IPC failed." },
    });
  } finally {
    process.exit(1);
  }
}

const invokeTasks = new Set<Promise<void>>();

try {
  for await (const line of readJsonLines(process.stdin)) {
    const frame = parseProcessFrame(line);
    // An invoke can await a host-request round trip, and that host-response can
    // only arrive through this same stdin stream. Blocking the loop on it
    // deadlocks, so invokes run detached; every other frame stays inline to
    // preserve ordering.
    if (frame.kind === "web" && frame.payload.kind === "invoke" && ready && !stopping) {
      const task = dispatch(frame).catch(() => fatal());
      invokeTasks.add(task);
      void task.finally(() => invokeTasks.delete(task));
      continue;
    }
    await dispatch(frame);
    if (stopping) break;
  }
  if (!stopping) throw new Error("Unexpected host EOF.");
  await Promise.allSettled([...invokeTasks]);
  await writer;
} catch {
  await fatal();
}

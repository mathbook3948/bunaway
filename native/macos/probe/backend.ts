import { closeSync, fstatSync, readdirSync } from "node:fs";
import {
  negotiateProtocol,
  parseProcessFrame,
  PROCESS_IPC_VERSION,
  PROTOCOL_VERSION,
  ProtocolError,
  serializeProcessFrame,
  type JsonValue,
  type Hello,
  type Message,
  type ProcessFrame,
} from "../../../packages/protocol/src/index.ts";
import { readJsonLines } from "../../../packages/runtime-bun/src/process-ipc.ts";

const runtime = { id: "probe", generation: "1" };
const mode = process.argv.at(-1);
const hello: Hello = {
  kind: "hello",
  protocol: PROTOCOL_VERSION,
  features: [],
  buildId: "macos-probe",
};
let writer = Promise.resolve();
let queued = 0;
let booted = false;
let ready = false;
let stopping = false;
let subscribed = false;
let pendingListen: string | undefined;
let sequence = 0;
const completed = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function send(frame: ProcessFrame): Promise<void> {
  const line = `${serializeProcessFrame(frame)}\n`;
  if (queued >= 128) throw new Error("Output queue full.");
  queued++;
  writer = writer.then(
    () =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(line, (error) => {
          queued--;
          if (error) reject(error);
          else resolve();
        });
      }),
  );
  return writer;
}

function web(message: Message): Promise<void> {
  return send({
    kind: "web",
    ipc: PROCESS_IPC_VERSION,
    runtime,
    context: "probe-view",
    payload: message,
  });
}

function result(id: string, payload: JsonValue) {
  if (completed.has(id)) throw new Error("Duplicate request ID.");
  let pending: Promise<void>;
  try {
    pending = web({ kind: "result", protocol: PROTOCOL_VERSION, id, payload });
  } catch (cause) {
    if (!(cause instanceof ProtocolError)) throw cause;
    pending = web({
      kind: "error",
      protocol: PROTOCOL_VERSION,
      id,
      error: { code: "INTERNAL", message: "Invalid probe response." },
    });
  }
  completed.add(id);
  return pending;
}

function error(id: string, code: "INTERNAL" | "INVALID_ARGUMENT" | "CANCELLED", message: string) {
  if (completed.has(id)) throw new Error("Duplicate request ID.");
  const pending = web({ kind: "error", protocol: PROTOCOL_VERSION, id, error: { code, message } });
  completed.add(id);
  return pending;
}

async function dispatch(frame: ProcessFrame) {
  if (frame.runtime.id !== runtime.id || frame.runtime.generation !== runtime.generation) {
    throw new Error("Stale runtime.");
  }
  // Shutdown may replace queued boot/hello frames before initialization finishes.
  if (frame.kind === "shutdown") {
    if (mode === "ignore-stop") return;
    stopping = true;
    for (const [id, timer] of timers) {
      clearTimeout(timer);
      await error(id, "CANCELLED", "Runtime stopped.");
    }
    timers.clear();
    subscribed = false;
    await send({ kind: "stopping", ipc: PROCESS_IPC_VERSION, runtime });
    process.stdin.destroy();
    return;
  }
  if (frame.kind === "boot" && !booted) {
    booted = true;
    await send({ kind: "hello", ipc: PROCESS_IPC_VERSION, runtime, payload: hello });
    return;
  }
  if (frame.kind === "hello" && booted && !ready) {
    negotiateProtocol(hello, frame.payload);
    ready = true;
    if (mode === "child") {
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "-e", "setInterval(()=>{},1000)"],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      child.unref();
      console.error(`descendant=${child.pid}`);
    }
    await send({
      kind: "ready",
      ipc: PROCESS_IPC_VERSION,
      runtime,
      pid: process.pid,
      bunVersion: Bun.version,
      revision: Bun.revision,
    });
    if (mode?.startsWith("fault-")) {
      const faults: Record<string, string | Uint8Array> = {
        "fault-json": "not-json\n",
        "fault-utf8": new Uint8Array([255, 10]),
        "fault-large": `${"x".repeat(1_048_577)}\n`,
        "fault-partial": "{",
        "fault-stdout": "backend log on stdout\n",
        "fault-stale": `${JSON.stringify({ kind: "stopping", ipc: PROCESS_IPC_VERSION, runtime: { id: "probe", generation: "0" } })}\n`,
        "fault-version": `${JSON.stringify({ kind: "stopping", ipc: { major: 2, minor: 0 }, runtime })}\n`,
        "fault-eof": "",
      };
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(faults[mode] ?? "\n", (cause) => (cause ? reject(cause) : resolve())),
      );
      process.exit(0);
    }
    return;
  }
  if (!ready || stopping) throw new Error("Runtime not ready.");
  if (frame.kind === "revoke") {
    subscribed = false;
    if (mode === "late-listen" && pendingListen !== undefined) {
      // Intentionally acknowledge a listen only after the host has revoked it.
      await result(pendingListen, { subscriptionId: "probe-sub" });
      pendingListen = undefined;
      await web({
        kind: "event",
        protocol: PROTOCOL_VERSION,
        subscriptionId: "probe-sub",
        source: "backend",
        target: "probe-view",
        event: "probe.changed",
        sequence: ++sequence,
        payload: "revoked-event",
      });
    }
    return;
  }
  if (frame.kind !== "web" || frame.context !== "probe-view")
    throw new Error("Invalid direction or context.");
  const message = frame.payload;
  if (message.kind === "listen") {
    if (message.event !== "probe.changed") throw new Error("Unknown event.");
    subscribed = true;
    sequence = 0;
    if (mode === "late-listen") {
      pendingListen = message.id;
      return;
    }
    await result(message.id, { subscriptionId: "probe-sub" });
    return;
  }
  if (message.kind === "unlisten") {
    subscribed = false;
    await result(message.id, null);
    return;
  }
  if (message.kind !== "invoke") throw new Error("Invalid request.");
  if (completed.size > 1024 || completed.has(message.id) || timers.has(message.id))
    throw new Error("Request limit or reused ID.");
  switch (message.command) {
    case "probe.echo":
      await result(message.id, message.payload);
      break;
    case "probe.number-array":
      if (
        typeof message.payload !== "number" ||
        !Number.isSafeInteger(message.payload) ||
        message.payload < 0 ||
        message.payload > 210000
      )
        throw new Error("Invalid array size.");
      await result(message.id, Array(message.payload).fill(1e-7));
      break;
    case "probe.add":
      await result(message.id, 2 + 2);
      break;
    case "probe.promise":
      await result(message.id, await Promise.resolve(21).then((value) => value * 2));
      break;
    case "probe.timer":
    case "probe.hold":
      timers.set(
        message.id,
        setTimeout(
          () => {
            timers.delete(message.id);
            void result(message.id, "timer-done").catch(fatal);
          },
          message.command === "probe.hold" ? 10000 : 20,
        ),
      );
      break;
    case "probe.throw":
    case "probe.reject":
      try {
        if (message.command === "probe.reject") await Promise.reject(new Error("private-details"));
        else throw new Error("private-details");
      } catch {
        await error(message.id, "INTERNAL", "Probe operation failed.");
      }
      break;
    case "probe.emit":
    case "probe.late-event":
      await result(message.id, null);
      if (subscribed || message.command === "probe.late-event") {
        await web({
          kind: "event",
          protocol: PROTOCOL_VERSION,
          subscriptionId: "probe-sub",
          source: "backend",
          target: "probe-view",
          event: "probe.changed",
          sequence: ++sequence,
          payload: message.payload,
        });
      }
      break;
    case "probe.environment":
      await result(message.id, {
        cwd: process.cwd(),
        injected: process.env.BUNAWAY_HOSTILE ?? null,
        bunOptions: process.env.BUN_OPTIONS ?? null,
        args: process.argv.slice(2),
      });
      break;
    case "probe.late-response": {
      await result(message.id, "first");
      await web({ kind: "result", protocol: PROTOCOL_VERSION, id: message.id, payload: "late" });
      break;
    }
    case "probe.crash":
      process.exit(17);
      break;
    case "probe.close-stdout": {
      // Bun keeps a second descriptor aliasing the IPC pipe (fd 1). Closing
      // only fd 1 leaves the write end open, so the host never sees EOF:
      // close every descriptor sharing fd 1's pipe identity, then fd 1.
      const target = fstatSync(1);
      for (const name of readdirSync("/dev/fd")) {
        const fd = Number(name);
        if (!Number.isInteger(fd) || fd === 1) continue;
        try {
          const stat = fstatSync(fd);
          if (stat.dev === target.dev && stat.ino === target.ino) closeSync(fd);
        } catch {}
      }
      closeSync(1);
      setInterval(() => {}, 1000);
      break;
    }
    case "probe.unicode-error":
      await error(message.id, "INTERNAL", "😀".repeat(600));
      break;
    case "probe.log-flood":
      await new Promise<void>((resolve, reject) => {
        process.stderr.write("log-test\n".repeat(32768), (cause) =>
          cause ? reject(cause) : resolve(),
        );
      });
      await result(message.id, "logs-drained");
      break;
    default:
      await error(message.id, "INVALID_ARGUMENT", "Unknown probe command.");
  }
}

async function fatal() {
  try {
    await send({
      kind: "fatal",
      ipc: PROCESS_IPC_VERSION,
      runtime,
      error: { code: "INTERNAL", message: "Backend IPC failed." },
    });
  } finally {
    process.exit(1);
  }
}

try {
  for await (const line of readJsonLines(process.stdin)) {
    await dispatch(parseProcessFrame(line));
    if (stopping) break;
  }
  if (!stopping && mode !== "ignore-stop") throw new Error("Unexpected host EOF.");
  if (mode === "ignore-stop") setInterval(() => {}, 1000);
  await writer;
} catch {
  await fatal();
}

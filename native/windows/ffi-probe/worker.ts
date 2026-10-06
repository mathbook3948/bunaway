import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

export type ProbeWorkerData = {
  viewId: string;
  value: number;
  pid: number;
  thread: number;
  counters: SharedArrayBuffer;
  earlyClose: boolean;
  resize: boolean;
};
export type ToUI = { viewId: string } & (
  | { kind: "result"; id: "roundtrip" | "late"; value: number }
  | { kind: "modal-ping"; sentAt: number }
);
type FromUI = { viewId: string } & (
  | { kind: "invoke"; value: number }
  | { kind: "window-closed" | "native-closed" | "done" }
);

// The backend owns no HWND, COM pointer or JSCallback. Shared memory below is
// only instrumentation: count work strictly between ENTERSIZEMOVE/EXITSIZEMOVE.
const kernel = dlopen("kernel32.dll", { GetCurrentThreadId: { args: [], returns: "u32" } });
const thread = kernel.symbols.GetCurrentThreadId();
kernel.close();
const shared = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
const counters = new Int32Array(shared);
const earlyClose = process.argv.includes("--early-close");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("network-ok"),
});
const multi = process.argv.includes("--multi");
const views: ProbeWorkerData[] = (multi ? ["first", "second"] : ["single"]).map(
  (viewId, index) => ({
    viewId,
    value: 21 + index,
    pid: process.pid,
    thread,
    counters: shared,
    earlyClose,
    resize: process.argv.includes("--size"),
  }),
);
const states = new Map(
  views.map((view) => [
    view.viewId,
    { ...view, invoked: false, windowClosed: false, nativeClosed: false, done: false },
  ]),
);
let firstDone = () => {};
const siblingClosed = new Promise<void>((resolve) => {
  firstDone = resolve;
});
const worker = new Worker(new URL("./ui.ts", import.meta.url), {
  workerData: views,
});
let error: unknown;
let stopped = false;
let pingSent = false;
let calls = 0;
let ticks = 0;
let promises = 0;
const jobs = new Set<Promise<void>>();
const post = (message: ToUI) => worker.postMessage(message);
async function network() {
  const response = await fetch(server.url, { signal: AbortSignal.timeout(2000) });
  assert.equal(await response.text(), "network-ok");
}
worker.on("error", (cause) => {
  error ??= cause;
});
worker.on("message", (message: FromUI) => {
  const job = (async () => {
    const state = states.get(message.viewId);
    assert(state, "Unknown view route");
    if (message.kind === "window-closed") {
      assert(!state.windowClosed);
      state.windowClosed = true;
      if (state.viewId === "first") firstDone();
    } else if (message.kind === "done") {
      assert(state.nativeClosed && !state.done);
      state.done = true;
    } else if (message.kind === "native-closed") {
      assert(!state.nativeClosed);
      state.nativeClosed = true;
      await network();
      post({ kind: "result", viewId: state.viewId, id: "late", value: await Promise.resolve(99) });
    } else {
      assert.equal(message.kind, "invoke");
      assert(!state.invoked && !state.nativeClosed);
      state.invoked = true;
      assert.equal(message.value, state.value);
      if (multi && state.viewId === "second") {
        await siblingClosed;
        assert(states.get("first")?.windowClosed, "First view's HWND was not destroyed");
        console.log(JSON.stringify({ event: "call-after-sibling-close", viewId: state.viewId }));
      }
      await network();
      const value = await Promise.resolve(message.value * 2);
      calls++;
      post({ kind: "result", viewId: state.viewId, id: "roundtrip", value });
    }
  })().catch((cause) => {
    error ??= cause;
  });
  jobs.add(job);
  void job.finally(() => jobs.delete(job));
});
const exited = new Promise<number>((resolve) =>
  worker.once("exit", (code) => {
    firstDone();
    resolve(code);
  }),
);
const timer = setInterval(() => {
  ticks++;
  const active = Atomics.load(counters, 0) === 1;
  if (active) {
    Atomics.add(counters, 1, 1);
    if (!pingSent) {
      pingSent = true;
      post({ kind: "modal-ping", viewId: multi ? "second" : "single", sentAt: Date.now() });
    }
  }
  void Promise.resolve().then(() => {
    promises++;
    if (active && Atomics.load(counters, 0) === 1) Atomics.add(counters, 2, 1);
  });
}, 10);
const networkLoop = (async () => {
  while (!stopped) {
    const active = Atomics.load(counters, 0) === 1;
    await network();
    if (active && Atomics.load(counters, 0) === 1) Atomics.add(counters, 3, 1);
    await Bun.sleep(10);
  }
})().catch((cause) => {
  error ??= cause;
});
try {
  const code = await exited;
  await Promise.all(jobs);
  if (error) throw error;
  assert.equal(code, 0, "UI Worker failed");
  assert(
    [...states.values()].every((state) => state.done),
    "UI Worker exited without native cleanup acknowledgement",
  );
  assert.equal(calls, earlyClose ? 0 : views.length);
  if (!earlyClose) {
    assert(pingSent);
    for (const index of [1, 2, 3]) assert(Atomics.load(counters, index) > 0);
  }
} finally {
  stopped = true;
  clearInterval(timer);
  await networkLoop;
  await server.stop(true);
}
if (error) throw error;
console.log(
  JSON.stringify({
    event: "worker-pass",
    pid: process.pid,
    thread,
    earlyClose,
    views: views.length,
    calls,
    ticks,
    promises,
  }),
);

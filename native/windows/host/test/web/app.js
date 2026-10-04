// Minimal client transport + boundary test suite. Not the product client SDK.
const pending = new Map();
const subs = new Map();
let seq = 0;
let helloResolve;
window.chrome.webview.addEventListener("message", (event) => {
  const m = event.data;
  if (!m || typeof m !== "object") return;
  if (m.kind === "hello") helloResolve?.(m);
  else if (m.kind === "event") subs.get(m.subscriptionId)?.(m);
  else if (m.kind === "result" || m.kind === "error") {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      p(m);
    }
  } else if (m.kind === "subscription-error") subs.delete(m.subscriptionId);
});
function send(m) {
  m.protocol = { major: 1, minor: 0 };
  window.chrome.webview.postMessage(m);
}
function request(kind, extra) {
  const id = `t-${++seq}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ kind, id, ...extra });
  });
}
window.onerror = (msg, _src, line) => {
  send({
    kind: "invoke",
    id: `err-${++seq}`,
    command: "test.echo",
    payload: { pageError: `${msg}@${line}` },
  });
};
const call = (command, payload = null, extra = {}) =>
  request("invoke", { command, payload, ...extra });
const listen = (event) => request("listen", { event });
const unlisten = (subscriptionId) => request("unlisten", { subscriptionId });
const cancel = (id) => send({ kind: "cancel", id });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 300; i++) {
    const p = new Promise((r) => (helloResolve = r));
    send({ kind: "hello", features: [], buildId: "test-page" });
    const m = await Promise.race([p, sleep(150)]);
    if (m?.kind === "hello") return m;
  }
  throw new Error("hello never answered");
}

async function run() {
  const results = [];
  const test = async (name, fn) => {
    await call("test.echo", { step: name });
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: String(e?.message ?? e) });
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  try {
    await connect();
  } catch (e) {
    results.push({ name: "connect", ok: false, error: String(e?.message ?? e) });
    await report(results);
    return;
  }
  results.push({ name: "connect", ok: true });

  await test("echo unicode", async () => {
    const r = await call("test.echo", { msg: "한글 😀\n" });
    assert(r.kind === "result" && r.payload.msg === "한글 😀\n", `bad echo ${JSON.stringify(r)}`);
  });
  await test("denied command", async () => {
    const before = (await call("test.count")).payload;
    const r = await call("test.notAllowed", null);
    assert(
      r.kind === "error" && r.error.code === "PERMISSION_DENIED",
      `expected denial ${JSON.stringify(r)}`,
    );
    const after = (await call("test.count")).payload;
    assert(after === before + 1, "denied command reached the backend");
  });
  await test("denied event listen", async () => {
    const r = await listen("other.event");
    assert(
      r.kind === "error" && r.error.code === "PERMISSION_DENIED",
      `expected denial ${JSON.stringify(r)}`,
    );
  });
  await test("forged context rejected", async () => {
    const r = await request("invoke", {
      command: "test.ping",
      payload: null,
      context: "ctx-forged",
    });
    assert(
      r.kind === "error" && r.error.code === "INVALID_ARGUMENT",
      `expected rejection ${JSON.stringify(r)}`,
    );
  });
  await test("malformed message rejected", async () => {
    window.chrome.webview.postMessage("garbage");
    window.chrome.webview.postMessage(12345);
    window.chrome.webview.postMessage({ kind: "shutdown" });
    window.chrome.webview.postMessage({
      kind: "invoke",
      protocol: { major: 1, minor: 0 },
      id: "x-1",
      command: "test.ping",
    });
    const r = await new Promise((resolve) => {
      pending.set("x-1", resolve);
    });
    assert(r.kind === "error", `expected error ${JSON.stringify(r)}`);
    // Session must still be usable afterwards.
    const p = await call("test.ping");
    assert(p.kind === "result" && p.payload === "pong", "session broken after malformed message");
  });
  await test("past deadline rejected", async () => {
    const r = await call("test.ping", null, { deadline: Date.now() - 1000 });
    assert(
      r.kind === "error" && r.error.code === "TIMEOUT",
      `expected TIMEOUT ${JSON.stringify(r)}`,
    );
  });
  await test("invoke deadline enforced", async () => {
    const id = `t-${++seq}`;
    const p = new Promise((resolve) => pending.set(id, resolve));
    send({ kind: "invoke", id, command: "test.hold", payload: null, deadline: Date.now() + 600 });
    const r = await p;
    assert(
      r.kind === "error" && r.error.code === "TIMEOUT",
      `expected TIMEOUT ${JSON.stringify(r)}`,
    );
  });
  await test("cancel resolves CANCELLED", async () => {
    const id = `t-${++seq}`;
    const p = new Promise((resolve) => pending.set(id, resolve));
    send({ kind: "invoke", id, command: "test.hold", payload: null });
    await sleep(100);
    cancel(id);
    const r = await p;
    assert(
      r.kind === "error" && r.error.code === "CANCELLED",
      `expected CANCELLED ${JSON.stringify(r)}`,
    );
  });
  await test("reused request id rejected", async () => {
    await request("invoke", { command: "test.ping", payload: null });
    // reuse the id that was just completed
    const last = `t-${seq}`;
    const p = new Promise((resolve) => pending.set(last, resolve));
    send({ kind: "invoke", id: last, command: "test.ping", payload: null });
    const dup = await p;
    assert(
      dup.kind === "error" && dup.error.code === "INVALID_ARGUMENT",
      `expected rejection ${JSON.stringify(dup)}`,
    );
  });
  await test("events delivered in order", async () => {
    const l = await listen("test.changed");
    assert(l.kind === "result" && l.payload.subscriptionId, `listen failed ${JSON.stringify(l)}`);
    const sub = l.payload.subscriptionId;
    const seen = [];
    subs.set(sub, (m) => seen.push(m));
    await call("test.emit", { n: 1 });
    await call("test.emit", { n: 2 });
    await sleep(150);
    assert(
      seen.length === 2 &&
        seen[0].payload.n === 1 &&
        seen[1].payload.n === 2 &&
        seen[0].sequence === 1 &&
        seen[1].sequence === 2,
      `bad events ${JSON.stringify(seen)}`,
    );
    const u = await unlisten(sub);
    assert(u.kind === "result", "unlisten failed");
    await call("test.emit", { n: 3 });
    await sleep(150);
    assert(seen.length === 2, "event delivered after unlisten");
  });
  await test("storage roundtrip appData", async () => {
    const w = await call("test.writeNote", { name: "a", text: "hello 파일" });
    assert(w.kind === "result" && w.payload.ok, `write failed ${JSON.stringify(w)}`);
    const r = await call("test.readNote", { name: "a" });
    assert(
      r.kind === "result" && r.payload.ok && r.payload.value === "hello 파일",
      `read failed ${JSON.stringify(r)}`,
    );
  });
  await test("storage scope escape denied", async () => {
    const r = await call("test.readEscape", { path: "secrets/x.txt" });
    assert(
      r.kind === "result" && r.payload.ok === false && r.payload.code === "PERMISSION_DENIED",
      `expected denial ${JSON.stringify(r)}`,
    );
  });
  await test("storage traversal denied", async () => {
    const r = await call("test.readEscape", { path: "../x.txt" });
    assert(
      r.kind === "result" && r.payload.ok === false && r.payload.code === "INVALID_ARGUMENT",
      `expected rejection ${JSON.stringify(r)}`,
    );
  });
  await test("storage symlink denied", async () => {
    // notes/link is a junction planted by the driver pointing outside the scope.
    const r = await call("test.readEscape", { path: "notes/link/secret.txt" });
    assert(
      r.kind === "result" && r.payload.ok === false && r.payload.code === "PERMISSION_DENIED",
      `expected denial ${JSON.stringify(r)}`,
    );
  });
  await test("temp scope roundtrip", async () => {
    const w = await call("test.tempWrite", { path: "scratch.txt", text: "tmp" });
    assert(w.kind === "result" && w.payload.ok, `temp write failed ${JSON.stringify(w)}`);
    const r = await call("test.tempRead", { path: "scratch.txt" });
    assert(
      r.kind === "result" && r.payload.ok && r.payload.value === "tmp",
      `temp read failed ${JSON.stringify(r)}`,
    );
  });
  await test("capabilities", async () => {
    const r = await call("test.capabilities");
    assert(
      r.kind === "result" &&
        r.payload.ok &&
        Array.isArray(r.payload.value) &&
        r.payload.value.length === 4,
      `bad caps ${JSON.stringify(r)}`,
    );
  });
  await test("log.write", async () => {
    const r = await call("test.log", { message: "page-log-테스트" });
    assert(r.kind === "result" && r.payload.ok, `log failed ${JSON.stringify(r)}`);
  });
  await test("host cancel", async () => {
    const r = await call("test.hostCancel");
    assert(
      r.kind === "result" && r.payload.outcome !== undefined,
      `bad outcome ${JSON.stringify(r)}`,
    );
  });

  await report(results);
  await sleep(200);
  location.assign("page2.html");
}

async function report(results) {
  await call("test.report", { file: "report.json", report: { page: "index", results } });
}

const status = document.getElementById("status");
run()
  .then(() => {
    status.textContent = "done";
  })
  .catch(async (e) => {
    status.textContent = "failed";
    try {
      await report([{ name: "run", ok: false, error: String(e?.message ?? e) }]);
    } catch {}
    try {
      location.assign("page2.html");
    } catch {}
  });

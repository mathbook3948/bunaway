// Second page: verifies the old session was revoked and a new session works,
// then tries a blocked remote navigation and confirms the session survives.
const pending = new Map();
let seq = 0;
let helloResolve;
window.chrome.webview.addEventListener("message", (event) => {
  const m = event.data;
  if (!m || typeof m !== "object") return;
  if (m.kind === "hello") helloResolve?.(m);
  else if (m.kind === "result" || m.kind === "error") {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      p(m);
    }
  }
});
function send(m) {
  m.protocol = { major: 1, minor: 0 };
  window.chrome.webview.postMessage(m);
}
const call = (command, payload = null) => {
  const id = `p2-${++seq}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ kind: "invoke", id, command, payload });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 300; i++) {
    const p = new Promise((r) => (helloResolve = r));
    send({ kind: "hello", features: [], buildId: "test-page2" });
    const m = await Promise.race([p, sleep(150)]);
    if (m?.kind === "hello") return m;
  }
  throw new Error("hello never answered");
}
async function report(file, results) {
  await call("test.report", { file, report: { page: "page2", results } });
}
async function run() {
  const results = [];
  const test = async (name, fn) => {
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

  await test("new session after navigation", async () => {
    await connect();
    const r = await call("test.ping");
    assert(r.kind === "result" && r.payload === "pong", `ping failed ${JSON.stringify(r)}`);
  });
  await report("report2.json", results);

  // Remote navigation attempt must be canceled by the host.
  await test("remote navigation blocked", async () => {
    location.assign("https://example.org/");
    await sleep(1200);
    const r = await call("test.ping");
    assert(
      r.kind === "result" && r.payload === "pong",
      "session did not survive blocked navigation",
    );
  });
  await report("report3.json", results);
}
run().catch(async (e) => {
  try {
    await report("report3.json", [{ name: "run", ok: false, error: String(e?.message ?? e) }]);
  } catch {}
});

// Second page: verifies the old session was revoked and a new session works,
// then tries a blocked remote navigation and confirms the session survives.
import { createClient, createWebViewTransport } from "@bunaway/client";
const client = createClient({
  transport: createWebViewTransport(window.chrome.webview),
  hello: {
    kind: "hello",
    protocol: {
      major: 1,
      minor: 0,
    },
    features: [],
    buildId: "windows-sdk-page2",
  },
});
window.addEventListener("pagehide", () => {
  void client.close();
});
const call = async (command, payload = null) => ({
  kind: "result",
  payload: await client.invoke(command, payload),
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function connect() {
  return client.ready;
}
async function report(file, results) {
  await call("test.report", {
    file,
    report: {
      page: "page2",
      results,
    },
  });
}
async function run() {
  const results = [];
  const test = async (name, fn) => {
    try {
      await fn();
      results.push({
        name,
        ok: true,
      });
    } catch (e) {
      results.push({
        name,
        ok: false,
        error: String(e?.message ?? e),
      });
    }
  };
  const assert = (cond, msg) => {
    if (!cond) {
      throw new Error(msg);
    }
  };

  await test("new session after navigation", async () => {
    await connect();
    const r = await call("test.ping");
    assert(
      r.kind === "result" && r.payload === "pong",
      `ping failed ${JSON.stringify(r)}`,
    );
  });
  await test("memo survives view recreation", async () => {
    const memo = await client.invoke("memo.read", null);
    assert(
      memo === "재실행 후에도 남는 메모 😀" ||
        memo === "편집 뷰가 저장한 메모 ✏️",
      "memo lost after navigation",
    );
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
    await report("report3.json", [
      {
        name: "run",
        ok: false,
        error: String(e?.message ?? e),
      },
    ]);
  } catch {}
});

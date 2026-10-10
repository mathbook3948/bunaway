// Read-only view: shares the backend with main/editor but its policy denies
// writes, log output and most commands. Exercises per-view policy, request-id
// isolation and event filtering, then closes its own window while siblings run.
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
    buildId: "windows-sdk-reader",
  },
});
window.addEventListener("pagehide", () => {
  void client.close();
});
const pending = new Map();
const memoSaved = [];
window.chrome.webview.addEventListener("message", (event) => {
  const m = event.data;
  if (!m || typeof m !== "object") {
    return;
  }
  if (m.kind === "event" && m.event === "memo.saved") {
    memoSaved.push(m);
  } else if (m.kind === "result" || m.kind === "error") {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      p(m);
    }
  }
});
const send = (m) => {
  m.protocol = {
    major: 1,
    minor: 0,
  };
  window.chrome.webview.postMessage(m);
};
const rawRequest = (kind, extra, id) =>
  new Promise((resolve) => {
    pending.set(id, resolve);
    send({
      kind,
      id,
      ...extra,
    });
  });
const call = async (command, payload = null) => {
  try {
    return {
      kind: "result",
      payload: await client.invoke(command, payload),
    };
  } catch (error) {
    return {
      kind: "error",
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = async (results) =>
  call("test.report", {
    file: "reader.json",
    report: {
      page: "reader",
      results,
    },
  });

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

  try {
    await client.ready;
  } catch (e) {
    await report([
      {
        name: "connect",
        ok: false,
        error: String(e?.message ?? e),
      },
    ]);
    return;
  }
  results.push({
    name: "connect",
    ok: true,
  });

  await test("shared request id stays in this view", async () => {
    // main's page uses the same request id concurrently; each view must get its
    // own response payload back.
    const r = await rawRequest(
      "invoke",
      {
        command: "test.echo",
        payload: {
          who: "reader",
        },
      },
      "shared-1",
    );
    assert(
      r.kind === "result" && r.payload.who === "reader",
      `wrong delivery ${JSON.stringify(r)}`,
    );
  });
  await test("save denied for read-only view", async () => {
    const r = await call("memo.save", "must not be stored");
    assert(
      r.kind === "error" && r.error.code === "PERMISSION_DENIED",
      `expected command denial ${JSON.stringify(r)}`,
    );
  });
  await test("allowed command denied by read-only storage grant", async () => {
    const r = await call("test.writeNote", {
      name: "reader",
      text: "must not be stored",
    });
    assert(
      r.kind === "result" &&
        r.payload.ok === false &&
        r.payload.code === "PERMISSION_DENIED",
      `expected storage denial ${JSON.stringify(r)}`,
    );
  });
  await test("log.write denied for this view", async () => {
    const r = await call("test.log", {
      message: "reader-log",
    });
    assert(
      r.kind === "result" &&
        r.payload.ok === false &&
        r.payload.code === "PERMISSION_DENIED",
      `expected log denial ${JSON.stringify(r)}`,
    );
  });
  await test("read grant works within allowed prefix", async () => {
    const r = await call("test.readNote", {
      name: "public",
    });
    assert(
      r.kind === "result" && r.payload.ok && r.payload.value === "shared-note",
      `read failed ${JSON.stringify(r)}`,
    );
  });
  await test("unlisted event listen denied", async () => {
    const r = await rawRequest(
      "listen",
      {
        event: "test.changed",
      },
      "listen-denied",
    );
    assert(
      r.kind === "error" && r.error.code === "PERMISSION_DENIED",
      `expected event denial ${JSON.stringify(r)}`,
    );
  });
  await test("allowed event subscription delivers memo.saved", async () => {
    const release = await client.listen("memo.saved", () => {}, {
      onError: () => {},
    });
    const deadline = Date.now() + 60000;
    while (memoSaved.length === 0 && Date.now() < deadline) {
      await sleep(100);
    }
    assert(memoSaved.length > 0, "memo.saved never reached the allowed view");
    assert(
      memoSaved[0].target === "reader",
      `wrong target ${JSON.stringify(memoSaved[0])}`,
    );
    assert(memoSaved[0].sequence === 1, "first sequence must be 1");
    await release();
    const r = await call("memo.read");
    assert(
      r.kind === "result" && typeof r.payload === "string",
      `memo.read failed ${JSON.stringify(r)}`,
    );
    document.getElementById("memo").textContent = r.payload;
  });

  await report(results);
  // Leave a pending invoke behind so its late result hits a revoked session,
  // then close this window: siblings and the backend must keep running.
  send({
    kind: "invoke",
    id: "leaving-1",
    command: "test.hold",
    payload: null,
  });
  await sleep(300);
  window.close();
}
run().catch(async (e) => {
  try {
    await report([
      {
        name: "run",
        ok: false,
        error: String(e?.message ?? e),
      },
    ]);
  } catch {}
});

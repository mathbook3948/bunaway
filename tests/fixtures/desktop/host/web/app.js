import {
  createClient,
  createWebViewTransport,
} from "../../../../../packages/client-sdk/src/index.ts";
import { matchesCapabilities } from "./capabilities.ts";

const client = createClient({
  transport: createWebViewTransport(window.chrome.webview),
  hello: {
    kind: "hello",
    protocol: {
      major: 1,
      minor: 0,
    },
    features: [],
    buildId: "windows-sdk-ui",
  },
});
window.addEventListener("pagehide", () => {
  void client.close();
});
const releases = new Map();
// Raw inputs below exercise malformed messages that the SDK deliberately cannot send.
const pending = new Map();
const subs = new Map();
let seq = 0;
window.chrome.webview.addEventListener("message", (event) => {
  const m = event.data;
  if (!m || typeof m !== "object") {
    return;
  }
  if (m.kind === "event") {
    subs.get(m.subscriptionId)?.(m);
  } else if (m.kind === "result" || m.kind === "error") {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      p(m);
    }
  } else if (m.kind === "subscription-error") {
    subs.delete(m.subscriptionId);
  }
});
function send(m) {
  m.protocol = {
    major: 1,
    minor: 0,
  };
  window.chrome.webview.postMessage(m);
}
function request(kind, extra) {
  const id = `t-${++seq}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({
      kind,
      id,
      ...extra,
    });
  });
}
window.onerror = (msg, _src, line) => {
  send({
    kind: "invoke",
    id: `err-${++seq}`,
    command: "test.echo",
    payload: {
      pageError: `${msg}@${line}`,
    },
  });
};
const call = async (command, payload = null, extra = {}) => {
  try {
    return {
      kind: "result",
      payload: await client.invoke(command, payload, extra),
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
const listen = async (event) => {
  const key = `sdk-sub-${++seq}`;
  try {
    releases.set(
      key,
      await client.listen(event, (message) => subs.get(key)?.(message), {
        onError: () => subs.delete(key),
      }),
    );
    return {
      kind: "result",
      payload: {
        subscriptionId: key,
      },
    };
  } catch (error) {
    return {
      kind: "error",
      error: {
        code: error.code,
      },
    };
  }
};
const unlisten = async (key) => {
  await releases.get(key)?.();
  releases.delete(key);
  return {
    kind: "result",
  };
};
const cancel = (id) =>
  send({
    kind: "cancel",
    id,
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const multiView =
  new URL(location.href).searchParams.get("test") === "multi-view";
const nativePlugins =
  new URL(location.href).searchParams.get("nativePlugins") !== "0";

async function connect() {
  return client.ready;
}

async function run() {
  const results = [];
  const test = async (name, fn) => {
    await call("test.echo", {
      step: name,
    });
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
    await connect();
  } catch (e) {
    results.push({
      name: "connect",
      ok: false,
      error: String(e?.message ?? e),
    });
    await report(results);
    return;
  }
  results.push({
    name: "connect",
    ok: true,
  });

  if (multiView) {
    await test("embedded resources, ranges and web workers", async () => {
      const response = await fetch("asset-probe.txt", {
        headers: {
          Range: "bytes=2-4",
        },
      });
      assert(
        response.status === 206 && (await response.text()) === "234",
        "byte range response",
      );
      assert(
        (await fetch("missing-file.txt")).status === 404,
        "missing resource must stay local",
      );
      assert(
        (await fetch("../policy.json")).status === 404,
        "host policy must not be a web resource",
      );
      const worker = new Worker("./asset-probe.js");
      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("web worker timeout")),
            5000,
          );
          worker.onmessage = (event) => {
            clearTimeout(timer);
            resolve(event.data);
          };
          worker.onerror = () => {
            clearTimeout(timer);
            reject(new Error("web worker failed"));
          };
        });
        assert(result === "embedded worker", "web worker asset");
      } finally {
        worker.terminate();
      }
    });
  }

  await test("shared request id stays in this view", async () => {
    // The reader page uses the same request id concurrently; each view must
    // receive the response carrying its own payload.
    const r = await new Promise((resolve) => {
      pending.set("shared-1", resolve);
      send({
        kind: "invoke",
        id: "shared-1",
        command: "test.echo",
        payload: {
          who: "main",
        },
      });
    });
    assert(
      r.kind === "result" && r.payload.who === "main",
      `wrong delivery ${JSON.stringify(r)}`,
    );
  });
  await test("echo unicode", async () => {
    const r = await call("test.echo", {
      msg: "한글 😀\n",
    });
    assert(
      r.kind === "result" && r.payload.msg === "한글 😀\n",
      `bad echo ${JSON.stringify(r)}`,
    );
  });
  await test("History API preserves session and subscriptions", async () => {
    const original = location.href;
    const l = await listen("test.changed");
    assert(l.kind === "result", "listen failed before History API navigation");
    const sub = l.payload.subscriptionId;
    const seen = [];
    subs.set(sub, (m) => seen.push(m));
    try {
      history.pushState({}, "", "/spa/route?step=1");
      const immediate = await call("test.ping");
      assert(
        immediate.kind === "result",
        "immediate invoke after pushState failed",
      );
      await sleep(100);
      const ping = await call("test.ping");
      assert(
        ping.kind === "result" && ping.payload === "pong",
        "pushState broke invoke",
      );
      await call("test.emit", {
        step: 1,
      });
      history.replaceState({}, "", "/spa/route?step=2");
      const immediateReplace = await call("test.ping");
      assert(
        immediateReplace.kind === "result",
        "immediate invoke after replaceState failed",
      );
      await sleep(100);
      const replaced = await call("test.ping");
      assert(replaced.kind === "result", "replaceState broke invoke");
      await call("test.emit", {
        step: 2,
      });
      const back = new Promise((resolve) =>
        window.addEventListener("popstate", resolve, {
          once: true,
        }),
      );
      history.back();
      await back;
      await sleep(100);
      const restored = await call("test.ping");
      assert(restored.kind === "result", "history.back broke invoke");
      assert(
        seen.length === 2 && seen[0].sequence === 1 && seen[1].sequence === 2,
        "History API navigation lost the subscription",
      );
    } finally {
      history.replaceState({}, "", original);
      await sleep(100);
      await unlisten(sub);
      subs.delete(sub);
    }
  });
  await test("denied command", async () => {
    const before = (await call("test.count")).payload;
    const r = await call("test.notAllowed", null);
    assert(
      r.kind === "error" && r.error.code === "PERMISSION_DENIED",
      `expected denial ${JSON.stringify(r)}`,
    );
    const after = (await call("test.count")).payload;
    // Count only the registered forbidden handler: sibling-view commands may run concurrently.
    assert(after === before, "denied command handler ran");
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
    window.chrome.webview.postMessage({
      kind: "shutdown",
    });
    window.chrome.webview.postMessage({
      kind: "invoke",
      protocol: {
        major: 1,
        minor: 0,
      },
      id: "x-1",
      command: "test.ping",
    });
    const r = await new Promise((resolve) => {
      pending.set("x-1", resolve);
    });
    assert(r.kind === "error", `expected error ${JSON.stringify(r)}`);
    // Session must still be usable afterwards.
    const p = await call("test.ping");
    assert(
      p.kind === "result" && p.payload === "pong",
      "session broken after malformed message",
    );
  });
  await test("past deadline rejected", async () => {
    const r = await call("test.ping", null, {
      deadline: Date.now() - 1000,
    });
    assert(
      r.kind === "error" && r.error.code === "TIMEOUT",
      `expected TIMEOUT ${JSON.stringify(r)}`,
    );
  });
  await test("invoke deadline enforced", async () => {
    const id = `t-${++seq}`;
    const p = new Promise((resolve) => pending.set(id, resolve));
    send({
      kind: "invoke",
      id,
      command: "test.hold",
      payload: null,
      deadline: Date.now() + 600,
    });
    const r = await p;
    assert(
      r.kind === "error" && r.error.code === "TIMEOUT",
      `expected TIMEOUT ${JSON.stringify(r)}`,
    );
  });
  await test("cancel resolves CANCELLED", async () => {
    const id = `t-${++seq}`;
    const p = new Promise((resolve) => pending.set(id, resolve));
    send({
      kind: "invoke",
      id,
      command: "test.hold",
      payload: null,
    });
    await sleep(100);
    cancel(id);
    const r = await p;
    assert(
      r.kind === "error" && r.error.code === "CANCELLED",
      `expected CANCELLED ${JSON.stringify(r)}`,
    );
  });
  await test("reused request id rejected", async () => {
    await request("invoke", {
      command: "test.ping",
      payload: null,
    });
    // reuse the id that was just completed
    const last = `t-${seq}`;
    const p = new Promise((resolve) => pending.set(last, resolve));
    send({
      kind: "invoke",
      id: last,
      command: "test.ping",
      payload: null,
    });
    const dup = await p;
    assert(
      dup.kind === "error" && dup.error.code === "INVALID_ARGUMENT",
      `expected rejection ${JSON.stringify(dup)}`,
    );
  });
  await test("events delivered in order", async () => {
    const l = await listen("test.changed");
    assert(
      l.kind === "result" && l.payload.subscriptionId,
      `listen failed ${JSON.stringify(l)}`,
    );
    const sub = l.payload.subscriptionId;
    const seen = [];
    subs.set(sub, (m) => seen.push(m));
    await call("test.emit", {
      n: 1,
    });
    await call("test.emit", {
      n: 2,
    });
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
    await call("test.emit", {
      n: 3,
    });
    await sleep(150);
    assert(seen.length === 2, "event delivered after unlisten");
  });
  if (nativePlugins) {
    await test("storage roundtrip appData", async () => {
      const w = await call("test.writeNote", {
        name: "a",
        text: "hello 파일",
      });
      assert(
        w.kind === "result" && w.payload.ok,
        `write failed ${JSON.stringify(w)}`,
      );
      const r = await call("test.readNote", {
        name: "a",
      });
      assert(
        r.kind === "result" && r.payload.ok && r.payload.value === "hello 파일",
        `read failed ${JSON.stringify(r)}`,
      );
    });
    await test("junction inside appData cannot bypass pathPrefix", async () => {
      const r = await call("test.readEscape", {
        path: "notes/internal-link/x.txt",
      });
      assert(
        r.kind === "result" &&
          r.payload.ok === false &&
          r.payload.code === "PERMISSION_DENIED",
        `expected junction denial ${JSON.stringify(r)}`,
      );
      const w = await call("test.writeNote", {
        name: "internal-link/x",
        text: "forbidden",
      });
      assert(
        w.kind === "result" &&
          w.payload.ok === false &&
          w.payload.code === "PERMISSION_DENIED",
        `expected junction write denial ${JSON.stringify(w)}`,
      );
    });
    await test("storage scope escape denied", async () => {
      const r = await call("test.readEscape", {
        path: "secrets/x.txt",
      });
      assert(
        r.kind === "result" &&
          r.payload.ok === false &&
          r.payload.code === "PERMISSION_DENIED",
        `expected denial ${JSON.stringify(r)}`,
      );
    });
    await test("storage traversal denied", async () => {
      const r = await call("test.readEscape", {
        path: "../x.txt",
      });
      assert(
        r.kind === "result" &&
          r.payload.ok === false &&
          r.payload.code === "INVALID_ARGUMENT",
        `expected rejection ${JSON.stringify(r)}`,
      );
    });
    await test("storage symlink denied", async () => {
      // notes/link is a junction planted by the driver pointing outside the scope.
      const r = await call("test.readEscape", {
        path: "notes/link/secret.txt",
      });
      assert(
        r.kind === "result" &&
          r.payload.ok === false &&
          r.payload.code === "PERMISSION_DENIED",
        `expected denial ${JSON.stringify(r)}`,
      );
    });
    await test("temp scope roundtrip", async () => {
      const w = await call("test.tempWrite", {
        path: "scratch.txt",
        text: "tmp",
      });
      assert(
        w.kind === "result" && w.payload.ok,
        `temp write failed ${JSON.stringify(w)}`,
      );
      const r = await call("test.tempRead", {
        path: "scratch.txt",
      });
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
          matchesCapabilities(r.payload.value, r.payload.platform),
        `bad caps ${JSON.stringify(r)}`,
      );
    });
    await test("log.write", async () => {
      const r = await call("test.log", {
        message: "page-log-테스트",
      });
      assert(
        r.kind === "result" && r.payload.ok,
        `log failed ${JSON.stringify(r)}`,
      );
    });
  } else {
    await test("unregistered native plugin command is denied", async () => {
      const outcome = await call("plugin.storage.readText", {
        scope: "appData",
        path: "notes/a.txt",
      });
      assert(
        outcome.error?.code === "PERMISSION_DENIED",
        "unregistered plugin was callable",
      );
    });
  }
  await test("SDK cancellation", async () => {
    const controller = new AbortController();
    const outcome = call("test.hold", null, {
      signal: controller.signal,
    });
    await sleep(100);
    controller.abort();
    assert(
      (await outcome).error?.code === "CANCELLED",
      "SDK cancellation failed",
    );
  });
  if (nativePlugins) {
    await test("SDK Host API cancellation", async () => {
      const controller = new AbortController();
      const outcome = call("test.hostCancel", null, {
        signal: controller.signal,
      });
      if (new URL(location.href).searchParams.has("hostCancelBarrier")) {
        // Native delayed-op tests require Host dispatch before cancellation.
        await call("test.ping");
      } else {
        await Promise.resolve();
      }
      controller.abort();
      assert(
        (await outcome).error?.code === "CANCELLED",
        "Host API cancellation failed",
      );
    });
  }
  await test("command error is safe", async () => {
    const result = await call("test.fail");
    assert(
      result.error?.code === "INTERNAL" &&
        !result.error.message.includes("private"),
      "unsafe command error",
    );
  });
  await test("memo input validation", async () => {
    assert(
      (await call("memo.save", 123)).error?.code === "INVALID_ARGUMENT",
      "invalid memo accepted",
    );
  });
  await test("memo input save event refresh", async () => {
    if (multiView) {
      // The editor checks the same shared memo; finish before overwriting it.
      const deadline = Date.now() + 60000;
      while (
        (
          await call("test.tempRead", {
            path: "editor.json",
          })
        ).payload?.ok !== true
      ) {
        assert(Date.now() < deadline, "editor did not finish its memo checks");
        await sleep(100);
      }
    }
    const input = document.getElementById("memo");
    const display = document.getElementById("saved-memo");
    const release = await client.listen(
      "memo.saved",
      (event) => {
        display.textContent = event.payload;
      },
      {
        onError: (error) => {
          display.textContent = error.code;
        },
      },
    );
    input.value = "재실행 후에도 남는 메모 😀";
    await client.invoke("memo.save", input.value);
    const savedDeadline = Date.now() + 5000;
    while (display.textContent !== input.value && Date.now() < savedDeadline) {
      await sleep(25);
    }
    assert(
      display.textContent === input.value,
      "completion event did not update screen",
    );
    assert(
      (await client.invoke("memo.read", null)) === input.value,
      "memo read differs",
    );
    await release();
  });
  await test("remote iframe never navigates", async () => {
    // Behavior-level check: a blocked subframe stays on the initial empty
    // document instead of reaching the remote URL (works on every platform —
    // does not rely on a host log event).
    const frame = document.getElementById("remote-frame");
    await sleep(300);
    let href = "inaccessible";
    try {
      href = frame.contentWindow.location.href;
    } catch {
      href = "inaccessible";
    }
    assert(
      href === "about:blank" || href === "",
      `remote iframe was not blocked: ${href}`,
    );
  });

  await report(results);
  await sleep(200);
  location.assign(nativePlugins ? "page2.html" : "page2.html?nativePlugins=0");
}

async function report(results) {
  await call("test.report", {
    file: "report.json",
    report: {
      page: "index",
      results,
    },
  });
}

const statusEl = document.getElementById("status");
run()
  .then(() => {
    statusEl.textContent = "done";
  })
  .catch(async (e) => {
    statusEl.textContent = "failed";
    try {
      await report([
        {
          name: "run",
          ok: false,
          error: String(e?.message ?? e),
        },
      ]);
    } catch {}
    try {
      location.assign("page2.html");
    } catch {}
  });

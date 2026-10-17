import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { controlsClientReadiness } from "../../fixtures/macos-webview-controls/readiness.ts";

const count = Number(process.argv[2]);
assert(Number.isInteger(count) && count > 0);
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-controls-ready-"));
const path = "/next.html";
const arrivals = new Map([
  [
    path,
    count - 1,
  ],
]);
const held = new Map([
  [
    path,
    count - 1,
  ],
]);
const arrived = Promise.withResolvers();
const arrivalChecked = Promise.withResolvers();
const loadingChecked = Promise.withResolvers();
const messages = new Set();
const pageEvents = new Map();
const protocol = {
  major: 1,
  minor: 0,
};
const state = {
  url: `http://127.0.0.1:12345${path}`,
  title: path,
  loading: false,
  canGoBack: true,
  canGoForward: false,
  zoomFactor: 5,
  focused: false,
};
const emit = (message) => {
  for (const listener of messages) {
    listener({
      data: message,
    });
  }
};
const bridge = {
  addEventListener(_type, listener) {
    messages.add(listener);
  },
  removeEventListener(_type, listener) {
    messages.delete(listener);
  },
  postMessage(message) {
    queueMicrotask(() => {
      if (message.kind === "hello") {
        emit({
          kind: "hello",
          protocol,
          features: [],
          buildId: "fixture",
        });
        return;
      }
      if (message.kind !== "invoke") {
        return;
      }
      switch (message.command) {
        case "plugin.windows.getWebViewState":
          emit({
            kind: "result",
            protocol,
            id: message.id,
            payload: state,
          });
          break;
        case "plugin.windows.reloadWebView":
          emit({
            kind: "error",
            protocol,
            id: message.id,
            error: {
              code: "PERMISSION_DENIED",
              message: "Fixture grant",
            },
          });
          break;
        case "test.arrived":
          arrivals.set(path, count);
          // Hold the actual SDK result. The browser cannot submit test.hold yet.
          arrived.resolve(message.id);
          break;
        case "test.hold":
          held.set(path, count);
          break;
        default:
          throw new Error(`Unexpected fixture command: ${message.command}`);
      }
    });
  },
};

try {
  const build = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../../fixtures/macos-webview-controls/web.js"),
    ],
    target: "browser",
  });
  assert(build.success, build.logs.map(String).join("\n"));
  assert(build.outputs[0]);
  const bundle = resolve(directory, "web.mjs");
  await Bun.write(bundle, await build.outputs[0].text());
  // This child owns its browser globals; the parent test process is untouched.
  globalThis.document = {
    readyState: "complete",
    title: path,
    querySelector: () => null,
  };
  globalThis.location = {
    pathname: path,
    href: state.url,
  };
  globalThis.addEventListener = (type, listener) =>
    pageEvents.set(type, listener);
  globalThis.window = {
    document,
    chrome: {
      webview: bridge,
    },
    addEventListener,
    removeEventListener: (type) => pageEvents.delete(type),
  };
  const browser = import(pathToFileURL(bundle).href);
  const arrivalId = await arrived.promise;
  let navigated = false;
  const ready = controlsClientReadiness({
    arrivals,
    held,
    isLoading: async () => state.loading,
    async waitFor(check, stage) {
      const deadline = Date.now() + 2000;
      for (;;) {
        const complete = await check();
        if (stage.startsWith("arrival ")) {
          arrivalChecked.resolve(complete);
        } else {
          loadingChecked.resolve(complete);
        }
        if (complete) {
          return;
        }
        assert(Date.now() < deadline, `Readiness did not finish: ${stage}`);
        await Bun.sleep(1);
      }
    },
  });
  const transition = ready(path, count).then(() => {
    navigated = true;
  });
  assert.equal(await arrivalChecked.promise, false);
  assert.equal(arrivals.get(path), count);
  assert.equal(held.get(path), count - 1);
  assert.equal(navigated, false);

  state.loading = true;
  emit({
    kind: "result",
    protocol,
    id: arrivalId,
    payload: null,
  });
  await browser;
  assert.equal(await loadingChecked.promise, false);
  assert.equal(held.get(path), count);
  assert.equal(navigated, false);
  state.loading = false;
  await transition;
  assert.equal(navigated, true);
  console.log(
    JSON.stringify({
      count,
      delayedAckBlocked: true,
      loadingBlocked: true,
      navigated: true,
    }),
  );
} finally {
  await globalThis.window?.[
    Symbol.for("@bunaway/client.default-session.v1")
  ]?.client.close();
  await rm(directory, {
    recursive: true,
    force: true,
  });
}

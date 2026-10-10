// Standalone main-thread checks for the real AppKit/WKWebView integration.

import { ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { MacosConfig } from "#native/macos/bun/config";
import { Objc, type ObjcObject } from "#native/macos/bun/objc";
import { MacosWebview } from "#native/macos/bun/webview";
import { MAX_WINDOW_DIMENSION } from "@bunaway/plugin-api/native";
import type { HostContext } from "@bunaway/protocol";

const BATCH_SIZE = 4_000;
const MAX_RETAINED_GROWTH_BYTES = 64 * 1024 * 1024;
const WK_MEDIA_CAPTURE_CAMERA = 0;
const WK_PERMISSION_DENY = 0;
const directory = await mkdtemp(
  resolve(tmpdir(), "bunaway-webview-regressions-"),
);
const title = `Bunaway regression ${crypto.randomUUID()}`;
const config: MacosConfig = {
  runtime: {
    id: "tests.bunaway.webview-regressions",
    generation: crypto.randomUUID(),
  },
  backendContext: "backend-regression" as HostContext,
  policy: {
    version: 1,
    backend: {
      permissions: [],
    },
    views: [
      {
        id: "main",
        origins: [
          "https://app.bunaway.local",
        ],
        commands: [],
        events: [],
        host: {
          permissions: [],
        },
      },
    ],
  },
  window: {
    view: "main",
    home: "https://app.bunaway.local/index.html",
    title,
    window: {
      width: 800,
      height: 600,
      minWidth: 1200,
      minHeight: 700,
      maxWidth: 1300,
      maxHeight: 900,
    },
  },
  assets: directory,
  dataRoot: directory,
};
let view: MacosWebview | undefined;
let failure: unknown;
let pageReady = false;
let received = 0;
const events: string[] = [];
const hooks = {
  receive(_source: string, raw: string) {
    const message: unknown = JSON.parse(raw);
    if (message && typeof message === "object" && "ready" in message) {
      pageReady = true;
    }
    if (
      message &&
      typeof message === "object" &&
      "received" in message &&
      typeof message.received === "number"
    ) {
      received = message.received;
    }
  },
  revoke() {},
  close() {
    failure = new Error("Regression window closed.");
  },
  tick() {},
  log(event: string) {
    events.push(event);
  },
  fail(error: unknown) {
    failure = error;
  },
};

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (failure) {
      throw failure;
    }
    assert(Date.now() < deadline, "Native regression timed out.");
    await Bun.sleep(5);
  }
}

/** Find only this test's window through AppKit, without inspecting private host fields. */
function nativeWindow(o: Objc): ObjcObject {
  const windows = o.send(
    o.send(o.class("NSApplication"), "sharedApplication"),
    "windows",
  );
  for (let index = 0; index < Number(o.send(windows, "count")); index++) {
    const window = o.send(windows, "objectAtIndex:", index);
    if (window && o.text(o.send(window, "title")) === config.window.title) {
      return window;
    }
  }
  throw new Error("Regression window not found.");
}

/** KVC boxes the native struct so the test can read doubles without a struct-return FFI. */
function dimensions(
  o: Objc,
  object: ObjcObject,
  key: string,
  count: number,
): number[] {
  const bytes = Buffer.alloc(count * 8);
  o.send(
    o.send(object, "valueForKey:", o.string(key)),
    "getValue:size:",
    ptr(bytes),
    bytes.length,
  );
  return Array.from(
    {
      length: count,
    },
    (_, index) => bytes.readDoubleLE(index * 8),
  );
}

async function ruleIdentifiers(o: Objc): Promise<string[]> {
  let result: string[] | undefined;
  o.withAutoreleasePool(() =>
    o.send(
      o.send(o.class("WKContentRuleListStore"), "defaultStore"),
      "getAvailableContentRuleListIdentifiers:",
      o.block(1, (_block, list) => {
        result = Array.from(
          {
            length: Number(o.send(list ?? null, "count")),
          },
          (_, index) => o.text(o.send(list ?? null, "objectAtIndex:", index)),
        );
      }),
    ),
  );
  await waitFor(() => result !== undefined);
  assert(result);
  return result;
}

try {
  await mkdir(resolve(directory, "web"));
  await Bun.write(
    resolve(directory, "web/index.html"),
    `<!doctype html><title>Regression</title>
<script>
let received = 0;
window.chrome.webview.addEventListener('message', () => {
  if (++received % ${BATCH_SIZE} === 0) window.chrome.webview.postMessage({received});
});
window.chrome.webview.postMessage(new Date());
window.chrome.webview.postMessage({payload: new Date()});
window.chrome.webview.postMessage([new Date()]);
window.chrome.webview.postMessage({ready: true});
</script>`,
  );
  const o = new Objc();
  view = new MacosWebview(config, hooks);
  await view.ready;
  view.start();
  await waitFor(() => pageReady);
  assert.equal(
    events.filter((event) => event === "web-message-rejected").length,
    3,
  );
  console.log(
    "PASS invalid native JSON values are rejected before valid bridge traffic",
  );

  o.withAutoreleasePool(() => {
    const window = nativeWindow(o);
    assert.deepEqual(
      dimensions(o, window, "contentMinSize", 2),
      [
        1200,
        700,
      ],
    );
    assert.deepEqual(
      dimensions(o, window, "contentMaxSize", 2),
      [
        1300,
        900,
      ],
    );
    const content = o.send(window, "contentView");
    assert(content);
    assert.deepEqual(
      dimensions(o, content, "frame", 4).slice(2),
      [
        1200,
        700,
      ],
    );
    const webview = o.send(o.send(content, "subviews"), "objectAtIndex:", 0);
    const delegate = o.send(webview, "UIDelegate");
    assert(delegate, "WebKit media permission delegate must be installed.");
    let decisions = 0;
    let decision: number | undefined;
    // Invoke WebKit's installed delegate with a real native decision block, without opening a device.
    o.send(
      delegate,
      "webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:",
      webview,
      null,
      null,
      WK_MEDIA_CAPTURE_CAMERA,
      o.block(1, (_block, value) => {
        decisions++;
        decision = Number(value);
      }),
    );
    assert.equal(decisions, 1);
    assert.equal(decision, WK_PERMISSION_DENY);
    assert(events.includes("permission-request-denied"));
  });
  console.log("PASS native size constraints and media permission denial");

  const rss: number[] = [];
  for (let batch = 0; batch < 6; batch++) {
    for (let index = 0; index < BATCH_SIZE; index++) {
      view.deliver(
        JSON.stringify({
          batch,
          index,
          payload: "x".repeat(4096),
        }),
      );
    }
    await waitFor(() => received === (batch + 1) * BATCH_SIZE);
    await Bun.sleep(50);
    Bun.gc(true);
    rss.push(process.memoryUsage.rss());
  }
  assert(rss[0] !== undefined && rss.at(-1) !== undefined);
  const growth = (rss.at(-1) ?? 0) - rss[0];
  assert(
    growth < MAX_RETAINED_GROWTH_BYTES,
    `Native response memory grew by ${growth} bytes.`,
  );
  console.log(
    "PASS response memory",
    JSON.stringify({
      messages: 6 * BATCH_SIZE,
      payloadBytes: 4096,
      rss,
      growth,
    }),
  );

  const identifier = `bunaway-${config.runtime.id}-${config.window.view}`;
  assert.deepEqual(
    (await ruleIdentifiers(o)).filter((id) => id.startsWith(identifier)),
    [
      identifier,
    ],
  );
  view.close();
  config.runtime.generation = crypto.randomUUID();
  config.window.title = `${title} reopened`;
  config.window.window = {
    width: 800,
    height: 600,
    minWidth: null,
    maxHeight: null,
  };
  view = new MacosWebview(config, hooks);
  await view.ready;
  o.withAutoreleasePool(() => {
    const window = nativeWindow(o);
    assert.deepEqual(
      dimensions(o, window, "contentMinSize", 2),
      [
        0,
        0,
      ],
    );
    assert(
      dimensions(o, window, "contentMaxSize", 2).every(
        (dimension) => dimension > MAX_WINDOW_DIMENSION,
      ),
    );
  });
  assert.deepEqual(
    (await ruleIdentifiers(o)).filter((id) => id.startsWith(identifier)),
    [
      identifier,
    ],
  );
  console.log(
    "PASS unbounded dimensions and rule reuse across runtime generations",
  );
  if (failure) {
    throw failure;
  }
} finally {
  view?.close();
  await rm(directory, {
    recursive: true,
    force: true,
  });
}
process.exit(0);

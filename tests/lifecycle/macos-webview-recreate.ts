// Standalone main-thread checks for replacing a WKWebView whose initial load never starts.
// A test hook stalls the load the way WebKit does (the policy decision is out, nothing follows),
// so the replacement path runs deterministically on the real AppKit/WKWebView integration.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { HostContext } from "@bunaway/protocol";
import { MacosApplication } from "#native/macos/bun/application";
import type { MacosConfig } from "#native/macos/bun/config";
import { Objc, type ObjcObject } from "#native/macos/bun/objc";
import { MacosWebview } from "#native/macos/bun/webview";
import { PROVISIONAL_STALL_MS } from "#native/macos/bun/webview-diagnostics";
import { waitFor as poll } from "../fixtures/deadlines.ts";

const WK_NAVIGATION_CANCEL = 0;
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-webview-recreate-"));
const config: Omit<MacosConfig, "windows" | "appMetadata"> & {
  window: import("@bunaway/plugin-api/native").WindowSpec;
} = {
  runtime: {
    id: "tests.bunaway.webview-recreate",
    generation: crypto.randomUUID(),
  },
  backendContext: "backend-recreate" as HostContext,
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
    title: `Bunaway recreate ${crypto.randomUUID()}`,
    window: {
      width: 800,
      height: 600,
    },
  },
  assets: directory,
  dataRoot: directory,
};

interface LogRecord {
  event: string;
  fields: Record<string, unknown>;
}
const records: LogRecord[] = [];
let failure: unknown;
let readyMessages = 0;
let documentCompletions = 0;
let revokes = 0;
let clock = 1_000_000;
/** Views up to this generation stall their load; later ones load for real. */
let stallUpTo = 1;
/** Whether the test clock keeps jumping after the first replacement (the replacement stalls too). */
let clockRunsAfterReplacement = false;
const hooks = {
  activated() {},
  documentComplete() {
    documentCompletions++;
  },
  receive(_source: string, raw: string) {
    const message: unknown = JSON.parse(raw);
    if (message && typeof message === "object" && "ready" in message) {
      readyMessages++;
    }
  },
  revoke() {
    revokes++;
  },
  close() {
    failure = new Error("Recreate window closed.");
  },
  log(event: string, fields?: object) {
    records.push({
      event,
      fields: {
        ...fields,
      },
    });
  },
  fail(error: unknown) {
    failure = error;
  },
};
const testHooks = {
  stallLoad: (generation: number) => generation <= stallUpTo,
  now: () => clock,
};

const stages = (stage: string) =>
  records.filter(
    ({ event, fields }) => event === "webview-stage" && fields.stage === stage,
  );
const events = (event: string) =>
  records.filter((record) => record.event === event);

/** Poll until the check holds; a failure the host reported ends the wait at once. */
function eventually(check: () => boolean, what: string): Promise<true> {
  return poll(() => check() || undefined, {
    deadline: "childStep",
    what,
    failed: () => failure,
  }).then(() => true as const);
}

/**
 * One window scan tick per call. While the first view is being replaced the test clock jumps one
 * stall interval per tick; afterwards it stands still, so the view in use is never judged stalled.
 */
async function tick(view: MacosWebview): Promise<void> {
  if (clockRunsAfterReplacement || stages("view-recreated").length === 0) {
    clock += PROVISIONAL_STALL_MS + 1;
  }
  view.observeStartup();
  await Bun.sleep(10);
}

function subviews(o: Objc, title: string): ObjcObject[] {
  const windows = o.send(
    o.send(o.class("NSApplication"), "sharedApplication"),
    "windows",
  );
  const found: ObjcObject[] = [];
  for (let index = 0; index < Number(o.send(windows, "count")); index++) {
    const window = o.send(windows, "objectAtIndex:", index);
    if (window && o.text(o.send(window, "title")) === title) {
      const views = o.send(o.send(window, "contentView"), "subviews");
      for (let at = 0; at < Number(o.send(views, "count")); at++) {
        const view = o.send(views, "objectAtIndex:", at);
        if (view) {
          found.push(view);
        }
      }
    }
  }
  return found;
}

const application = new MacosApplication({
  stopping: () => false,
  quitRequested: () => {},
  sessionEnding: () => {},
  reopened: () => {},
  openUrlsRequested: () => {},
  tick: () => {},
  fail: (error) => {
    failure = error;
  },
});
let view: MacosWebview | undefined;
try {
  await mkdir(resolve(directory, "web"));
  await Bun.write(
    resolve(directory, "web/index.html"),
    `<!doctype html><title>Recreate</title>
<script>window.chrome.webview.postMessage({ready: true});</script>`,
  );
  const o = new Objc();

  // 1. The first view stalls through every retry; one replacement loads the page.
  view = new MacosWebview(config, hooks, application, testHooks);
  await view.ready;
  view.start();
  const [stalledView] = subviews(o, config.window.title);
  assert(stalledView, "The first view must be in the window.");
  const stalledDelegate = o.send(stalledView, "navigationDelegate");
  assert(stalledDelegate, "The first view must have a navigation delegate.");
  // Keep both alive past the replacement so late calls can still be made on them.
  o.send(stalledView, "retain");
  o.send(stalledDelegate, "retain");
  while (stages("view-recreated").length === 0) {
    await tick(view);
    if (failure) {
      throw failure;
    }
    assert(
      stages("load-retried").length <= 3,
      "A stalled view must be replaced after three retries.",
    );
  }
  await eventually(() => readyMessages > 0, "the page to reach the host");
  assert.equal(stages("load-retried").length, 3);
  assert.equal(stages("view-recreated").length, 1);
  assert.equal(stages("load-stalled").length, 0);
  assert.equal(events("webview-load-stalled").length, 0);
  const firstIndex = stages("view-recreated")[0]?.fields.viewIndex;
  const loads = stages("load-returned");
  assert.notEqual(loads.at(-1)?.fields.viewIndex, firstIndex);
  assert.equal(loads[0]?.fields.viewIndex, firstIndex);
  await Bun.sleep(300);
  assert.equal(readyMessages, 1, "The page must reach the host exactly once.");
  o.withAutoreleasePool(() => {
    const [current, ...others] = subviews(o, config.window.title);
    assert(
      current && others.length === 0,
      "One view must remain in the window.",
    );
    assert.notEqual(current, stalledView);
    const scripts = o.send(
      o.send(o.send(current, "configuration"), "userContentController"),
      "userScripts",
    );
    assert.equal(Number(o.send(scripts, "count")), 1);
  });
  console.log("PASS a stalled initial load is replaced once and then loads");

  // 2. Late calls of the replaced view change nothing in the window.
  await eventually(() => documentCompletions > 0, "the document to finish");
  const before = {
    completions: documentCompletions,
    revokes,
    records: records.length,
  };
  o.withAutoreleasePool(() => {
    o.send(
      stalledDelegate,
      "webView:didStartProvisionalNavigation:",
      stalledView,
      null,
    );
    o.send(stalledDelegate, "webView:didFinishNavigation:", stalledView, null);
    o.send(
      stalledDelegate,
      "webViewWebContentProcessDidTerminate:",
      stalledView,
    );
    let decisions = 0;
    let decision: number | undefined;
    o.send(
      stalledDelegate,
      "webView:decidePolicyForNavigationAction:decisionHandler:",
      stalledView,
      null,
      o.block(1, (_block, value) => {
        decisions++;
        decision = Number(value);
      }),
    );
    assert.equal(decisions, 1, "WebKit still gets exactly one answer.");
    assert.equal(decision, WK_NAVIGATION_CANCEL);
  });
  assert.equal(documentCompletions, before.completions);
  assert.equal(revokes, before.revokes);
  assert.equal(records.length, before.records);
  console.log("PASS late calls of the replaced view do not reach the window");
  view.close();

  // 3. A replacement that stalls too is reported, and no further view is made.
  stallUpTo = Number.POSITIVE_INFINITY;
  clockRunsAfterReplacement = true;
  clock += 1_000_000;
  config.runtime.generation = crypto.randomUUID();
  config.window.title = `${config.window.title} again`;
  records.length = 0;
  readyMessages = 0;
  view = new MacosWebview(config, hooks, application, testHooks);
  await view.ready;
  view.start();
  while (events("webview-load-stalled").length === 0) {
    await tick(view);
    if (failure) {
      throw failure;
    }
    assert(stages("load-requested").length < 20, "The stall must be reported.");
  }
  for (let extra = 0; extra < 6; extra++) {
    await tick(view);
  }
  assert.equal(stages("view-recreated").length, 1);
  assert.equal(events("webview-load-stalled").length, 1);
  assert.equal(stages("load-stalled").length, 1);
  assert.equal(stages("load-retried").length, 6);
  assert.equal(readyMessages, 0);
  o.withAutoreleasePool(() => {
    assert.equal(subviews(o, config.window.title).length, 1);
  });
  console.log("PASS a replacement that stalls again is reported as a stall");
  if (failure) {
    throw failure;
  }
} finally {
  view?.close();
  application.close();
  await rm(directory, {
    recursive: true,
    force: true,
  });
}
process.exit(0);

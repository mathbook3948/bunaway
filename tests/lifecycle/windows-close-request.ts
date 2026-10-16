import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "@bunaway/backend";
import windows, { windowEvents } from "@bunaway/plugin-windows";
import {
  type HostContext,
  type Policy,
  validateValue,
} from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

// Real Win32 and WebView2 gate for `windows.closeRequested` and `windows.respondClose`.
// The main window's page declines its first close and accepts its second after a simulated save.
// The observer window reports `windows.lifecycle` and accepts its own close, which is the last one.
assert.equal(process.platform, "win32");
const WM_CLOSE = 0x0010;
const WM_COMMAND = 0x0111;
const IDNO = 7n;
const DIALOG_POLL_MS = 20;
/** The declined window must stay open at least this long before the second close is requested. */
const STAYS_OPEN_MS = 400;
const WAIT_TIMEOUT_MS = 20_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const views = [
  "main",
  "observer",
];
const root =
  process.env.BUNAWAY_CLOSE_REQUEST_TEST_ROOT ??
  resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-close-request");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/close-request.js"),
    ],
    target: "browser",
  });
  assert(web.success && web.outputs[0], web.logs.map(String).join("\n"));
  await writeFile(resolve(assets, "web/app.js"), await web.outputs[0].text());
  for (const view of views) {
    await writeFile(
      resolve(assets, `web/${view}.html`),
      '<!doctype html><script type="module" src="app.js"></script>',
    );
  }
  const entry = await bundleNativeWorker(
    "windows-close-request",
    assets,
    fileURLToPath(import.meta.url),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fileURLToPath(entry),
      "--child",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        BUNAWAY_CLOSE_REQUEST_TEST_ROOT: root,
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill(), SCENARIO_TIMEOUT_MS);
  try {
    assert.equal(await child.exited, 0, `${await stderr}\n${await stdout}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.pass, true);
    console.log(
      "PASS Windows close requests: app decision, decline, accept, last-window quit",
      report,
    );
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
} else {
  const permissions: Policy["backend"] = {
    permissions: windowPermissions(),
  };
  const policy: Policy = {
    version: 1,
    backend: permissions,
    views: views.map((id) => ({
      id,
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "test.ready",
        "test.requested",
        "test.answering",
        "test.answered",
        "test.lifecycle",
        "test.failed",
        "plugin.windows.respondClose",
      ],
      events:
        id === "observer"
          ? [
              "windows.closeRequested",
              "windows.lifecycle",
            ]
          : [
              "windows.closeRequested",
            ],
      host: {
        permissions:
          id === "observer"
            ? [
                "windows.respondClose",
                "windows.listInstances",
              ]
            : [
                "windows.respondClose",
              ],
      },
    })),
  };
  const user32 = dlopen("user32.dll", {
    FindWindowW: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "u64",
    },
    IsWindow: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    PostMessageW: {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i32",
    },
  });
  const dialogClass = Buffer.from("#32770\0", "utf16le");
  const caption = (view: string) =>
    Buffer.from(`Close request ${view}\0`, "utf16le");
  const findWindow = (view: string) =>
    user32.symbols.FindWindowW(null, ptr(caption(view)));
  /** Ordered observations from the pages and from the host's own hooks. */
  const order: string[] = [];
  const ready = new Set<string>();
  const failures: string[] = [];
  let confirmations = 0;
  let mainWindowId = "";
  let task: Promise<void> | undefined;
  let exerciseFailure: unknown;

  async function waitFor(check: () => boolean, message: string) {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!check()) {
      assert(failures.length === 0, failures.join("\n"));
      assert(Date.now() < deadline, message);
      await Bun.sleep(10);
    }
  }
  /** A confirmation box here means the app's decision did not replace it; dismiss it so the run ends. */
  const dialogs = setInterval(() => {
    for (const view of views) {
      const dialog = user32.symbols.FindWindowW(
        ptr(dialogClass),
        ptr(caption(view)),
      );
      if (dialog) {
        confirmations++;
        user32.symbols.PostMessageW(dialog, WM_COMMAND, IDNO, 0n);
      }
    }
  }, DIALOG_POLL_MS);

  async function exercise() {
    await waitFor(
      () => ready.has("main") && ready.has("observer"),
      "Both pages must subscribe before the first close",
    );
    const main = {
      view: "main",
    };
    mainWindowId = (await windows.getReadiness(main)).windowId;
    // A declined confirmation would keep the window open, so any accepted close proves it was skipped.
    await windows.setCloseConfirmation({
      ...main,
      message: "Close main?",
    });
    const mainWindow = findWindow("main");
    assert(mainWindow, "Main window must exist");

    assert(user32.symbols.PostMessageW(mainWindow, WM_CLOSE, 0n, 0n));
    await waitFor(
      () => order.includes("requested:main:1"),
      "The first close must ask the page",
    );
    // A repeated native close while the page decides is coalesced into the same request.
    assert(user32.symbols.PostMessageW(mainWindow, WM_CLOSE, 0n, 0n));
    await waitFor(
      () => order.includes("answered:main:1"),
      "The page must be able to decline",
    );
    await Bun.sleep(STAYS_OPEN_MS);
    assert(
      user32.symbols.IsWindow(mainWindow),
      "A declined close keeps the window",
    );
    assert.equal(await windows.isDestroyed(main), false);
    assert.equal(
      order.includes("requested:main:2"),
      false,
      "A coalesced close must not ask again",
    );

    assert(user32.symbols.PostMessageW(mainWindow, WM_CLOSE, 0n, 0n));
    await waitFor(
      () => order.includes("lifecycle:closed"),
      "An accepted close must close the window",
    );
    await waitFor(
      () => order.includes("lifecycle:destroyed"),
      "A closed window must release its native resources",
    );
    assert.equal(user32.symbols.IsWindow(mainWindow), 0);
    assert.equal(confirmations, 0, "The accepted close showed a confirmation");

    // The observer is the last window: its accepted close continues to the quit request.
    const observerWindow = findWindow("observer");
    assert(observerWindow, "Observer window must exist");
    assert(user32.symbols.PostMessageW(observerWindow, WM_CLOSE, 0n, 0n));
    await waitFor(
      () => order.includes("quit:last-window"),
      "The last accepted close must ask beforeQuit",
    );
  }

  const app = defineApp({
    modules: [],
    plugins: [
      windows,
      {
        name: "close-request-test",
        version: "1.0.0",
        async setup() {
          task = exercise().catch(async (error) => {
            exerciseFailure = error;
            console.error(error);
            for (const view of views) {
              await windows
                .destroy({
                  view,
                })
                .catch(() => {});
            }
          });
        },
      },
    ],
    desktop: {
      beforeQuit(reason) {
        order.push(`quit:${reason}`);
        return true;
      },
    },
    commands: {
      "test.ready": {
        input: {
          type: "string",
        },
        output: {
          const: null,
        },
        async run(input: unknown) {
          ready.add(String(input));
          return null;
        },
      },
      "test.requested": {
        input: windowEvents["windows.closeRequested"],
        output: {
          const: null,
        },
        async run(input: unknown) {
          const event = validateValue(
            windowEvents["windows.closeRequested"],
            input,
          );
          order.push(`requested:${event.viewId}:${event.requestId}`);
          return null;
        },
      },
      "test.answering": {
        input: {
          type: "object",
          properties: {
            view: {
              type: "string",
            },
            requestId: {
              type: "integer",
            },
            allow: {
              type: "boolean",
            },
          },
          required: [
            "view",
            "requestId",
            "allow",
          ],
          additionalProperties: false,
        },
        output: {
          const: null,
        },
        async run(input: { view: string; requestId: number; allow: boolean }) {
          order.push(
            `answering:${input.view}:${input.requestId}:${input.allow}`,
          );
          return null;
        },
      },
      "test.answered": {
        input: {
          type: "object",
          properties: {
            view: {
              type: "string",
            },
            requestId: {
              type: "integer",
            },
          },
          required: [
            "view",
            "requestId",
          ],
          additionalProperties: false,
        },
        output: {
          const: null,
        },
        async run(input: { view: string; requestId: number }) {
          order.push(`answered:${input.view}:${input.requestId}`);
          return null;
        },
      },
      "test.lifecycle": {
        input: windowEvents["windows.lifecycle"],
        output: {
          const: null,
        },
        async run(input: unknown) {
          const event = validateValue(windowEvents["windows.lifecycle"], input);
          if (
            event.windowId === mainWindowId &&
            (event.phase === "closed" || event.phase === "destroyed")
          ) {
            order.push(`lifecycle:${event.phase}`);
          }
          return null;
        },
      },
      "test.failed": {
        input: {
          type: "string",
        },
        output: {
          const: null,
        },
        async run(input: unknown) {
          failures.push(String(input));
          return null;
        },
      },
    },
  });
  const dataRoot = resolve(output, `data-${process.pid}`);
  await runWindowsApp(app, {
    runtime: {
      id: "close-request",
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    assets,
    dataRoot,
    loader: resolve(
      root,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    windows: views.map((view) => ({
      view,
      title: `Close request ${view}`,
      home: `https://app.bunaway.local/${view}.html`,
      window: {
        width: 400,
        height: 300,
      },
    })),
  });
  clearInterval(dialogs);
  await task;
  user32.close();
  if (exerciseFailure) {
    throw exerciseFailure;
  }
  assert.deepEqual(order, [
    "requested:main:1",
    "answering:main:1:false",
    "answered:main:1",
    "requested:main:2",
    "answering:main:2:true",
    "lifecycle:closed",
    "lifecycle:destroyed",
    "requested:observer:1",
    "answering:observer:1:true",
    "quit:last-window",
  ]);
  assert.equal(confirmations, 0);
  await writeFile(
    reportPath,
    JSON.stringify({
      pass: true,
      order,
    }),
  );
}

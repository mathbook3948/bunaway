import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CommandContext, defineApp } from "@bunaway/backend";
import windows from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

assert.equal(process.platform, "win32");
const root =
  process.env.BUNAWAY_WEBVIEW_TEST_ROOT ?? resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-webview-controls");
const assets = resolve(output, "assets");
const reportPath = resolve(root, "build/windows-webview-controls-results.json");
/** Unique caption so FindWindowW cannot match an unrelated desktop window. */
const windowCaption = (view: string) => `Bunaway WebView controls ${view}`;
// Win32 SendInput constants for one absolute left click.
const INPUT_SIZE = 40;
const INPUT_MOUSE = 0;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const ABSOLUTE_COORDINATE_RANGE = 65535;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const SHORT_FOCUS_WAIT_MS = 1_500;

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/webview-controls.js"),
    ],
    target: "browser",
  });
  assert(web.success, web.logs.map(String).join("\n"));
  assert(web.outputs[0]);
  await writeFile(resolve(assets, "webview.js"), await web.outputs[0].text());
  const entry = await bundleNativeWorker(
    "windows-webview-controls",
    assets,
    fileURLToPath(import.meta.url),
  );
  const reports: unknown[] = [];
  for (const mode of [
    "production",
    "development",
  ]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        fileURLToPath(entry),
        "--child",
        mode,
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          BUNAWAY_WEBVIEW_TEST_ROOT: root,
        },
      },
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const timer = setTimeout(() => child.kill(), 90_000);
    try {
      assert.equal(await child.exited, 0, `${await stderr}\n${await stdout}`);
      const report = JSON.parse(
        await readFile(resolve(output, `${mode}.json`), "utf8"),
      );
      assert.equal(report.pass, true);
      reports.push(report);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) {
        child.kill();
      }
      await child.exited;
    }
  }
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        pass: true,
        reports,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS actual WebView2 controls: state, origin and redirect denial, history, reload, stop, session cancellation, zoom and development-only DevTools",
    reports,
  );
} else {
  const development = process.argv.includes("development");
  const mode = development ? "development" : "production";
  const script = await readFile(resolve(assets, "webview.js"), "utf8");
  let releaseSlow: () => void = () => {};
  const slow = new Promise<void>((done) => {
    releaseSlow = done;
  });
  let outsideRequests = 0;
  const outside = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      outsideRequests++;
      return new Response("Outside");
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/webview.js") {
        return new Response(script, {
          headers: {
            "Content-Type": "text/javascript",
          },
        });
      }
      if (url.pathname === "/redirect.html") {
        return Response.redirect(`${outside.url.origin}/outside.html`);
      }
      if (url.pathname === "/slow.html") {
        await slow;
      }
      return new Response(
        `<!doctype html><title>${url.pathname}</title><script type="module" src="/webview.js"></script>`,
        {
          headers: {
            "Content-Type": "text/html",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'",
          },
        },
      );
    },
  });
  const origin = server.url.origin;
  const arrivals = new Map<string, number>();
  let heldCalls = 0;
  let cancelledCalls = 0;
  let completed = false;
  let failure: unknown;
  let exerciseTask: Promise<void> | undefined;
  const main = {
    view: "main",
  };
  const waitFor = async (check: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
      assert(Date.now() < deadline, "WebView control scenario timed out");
      await Bun.sleep(10);
    }
  };
  const input = dlopen("user32.dll", {
    FindWindowW: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "u64",
    },
    GetWindowRect: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    GetSystemMetrics: {
      args: [
        "i32",
      ],
      returns: "i32",
    },
    SendInput: {
      args: [
        "u32",
        "ptr",
        "i32",
      ],
      returns: "u32",
    },
  });
  /**
   * Send a real left click at the center of a window, as a user would to give its WebView
   * keyboard focus. Test-only: host code never moves focus on behalf of a state read.
   */
  const clickWindowCenter = (view: string) => {
    const caption = windowCaption(view);
    const hwnd = input.symbols.FindWindowW(
      null,
      ptr(Buffer.from(`${caption}\0`, "utf16le")),
    );
    assert(hwnd !== 0n, `Window ${caption} was not found`);
    const rect = new Int32Array(4);
    assert(input.symbols.GetWindowRect(hwnd, ptr(rect)));
    const [left = 0, top = 0, right = 0, bottom = 0] = rect;
    const screenWidth = input.symbols.GetSystemMetrics(SM_CXSCREEN);
    const screenHeight = input.symbols.GetSystemMetrics(SM_CYSCREEN);
    const x = Math.round(
      (((left + right) / 2) * ABSOLUTE_COORDINATE_RANGE) / (screenWidth - 1),
    );
    const y = Math.round(
      (((top + bottom) / 2) * ABSOLUTE_COORDINATE_RANGE) / (screenHeight - 1),
    );
    const steps = [
      MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
      MOUSEEVENTF_LEFTDOWN,
      MOUSEEVENTF_LEFTUP,
    ];
    const events = Buffer.alloc(INPUT_SIZE * steps.length);
    steps.forEach((flags, index) => {
      const base = INPUT_SIZE * index;
      events.writeUInt32LE(INPUT_MOUSE, base);
      events.writeInt32LE(x, base + 8);
      events.writeInt32LE(y, base + 12);
      events.writeUInt32LE(flags, base + 20);
    });
    assert.equal(
      input.symbols.SendInput(steps.length, ptr(events), INPUT_SIZE),
      steps.length,
    );
  };
  const isMainWebViewFocused = async () =>
    (await windows.getWebViewState(main)).focused;
  /** Wait until the main WebView holds keyboard focus, clicking only if activation alone is not enough. */
  const focusMainWebView = async () => {
    await windows.focus(main);
    const deadline = Date.now() + SHORT_FOCUS_WAIT_MS;
    while (Date.now() < deadline && !(await isMainWebViewFocused())) {
      await Bun.sleep(10);
    }
    if (!(await isMainWebViewFocused())) {
      clickWindowCenter("main");
    }
    await waitFor(isMainWebViewFocused);
  };
  const ready = async (path: string, count = 1) => {
    await waitFor(() => (arrivals.get(path) ?? 0) >= count);
    await waitFor(async () => {
      const state = await windows.getReadiness(main);
      return state.document === "ready" && state.sdk === "ready";
    });
  };
  async function exercise() {
    await ready("/index.html");
    await waitFor(
      () =>
        arrivals.has("/peer.html") &&
        arrivals.has("/denied.html") &&
        heldCalls >= 1,
    );
    const initial = await windows.getReadiness(main);
    const initialState = await windows.getWebViewState(main);
    assert.equal(initialState.title, "/index.html");
    assert.equal(initialState.loading, false);
    // Hidden windows are never the foreground window.
    assert.equal(initialState.focused, false);
    assert.equal(initialState.canGoBack, false);
    assert.equal(initialState.canGoForward, false);
    assert.equal(await windows.goBack(main), false);
    assert.equal(await windows.goForward(main), false);
    const initialZoom = (
      await windows.getWebViewState({
        view: "peer",
      })
    ).zoomFactor;
    assert(
      Math.abs(
        (await windows.setZoomFactor({
          ...main,
          factor: 1.5,
        })) - 1.5,
      ) < 0.001,
    );
    assert(
      Math.abs((await windows.getWebViewState(main)).zoomFactor - 1.5) < 0.001,
    );
    assert.equal(
      (
        await windows.getWebViewState({
          view: "peer",
        })
      ).zoomFactor,
      initialZoom,
    );
    for (const url of [
      `${outside.url.origin}/outside.html`,
      "file:///C:/Windows/win.ini",
      `http://user:password@${server.url.host}/index.html`,
      "javascript:alert(1)",
    ]) {
      await assert.rejects(
        windows.navigateWebView({
          ...main,
          url,
        }),
        {
          code: "PERMISSION_DENIED",
        },
      );
    }
    assert.equal(
      (await windows.getReadiness(main)).documentGeneration,
      initial.documentGeneration,
    );
    assert.equal(
      (await windows.getWebViewState(main)).url,
      `${origin}/index.html`,
    );
    if (development) {
      await windows.openDevTools(main);
    } else {
      await assert.rejects(windows.openDevTools(main), {
        code: "PERMISSION_DENIED",
      });
    }

    await windows.navigateWebView({
      ...main,
      url: `${origin}/next.html`,
    });
    await ready("/next.html");
    await waitFor(() => cancelledCalls >= 1);
    assert.equal((await windows.getReadiness(main)).windowId, initial.windowId);
    assert(
      (await windows.getReadiness(main)).documentGeneration >
        initial.documentGeneration,
    );
    assert.equal((await windows.getWebViewState(main)).canGoBack, true);
    assert.equal(await windows.goBack(main), true);
    await ready("/index.html", 2);
    assert.equal((await windows.getWebViewState(main)).canGoForward, true);
    assert.equal(await windows.goForward(main), true);
    await ready("/next.html", 2);
    const beforeReload = await windows.getReadiness(main);
    await windows.reloadWebView(main);
    await ready("/next.html", 3);
    assert(
      (await windows.getReadiness(main)).documentGeneration >
        beforeReload.documentGeneration,
    );
    const beforeFragment = await windows.getReadiness(main);
    await windows.navigateWebView({
      ...main,
      url: `${origin}/next.html#fragment`,
    });
    await waitFor(async () =>
      (await windows.getWebViewState(main)).url.endsWith("#fragment"),
    );
    assert.equal(
      (await windows.getReadiness(main)).documentGeneration,
      beforeFragment.documentGeneration,
    );

    await windows.navigateWebView({
      ...main,
      url: `${origin}/slow.html`,
    });
    await waitFor(async () => (await windows.getWebViewState(main)).loading);
    await windows.stopWebView(main);
    await waitFor(async () => !(await windows.getWebViewState(main)).loading);
    await waitFor(
      async () => (await windows.getReadiness(main)).document === "cancelled",
    );
    await windows.navigateWebView({
      ...main,
      url: `${origin}/index.html`,
    });
    await ready("/index.html", 3);
    await windows.navigateWebView({
      ...main,
      url: `${origin}/redirect.html`,
    });
    await waitFor(
      async () => (await windows.getReadiness(main)).document === "cancelled",
    );
    assert.equal(outsideRequests, 0, "Disallowed redirect reached its server");
    assert.equal(
      new URL((await windows.getWebViewState(main)).url).origin,
      origin,
    );
    await windows.navigateWebView({
      ...main,
      url: `${origin}/index.html`,
    });
    await ready("/index.html", 4);

    // Focus: peer takes the foreground, then the main WebView regains input focus.
    const peer = {
      view: "peer",
    };
    assert.equal(await windows.isDestroyed(peer), false);
    await windows.focus(peer);
    await waitFor(async () => await windows.isFocused(peer));
    await waitFor(async () => !(await isMainWebViewFocused()));
    await focusMainWebView();
    assert.equal(await windows.isFocused(main), true);
    // Reading state must not move focus.
    const focusBefore = {
      window: await windows.isFocused(main),
      webView: await isMainWebViewFocused(),
    };
    await windows.getWebViewState(main);
    await windows.getWebViewState(peer);
    assert.deepEqual(
      {
        window: await windows.isFocused(main),
        webView: await isMainWebViewFocused(),
      },
      focusBefore,
    );
    await windows.focus(peer);
    await waitFor(async () => !(await isMainWebViewFocused()));
    assert.equal(await windows.isFocused(main), false);

    // Destroyed: a WebView lives exactly as long as its window.
    await windows.close(peer);
    assert.equal(await windows.isDestroyed(peer), true);
    await assert.rejects(
      windows.getWebViewState({
        view: "peer",
      }),
      {
        code: "INVALID_ARGUMENT",
      },
    );
    await windows.close({
      view: "denied",
    });
    completed = true;
    await windows.close(main);
  }
  const policy: Policy = {
    version: 1,
    backend: {
      permissions: windowPermissions(),
    },
    views: [
      "main",
      "peer",
      "denied",
    ].map((id) => ({
      id,
      origins: [
        origin,
      ],
      events: [],
      commands: [
        "test.arrived",
        "test.hold",
        "plugin.windows.getWebViewState",
        "plugin.windows.reloadWebView",
      ],
      host: {
        permissions:
          id === "denied"
            ? []
            : [
                "windows.getWebViewState",
              ],
      },
    })),
  };
  const app = defineApp({
    modules: [],
    events: {},
    plugins: [
      windows,
      {
        name: "webview-control-test",
        version: "1.0.0",
        setup() {
          exerciseTask = exercise().catch(async (error) => {
            if (completed && error?.code === "CANCELLED") {
              return;
            }
            failure = error;
            console.error(error);
            for (const view of [
              "peer",
              "denied",
              "main",
            ]) {
              await windows
                .close({
                  view,
                })
                .catch(() => {});
            }
          });
        },
      },
    ],
    commands: {
      "test.arrived": {
        input: {
          type: "string",
        },
        output: {
          const: null,
        },
        async run(input: unknown) {
          assert.equal(typeof input, "string");
          const path = String(input);
          arrivals.set(path, (arrivals.get(path) ?? 0) + 1);
          return null;
        },
      },
      "test.hold": {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run(_input: unknown, context: CommandContext) {
          heldCalls++;
          await new Promise<void>((done) => {
            if (context.signal.aborted) {
              done();
            } else {
              const cancelled = () => {
                context.signal.removeEventListener("abort", cancelled);
                done();
              };
              context.signal.addEventListener("abort", cancelled);
            }
          });
          cancelledCalls++;
          return null;
        },
      },
    },
  });
  try {
    await runWindowsApp(app, {
      runtime: {
        id: `webview-controls-${mode}`,
        generation: crypto.randomUUID(),
      },
      backendContext: `backend-${crypto.randomUUID()}` as HostContext,
      assets,
      dataRoot: resolve(output, `data-${mode}-${process.pid}`),
      policy,
      devtools: development,
      loader: resolve(
        root,
        "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
      ),
      windows: [
        "main",
        "peer",
        "denied",
      ].map((view) => ({
        view,
        title: windowCaption(view),
        home: `${origin}/${view === "main" ? "index" : view}.html`,
        visible: false,
        window: {
          width: 640,
          height: 480,
        },
      })),
    });
    await exerciseTask;
    if (failure) {
      throw failure;
    }
    assert(completed);
    await writeFile(
      resolve(output, `${mode}.json`),
      JSON.stringify({
        pass: true,
        mode,
        cancelledCalls,
        arrivals: Object.fromEntries(arrivals),
      }),
    );
  } finally {
    releaseSlow();
    await server.stop(true);
    await outside.stop(true);
  }
}

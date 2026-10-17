import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CommandContext, defineApp } from "@bunaway/backend";
import windows from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { testAppMetadata } from "../fixtures/app-info.ts";
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
const GA_ROOT = 2;
const WINDOW_TEXT_CHARS = 256;
// Wait after moving the pointer so the browser sees a hover target before the click.
const POINTER_SETTLE_MS = 150;
const CLICK_ATTEMPTS = 3;
// SetWindowPos Z-order handles (-1, -2) and flags.
const HWND_TOPMOST = -1n;
const HWND_NOTOPMOST = -2n;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const CLICK_ACTIVATION_TIMEOUT_MS = 4_000;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
// Side-by-side layout for the focus scenario; sizes shrink to fit small CI screens.
const LAYOUT_MARGIN = 20;
const MAX_LAYOUT_WIDTH = 440;
const MAX_LAYOUT_HEIGHT = 360;

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
    "PASS actual WebView2 controls: state, origin and redirect denial, history, reload, stop, session cancellation, zoom, WebView focus, destroyed state and development-only DevTools",
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
  const peer = {
    view: "peer",
  };
  /** Poll until `check` holds; `step` names the awaited condition in the timeout message. */
  const waitFor = async (
    check: () => boolean | Promise<boolean>,
    step = "an unnamed condition",
  ) => {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
      assert(
        Date.now() < deadline,
        `WebView control scenario timed out waiting for ${step}`,
      );
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
    GetClientRect: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    ClientToScreen: {
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
    GetForegroundWindow: {
      args: [],
      returns: "u64",
    },
    GetWindowRect: {
      args: [
        "u64",
        "ptr",
      ],
      returns: "i32",
    },
    GetCursorPos: {
      args: [
        "ptr",
      ],
      returns: "i32",
    },
    // POINT is passed by value as one 64-bit register: x in the low half, y in the high half.
    WindowFromPoint: {
      args: [
        "i64",
      ],
      returns: "u64",
    },
    GetAncestor: {
      args: [
        "u64",
        "u32",
      ],
      returns: "u64",
    },
    GetWindowTextW: {
      args: [
        "u64",
        "ptr",
        "i32",
      ],
      returns: "i32",
    },
    IsWindowVisible: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    IsIconic: {
      args: [
        "u64",
      ],
      returns: "i32",
    },
    SetWindowPos: {
      args: [
        "u64",
        "i64",
        "i32",
        "i32",
        "i32",
        "i32",
        "u32",
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
  const findWindow = (view: string) => {
    const caption = windowCaption(view);
    const hwnd = input.symbols.FindWindowW(
      null,
      ptr(Buffer.from(`${caption}\0`, "utf16le")),
    );
    assert(hwnd !== 0n, `Window ${caption} was not found`);
    return hwnd;
  };
  const windowText = (hwnd: bigint) => {
    const text = Buffer.alloc(WINDOW_TEXT_CHARS * 2);
    const length = input.symbols.GetWindowTextW(
      hwnd,
      ptr(text),
      WINDOW_TEXT_CHARS,
    );
    return text.toString("utf16le", 0, length * 2);
  };
  const windowRect = (hwnd: bigint) => {
    const rect = new Int32Array(4);
    input.symbols.GetWindowRect(hwnd, ptr(rect));
    const [left, top, right, bottom] = rect;
    return {
      left,
      top,
      right,
      bottom,
    };
  };
  /** Top-level window and caption of whatever is under a screen point. */
  const windowAtPoint = (x: number, y: number) => {
    const point = (BigInt(y) << 32n) | (BigInt(x) & 0xffff_ffffn);
    const hit = input.symbols.WindowFromPoint(BigInt.asIntN(64, point));
    const root = hit === 0n ? 0n : input.symbols.GetAncestor(hit, GA_ROOT);
    return {
      hit: String(hit),
      root: String(root),
      rootText: windowText(root),
    };
  };
  /**
   * Log where the real input chain stands, so a CI failure shows whether the click missed
   * the target (cursor, window under the point, bounds) or landed without activating it
   * (foreground window, visibility). Diagnostic only; never changes focus.
   */
  const logInputDiagnostics = (
    step: string,
    view: string,
    point?: readonly number[],
  ) => {
    const hwnd = findWindow(view);
    const foreground = input.symbols.GetForegroundWindow();
    const cursor = new Int32Array(2);
    input.symbols.GetCursorPos(ptr(cursor));
    console.log(
      `Focus diagnostics: ${JSON.stringify({
        step,
        view,
        target: String(hwnd),
        targetVisible: input.symbols.IsWindowVisible(hwnd) !== 0,
        targetMinimized: input.symbols.IsIconic(hwnd) !== 0,
        targetRect: windowRect(hwnd),
        foreground: String(foreground),
        foregroundText: windowText(foreground),
        screen: {
          width: input.symbols.GetSystemMetrics(SM_CXSCREEN),
          height: input.symbols.GetSystemMetrics(SM_CYSCREEN),
        },
        clickPoint: point,
        cursor: Array.from(cursor),
        underClickPoint: point
          ? windowAtPoint(point[0] ?? 0, point[1] ?? 0)
          : undefined,
        underCursor: windowAtPoint(cursor[0] ?? 0, cursor[1] ?? 0),
      })}`,
    );
  };
  /** Send one batch of absolute mouse events at a screen point, in physical pixels. */
  const sendMouse = (screenX: number, screenY: number, flags: number[]) => {
    const screenWidth = input.symbols.GetSystemMetrics(SM_CXSCREEN);
    const screenHeight = input.symbols.GetSystemMetrics(SM_CYSCREEN);
    const x = Math.round(
      (screenX * ABSOLUTE_COORDINATE_RANGE) / (screenWidth - 1),
    );
    const y = Math.round(
      (screenY * ABSOLUTE_COORDINATE_RANGE) / (screenHeight - 1),
    );
    const events = Buffer.alloc(INPUT_SIZE * flags.length);
    flags.forEach((flag, index) => {
      const base = INPUT_SIZE * index;
      events.writeUInt32LE(INPUT_MOUSE, base);
      events.writeInt32LE(x, base + 8);
      events.writeInt32LE(y, base + 12);
      events.writeUInt32LE(flag, base + 20);
    });
    assert.equal(
      input.symbols.SendInput(flags.length, ptr(events), INPUT_SIZE),
      flags.length,
    );
  };
  /**
   * Send a real left click at the center of a window's client area, as a user would to
   * activate it and give its WebView keyboard focus. The client area is the WebView, so the
   * click does not land on the caption. The pointer moves first and settles, so the browser
   * has a hover target before the button goes down. Test-only: host code never moves focus
   * on behalf of a state read. Fails early when another window covers the click point.
   * Returns the clicked screen point.
   */
  const clickClientCenter = async (view: string) => {
    const hwnd = findWindow(view);
    // RECT is left, top, right, bottom with left and top fixed at 0 for client coordinates.
    const clientRect = new Int32Array(4);
    assert(input.symbols.GetClientRect(hwnd, ptr(clientRect)));
    const [, , clientWidth = 0, clientHeight = 0] = clientRect;
    // POINT is x then y; ClientToScreen rewrites it in place.
    const center = new Int32Array([
      Math.floor(clientWidth / 2),
      Math.floor(clientHeight / 2),
    ]);
    assert(input.symbols.ClientToScreen(hwnd, ptr(center)));
    const [screenX = 0, screenY = 0] = center;
    sendMouse(screenX, screenY, [
      MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
    ]);
    await Bun.sleep(POINTER_SETTLE_MS);
    const covering = windowAtPoint(screenX, screenY);
    if (covering.root !== String(hwnd)) {
      logInputDiagnostics("click point is covered", view, [
        screenX,
        screenY,
      ]);
      assert.fail(
        `Click point of ${view} is covered by window ${covering.root} "${covering.rootText}"`,
      );
    }
    sendMouse(screenX, screenY, [
      MOUSEEVENTF_LEFTDOWN,
      MOUSEEVENTF_LEFTUP,
    ]);
    return [
      screenX,
      screenY,
    ];
  };
  /** Move a test window to the top of the Z-order, or back to normal, without activating it. */
  const setTopmost = (hwnd: bigint, topmost: boolean) => {
    const insertAfter = topmost ? HWND_TOPMOST : HWND_NOTOPMOST;
    assert(
      input.symbols.SetWindowPos(
        hwnd,
        insertAfter,
        0,
        0,
        0,
        0,
        SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE,
      ) !== 0,
      `SetWindowPos failed for window ${hwnd}`,
    );
  };
  const isMainWebViewFocused = async () =>
    (await windows.getWebViewState(main)).focused;
  /**
   * Make a visible window the foreground window with its WebView holding keyboard focus.
   * SetForegroundWindow is not relied on: the foreground lock refuses it when the child
   * process is neither the foreground process nor the last input receiver, so focus() may
   * fail with BUSY. A real click is always accepted. Judgments use state after the click.
   * A click that does not activate the window is repeated a bounded number of times, with
   * diagnostics for each miss, so a lost click is visible without hiding a real failure.
   */
  const activateByClick = async (target: { view: string }) => {
    let focusSucceeded = false;
    try {
      await windows.focus(target);
      focusSucceeded = true;
    } catch (error) {
      const declined =
        error instanceof Error && "code" in error && error.code === "BUSY";
      if (!declined) {
        throw error;
      }
    }
    // Observation only: window activation without WebView focus is informative, not a failure.
    if (
      focusSucceeded &&
      (await windows.isFocused(target)) &&
      !(await windows.getWebViewState(target)).focused
    ) {
      console.log(
        `Observed: ${target.view} is focused but its WebView is not right after windows.focus`,
      );
    }
    // Raise only the test window above other windows, such as the runner's console, so the
    // click reaches it. Activation still comes from the click; the Z-order is restored after.
    const hwnd = findWindow(target.view);
    setTopmost(hwnd, true);
    try {
      await clickUntilActive(target);
    } finally {
      setTopmost(hwnd, false);
    }
    await waitFor(
      async () => (await windows.getWebViewState(target)).focused,
      `${target.view} WebView input focus after activation`,
    );
  };
  /** Click the window center until it becomes the foreground window, within a bounded retry. */
  const clickUntilActive = async (target: { view: string }) => {
    for (let attempt = 1; attempt <= CLICK_ATTEMPTS; attempt++) {
      const point = await clickClientCenter(target.view);
      const deadline = Date.now() + CLICK_ACTIVATION_TIMEOUT_MS;
      while (!(await windows.isFocused(target)) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      if (await windows.isFocused(target)) {
        break;
      }
      logInputDiagnostics(
        `${target.view} not foreground after click ${attempt}/${CLICK_ATTEMPTS}`,
        target.view,
        point,
      );
      assert(
        attempt < CLICK_ATTEMPTS,
        `Click on ${target.view} never made it the foreground window`,
      );
    }
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
    // Focus runs before DevTools so a DevTools top-level window cannot take the
    // foreground or the input focus during the scenario.
    assert.equal(await windows.isDestroyed(peer), false);
    // Show both windows side by side so a click on one never lands on the other.
    const screenWidth = input.symbols.GetSystemMetrics(SM_CXSCREEN);
    const screenHeight = input.symbols.GetSystemMetrics(SM_CYSCREEN);
    const layoutWidth = Math.min(
      MAX_LAYOUT_WIDTH,
      Math.floor(screenWidth / 2) - LAYOUT_MARGIN * 2,
    );
    const layoutHeight = Math.min(
      MAX_LAYOUT_HEIGHT,
      screenHeight - LAYOUT_MARGIN * 4,
    );
    for (const [target, x] of [
      [
        main,
        LAYOUT_MARGIN,
      ],
      [
        peer,
        Math.floor(screenWidth / 2) + LAYOUT_MARGIN,
      ],
    ] as const) {
      await windows.showInactive(target);
      await windows.setOuterBounds({
        ...target,
        unit: "physical",
        x,
        y: LAYOUT_MARGIN,
        width: layoutWidth,
        height: layoutHeight,
      });
    }
    logInputDiagnostics("layout applied", peer.view);
    // (a) Activating peer takes the input focus away from the main WebView.
    await activateByClick(peer);
    assert.equal(await windows.isFocused(peer), true);
    await waitFor(
      async () => !(await isMainWebViewFocused()),
      "main WebView to lose input focus",
    );
    // (b) Activating main gives its WebView the input focus.
    await activateByClick(main);
    assert.equal(await windows.isFocused(main), true);
    assert.equal(await isMainWebViewFocused(), true);
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
    // (c) Activating peer again removes the focus from main.
    await activateByClick(peer);
    await waitFor(
      async () => !(await isMainWebViewFocused()),
      "main WebView to lose input focus",
    );
    assert.equal(await windows.isFocused(main), false);
    // Hide both again so the remaining steps run in the original hidden state.
    await windows.hide(main);
    await windows.hide(peer);

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
      appMetadata: testAppMetadata,
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

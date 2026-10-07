import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runWindowsApp } from "../../native/windows/bun/entry.ts";
import { user, Windows } from "../../native/windows/bun/win32.ts";
import { type CommandContext, defineApp, windows } from "../../packages/backend-sdk/src/index.ts";
import type { HostContext, Policy } from "../../packages/protocol/src/index.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-window-api");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
const policy: Policy = {
  version: 1,
  backend: { permissions: [], windows: ["main", "editor"] },
  views: [
    {
      id: "main",
      origins: ["https://app.bunaway.local"],
      commands: ["test.run"],
      events: [],
      host: { permissions: [], windows: ["main", "editor"] },
    },
    {
      id: "editor",
      origins: ["https://app.bunaway.local"],
      commands: ["test.aux", "test.hold"],
      events: [],
      host: { permissions: [], windows: [] },
    },
  ],
};

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), { recursive: true });
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "windows-bun/window-api.js")],
    target: "browser",
  });
  assert(built.success && built.outputs[0]);
  await writeFile(
    resolve(assets, "web/app.js"),
    new Uint8Array(await built.outputs[0].arrayBuffer()),
  );
  for (const name of ["index.html", "editor.html"])
    await writeFile(
      resolve(assets, "web", name),
      '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'"><script type="module" src="app.js"></script>',
    );
  const driver = dlopen("user32.dll", {
    FindWindowW: { args: ["ptr", "ptr"], returns: "u64" },
    PostMessageW: { args: ["u64", "u32", "u64", "i64"], returns: "i32" },
    GetClientRect: { args: ["u64", "ptr"], returns: "i32" },
    GetWindowRect: { args: ["u64", "ptr"], returns: "i32" },
    IsWindowVisible: { args: ["u64"], returns: "i32" },
    IsIconic: { args: ["u64"], returns: "i32" },
    IsZoomed: { args: ["u64"], returns: "i32" },
  });
  const nativeWindows = new Windows(() => {});
  try {
    for (const showCmd of [1, 2, 3])
      for (const visible of [true, false]) {
        const hwnd = nativeWindows.create("Fullscreen visibility regression", 800, 600, () => {});
        try {
          user.symbols.ShowWindow(hwnd, showCmd);
          if (!visible) nativeWindows.show(hwnd, false);
          const frame = new Int32Array(4),
            restored = new Int32Array(4);
          assert(driver.symbols.GetWindowRect(hwnd, ptr(frame)));
          const minimized = driver.symbols.IsIconic(hwnd),
            maximized = driver.symbols.IsZoomed(hwnd);
          nativeWindows.setFullscreen(hwnd, true);
          nativeWindows.setFullscreen(hwnd, false);
          assert.equal(driver.symbols.IsWindowVisible(hwnd), Number(visible));
          assert.equal(driver.symbols.IsIconic(hwnd), minimized);
          assert.equal(driver.symbols.IsZoomed(hwnd), maximized);
          assert(driver.symbols.GetWindowRect(hwnd, ptr(restored)));
          assert.deepEqual([...restored], [...frame]);
        } finally {
          nativeWindows.destroy(hwnd);
        }
      }
  } finally {
    nativeWindows.dispose();
  }
  const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "--child"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const handles = new Map<string, bigint>();
  const dialogClass = Buffer.from("#32770\0", "utf16le");
  const dialogTitle = Buffer.from("Window API editor\0", "utf16le");
  let confirmations = 0,
    editorWindows = 0,
    geometry = false,
    pending = "";
  const decoder = new TextDecoder();
  const timers = new Set<ReturnType<typeof setInterval>>();
  let editorBrowser = 0;
  const crashes: Promise<void>[] = [];
  const stdout = child.stdout.pipeTo(
    new WritableStream({
      write(chunk) {
        pending += decoder.decode(chunk, { stream: true });
        while (pending.includes("\n")) {
          const end = pending.indexOf("\n");
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.event === "webview-ready" && event.view === "editor")
            editorBrowser = event.browserPid;
          if (event.event === "window-api-browser-crash") {
            assert(editorBrowser);
            const killer = Bun.spawn(["taskkill", "/F", "/PID", String(editorBrowser)], {
              stdout: "ignore",
              stderr: "ignore",
            });
            crashes.push(killer.exited.then((code) => assert.equal(code, 0)));
          }
          if (event.event === "window-created") {
            handles.set(event.view, BigInt(event.hwnd));
            if (event.view === "editor" && ++editorWindows > 4) {
              child.kill();
              throw new Error("Revoked creation reopened the editor window.");
            }
          }
          if (event.event === "window-api-geometry") {
            const hwnd = handles.get("editor");
            assert(hwnd);
            const client = new Int32Array(4),
              frame = new Int32Array(4);
            assert(driver.symbols.GetClientRect(hwnd, ptr(client)));
            assert(driver.symbols.GetWindowRect(hwnd, ptr(frame)));
            assert.deepEqual([...client], [0, 0, 900, 650]);
            assert.equal(frame[0], 20);
            assert.equal(frame[1], 30);
            geometry = true;
          }
          if (event.event === "window-close-confirmation") {
            const answer = ++confirmations === 1 ? 7n : 6n; // IDNO then IDYES
            const deadline = Date.now() + 10000;
            const timer = setInterval(() => {
              const hwnd = driver.symbols.FindWindowW(ptr(dialogClass), ptr(dialogTitle));
              if (hwnd) {
                assert(driver.symbols.PostMessageW(hwnd, 0x111, answer, 0n));
                clearInterval(timer);
                timers.delete(timer);
              } else if (Date.now() > deadline) {
                clearInterval(timer);
                timers.delete(timer);
                child.kill();
              }
            }, 10);
            timers.add(timer);
          }
        }
      },
    }),
  );
  const errors = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill(), 150000);
  try {
    const code = await child.exited;
    await stdout;
    await Promise.all(crashes);
    assert.equal(code, 0, await errors);
    assert.equal(confirmations, 2);
    assert.equal(crashes.length, 1);
    assert(geometry);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.pass, true);
    assert.equal(report.auxiliaryDocuments, 4);
    assert.equal(editorWindows, 4);
    assert.equal(report.cancelledCreation, true);
    assert.equal(report.browserFailureClosed, true);
    console.log(
      "PASS Windows public window API: fullscreen visibility, geometry, close refusal, browser failure, dynamic creation, fresh sessions and revoked creation",
    );
  } finally {
    clearTimeout(timeout);
    for (const timer of timers) clearInterval(timer);
    if (child.exitCode === null) child.kill();
    await child.exited;
    driver.close();
  }
} else {
  let runs = 0,
    auxiliaryDocuments = 0,
    holds = 0,
    cancellations = 0,
    quitAttempts = 0;
  async function waitFor(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 10000;
    while (!(await check())) {
      assert(Date.now() < deadline, "Fresh document did not connect");
      await Bun.sleep(10);
    }
  }
  const contract = { input: { const: null }, output: { const: null } } as const;
  const app = defineApp({
    modules: [],
    desktop: {
      beforeQuit: () => ++quitAttempts > 1,
    },
    commands: {
      "test.aux": {
        ...contract,
        async run(_input: unknown, context: CommandContext) {
          await assert.rejects(
            context.host.call("windows.show", { view: "main" }),
            (error: unknown) => (error as { code: string }).code === "PERMISSION_DENIED",
          );
          auxiliaryDocuments++;
          return null;
        },
      },
      "test.hold": {
        ...contract,
        async run(_input: unknown, context: CommandContext) {
          holds++;
          return new Promise<null>((_resolve, reject) =>
            context.signal.addEventListener("abort", () => {
              cancellations++;
              reject(new Error("old document revoked"));
            }),
          );
        },
      },
      "test.run": {
        ...contract,
        async run() {
          if (++runs === 1) {
            await windows.create({ view: "editor" });
            await waitFor(() => holds === 1);
            await assert.rejects(
              windows.create({ view: "editor" }),
              (error: unknown) => (error as { code: string }).code === "BUSY",
            );
            await windows.hide({ view: "editor" });
            await windows.show({ view: "editor" });
            try {
              await windows.focus({ view: "editor" });
            } catch (error) {
              assert.equal((error as { code: string }).code, "BUSY");
            }
            await windows.setSize({ view: "editor", width: 900, height: 650 });
            await windows.setPosition({ view: "editor", x: 20, y: 30 });
            await windows.setFullscreen({ view: "editor", fullscreen: true });
            await assert.rejects(
              windows.setSize({ view: "editor", width: 800, height: 600 }),
              (error: unknown) => (error as { code: string }).code === "INVALID_ARGUMENT",
            );
            await windows.setFullscreen({ view: "editor", fullscreen: false });
            console.log(JSON.stringify({ event: "window-api-geometry" }));
            await windows.setCloseConfirmation({ view: "editor", message: "Close editor?" });
            assert.equal(await windows.close({ view: "editor" }), false);
            assert((await windows.list()).find((spec) => spec.view === "editor")?.open);
            await windows.recreate({ view: "editor" });
            await waitFor(() => holds === 2 && cancellations === 1);
          } else if (runs === 2) {
            assert.equal(await windows.close({ view: "editor" }), true); // confirmation resets on recreation
            await windows.create({ view: "editor" });
            await waitFor(() => holds === 3 && cancellations === 2);
          } else if (runs === 3) {
            await windows.setCloseConfirmation({ view: "editor", message: "Close editor?" });
            console.log(JSON.stringify({ event: "window-api-browser-crash" }));
            await waitFor(async () =>
              (await windows.list()).some((spec) => spec.view === "editor" && !spec.open),
            );
            await waitFor(() => cancellations === 3);
            await windows.recreate({ view: "main" }); // revokes this caller, but replacement must finish
          } else {
            assert.equal(runs, 4);
            assert.equal(quitAttempts, 0, "recreation must bypass app quit checks");
            await Bun.sleep(50); // let the replacement readiness reply release its reservation
            await windows.create({ view: "editor" });
            await waitFor(() => holds === 4);
            assert.equal(await windows.close({ view: "editor" }), true);
            assert.equal(await windows.close({ view: "main" }), false);
            assert.equal(quitAttempts, 1);
            assert((await windows.list()).find((spec) => spec.view === "main")?.open);
            const reopening = assert.rejects(
              windows.create({ view: "editor" }),
              (error: unknown) => (error as { code: string }).code === "CANCELLED",
            );
            await Bun.sleep(20); // revoke the caller while the editor still drains
            await assert.rejects(
              windows.close({ view: "main" }),
              (error: unknown) => (error as { code: string }).code === "CANCELLED",
            );
            await reopening;
            assert.equal(quitAttempts, 2);
            assert.equal(auxiliaryDocuments, 4);
            await writeFile(
              reportPath,
              JSON.stringify({
                pass: true,
                auxiliaryDocuments,
                cancellations,
                cancelledCreation: true,
                browserFailureClosed: true,
              }),
            );
          }
          return null;
        },
      },
    },
  });
  await runWindowsApp(app, {
    runtime: { id: "windows-window-api", generation: crypto.randomUUID() },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    windows: ["main", "editor"].map((view) => ({
      view,
      title: `Window API ${view}`,
      home: `https://app.bunaway.local/${view === "main" ? "index" : "editor"}.html`,
      window: { width: 800, height: 600 },
      startup: view === "main",
    })),
    assets,
    dataRoot: resolve(output, `data-${process.pid}`),
    loader: resolve(root, "native/windows/bun/vendor/sdk/build/native/x64/WebView2Loader.dll"),
  });
  process.exit(0);
}

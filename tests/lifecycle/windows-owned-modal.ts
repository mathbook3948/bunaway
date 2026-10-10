import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "@bunaway/backend";
import { windows, windowsPlugin } from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";

const WM_CLOSE = 0x0010;
const WM_COMMAND = 0x0111;
const GW_OWNER = 4;
const IDNO = 7n;
const SCENARIO_TIMEOUT_MS = 150_000;
const WINDOW_STATE_TIMEOUT_MS = 40_000;

const root =
  process.env.BUNAWAY_MODAL_TEST_ROOT ?? resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-owned-modal");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
assert.equal(process.platform, "win32");

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/owned-modal.js"),
    ],
    target: "browser",
  });
  assert(web.success && web.outputs[0]);
  await writeFile(resolve(assets, "web/app.js"), await web.outputs[0].text());
  for (const view of [
    "main",
    "first",
    "second",
    "observer",
  ]) {
    await writeFile(
      resolve(assets, `web/${view}.html`),
      '<!doctype html><script type="module" src="app.js"></script>',
    );
  }
  const entry = await bundleNativeWorker(
    "windows-owned-modal",
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
        BUNAWAY_MODAL_TEST_ROOT: root,
      },
    },
  );
  const { dlopen, ptr } = await import("bun:ffi");
  const driver = dlopen("user32.dll", {
    GetWindow: {
      args: [
        "u64",
        "u32",
      ],
      returns: "u64",
    },
    FindWindowW: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "u64",
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
  const caption = Buffer.from("Owned modal first\0", "utf16le");
  let declined = 0;
  const clicks = setInterval(() => {
    const dialog = driver.symbols.FindWindowW(ptr(dialogClass), ptr(caption));
    if (dialog) {
      assert.equal(
        declined++,
        0,
        "Unexpected confirmation after trusted destroy",
      );
      const owner = driver.symbols.GetWindow(dialog, GW_OWNER);
      assert(owner);
      const parent = driver.symbols.GetWindow(owner, GW_OWNER);
      assert(parent);
      // Parent and child native close requests share the pending confirmation's subtree.
      assert(driver.symbols.PostMessageW(parent, WM_CLOSE, 0n, 0n));
      // A duplicate native close during confirmation must not enqueue another confirmation.
      assert(driver.symbols.PostMessageW(owner, WM_CLOSE, 0n, 0n));
      assert(driver.symbols.PostMessageW(dialog, WM_COMMAND, IDNO, 0n));
    }
  }, 50);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill(), SCENARIO_TIMEOUT_MS);
  try {
    assert.equal(await child.exited, 0, `${await stderr}\n${await stdout}`);
    assert.equal(declined, 1);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.pass, true);
    console.log("PASS Windows owned-modal WebView2 lifecycle", report);
  } finally {
    clearInterval(clicks);
    clearTimeout(timeout);
    driver.close();
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
} else {
  const views = [
    "main",
    "first",
    "second",
    "observer",
  ];
  const permissions: Policy["backend"] = {
    permissions: [
      "windows:list",
      {
        identifier: "windows:control",
        allow: views.map((view) => ({
          view,
        })),
      },
      {
        identifier: "windows:destroy",
        allow: views.map((view) => ({
          view,
        })),
      },
    ],
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
        "test.arrived",
        "plugin.windows.destroy",
      ],
      events: [],
      host: permissions,
    })),
  };
  const arrivals = new Map<string, number>();
  let quitChecks = 0;
  let quitMode: "veto" | "error" | "pending" = "veto";
  let releaseQuit: () => void = () => {};
  let completed = false;
  let exerciseFailure: unknown;
  let task: Promise<void> | undefined;

  async function waitFor(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + WINDOW_STATE_TIMEOUT_MS;
    while (!(await check())) {
      assert(Date.now() < deadline, "Modal test timed out");
      await Bun.sleep(10);
    }
  }
  async function exercise() {
    await waitFor(() => arrivals.has("main") && arrivals.has("observer"));
    const main = {
      view: "main",
    };
    const first = {
      view: "first",
    };
    const second = {
      view: "second",
    };
    const identity = await windows.getCurrent();
    assert.equal(identity, null, "Backend has no current window");
    const parent = await windows.getReadiness(main);
    await windows.create(first);
    await windows.create(second);
    await waitFor(() => arrivals.has("first") && arrivals.has("second"));
    await windows.setEnabled({
      ...main,
      enabled: false,
    });
    await windows.setParent({
      ...first,
      parent: parent.windowId,
      modal: true,
    });
    await windows.setParent({
      ...second,
      parent: parent.windowId,
      modal: true,
    });
    assert.equal((await windows.getOwner(first))?.windowId, parent.windowId);
    await assert.rejects(
      windows.setEnabled({
        ...main,
        enabled: true,
      }),
      {
        code: "BUSY",
      },
    );
    await windows.setCloseConfirmation({
      ...first,
      message: "Refuse this close",
    });
    assert.equal(await windows.close(first), false);
    assert.equal(await windows.isDestroyed(first), false);
    assert.equal(await windows.isEnabled(main), false);
    await windows.destroy(first);
    await windows.destroy(second);
    // Explicit disabled state survives both modal resource releases.
    await waitFor(async () => {
      try {
        await windows.setEnabled({
          ...main,
          enabled: false,
        });
        return true;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "BUSY"
        ) {
          return false;
        }
        throw error;
      }
    });
    assert.equal(await windows.isEnabled(main), false);
    await windows.setEnabled({
      ...main,
      enabled: true,
    });
    await windows.create(first);
    await windows.create(second);
    await windows.setParent({
      ...first,
      parent: parent.windowId,
      modal: true,
    });
    await windows.setParent({
      ...second,
      parent: parent.windowId,
      modal: true,
    });
    const oldChild = await windows.getReadiness(first);
    await windows.recreate(first);
    await waitFor(
      async () => (await windows.getReadiness(first)).sdk === "ready",
    );
    const newChild = await windows.getReadiness(first);
    assert.notEqual(newChild.windowId, oldChild.windowId);
    assert.equal((await windows.getParent(first))?.windowId, parent.windowId);
    await windows.destroy(first);
    assert.equal(await windows.isEnabled(main), false);
    await windows.destroy(second);
    await waitFor(() => windows.isEnabled(main));
    // Parent close retires both descendant sessions before its WebView and HWND release.
    await windows.create(first);
    await windows.setParent({
      ...first,
      parent: parent.windowId,
      modal: true,
    });
    assert.equal(await windows.close(main), true);
    assert.equal(await windows.isDestroyed(first), true);
    await windows.create(main);
    const recreatedParent = await windows.getReadiness(main);
    assert.notEqual(recreatedParent.windowId, parent.windowId);
    await windows.create(first);
    await assert.rejects(
      windows.setParent({
        ...first,
        parent: parent.windowId,
        modal: true,
      }),
      {
        code: "INVALID_ARGUMENT",
      },
    );
    await windows.setParent({
      ...first,
      parent: recreatedParent.windowId,
      modal: true,
    });
    const race = assert.rejects(windows.recreate(first), {
      code: "CANCELLED",
    });
    await waitFor(
      async () => (await windows.getReadiness(first)).sdk === "cancelled",
    );
    await windows.destroy(main);
    await race;
    assert.equal(await windows.isDestroyed(first), true);
    await windows.create(main);
    await windows.create(first);
    const finalParent = await windows.getReadiness(main);
    await windows.setParent({
      ...first,
      parent: finalParent.windowId,
      modal: true,
    });
    await windows.destroy({
      view: "observer",
    });
    assert.equal(await windows.close(main), false);
    assert.equal(await windows.isDestroyed(first), false);
    quitMode = "error";
    assert.equal(await windows.close(main), false);
    assert.equal(await windows.isEnabled(main), false);
    quitMode = "pending";
    const close = windows.close(main).catch((error: unknown) => {
      assert(
        error instanceof Error && "code" in error && error.code === "CANCELLED",
      );
      return true;
    });
    await waitFor(() => quitChecks === 3);
    completed = true;
    await windows.destroy(main).catch((error: unknown) => {
      assert(
        error instanceof Error && "code" in error && error.code === "CANCELLED",
      );
      return true;
    });
    releaseQuit();
    await close;
  }
  const app = defineApp({
    modules: [],
    plugins: [
      windowsPlugin,
      {
        name: "owned-modal-test",
        version: "1.0.0",
        async setup() {
          task = exercise().catch(async (error) => {
            exerciseFailure = error;
            console.error(error);
            releaseQuit();
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
      async beforeQuit() {
        quitChecks++;
        if (quitMode === "error") {
          throw new Error("Expected quit failure");
        }
        if (quitMode === "pending") {
          await new Promise<void>((done) => {
            releaseQuit = done;
          });
        }
        return quitMode === "pending";
      },
    },
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
          const view = String(input);
          arrivals.set(view, (arrivals.get(view) ?? 0) + 1);
          return null;
        },
      },
    },
  });
  const dataRoot = resolve(output, `data-${process.pid}`);
  await runWindowsApp(app, {
    runtime: {
      id: "owned-modal",
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
      title: `Owned modal ${view}`,
      home: `https://app.bunaway.local/${view}.html`,
      window: {
        width: 400,
        height: 300,
      },
      startup: view === "main" || view === "observer",
      visible: false,
    })),
  });
  await task;
  if (exerciseFailure) {
    throw exerciseFailure;
  }
  assert(completed);
  assert.equal(quitChecks, 3);
  const lifecycle = (await readFile(resolve(dataRoot, "logs/host.log"), "utf8"))
    .trim()
    .split("\n");
  const lastRecord = lifecycle.at(-1);
  assert(lastRecord);
  const stopped = JSON.parse(lastRecord);
  assert.equal(stopped.event, "host-stopped");
  assert.equal(stopped.activeProcesses, 0);
  assert.equal(stopped.forced, false);
  assert.equal(stopped.failed, false);
  const parentClose = lifecycle.findIndex((line) =>
    line.includes('"event":"view-window-closed","view":"main"'),
  );
  const parentClean = lifecycle.findIndex(
    (line, index) =>
      index > parentClose &&
      line.includes('"event":"view-cleaned","view":"main"'),
  );
  const childClean = lifecycle.findIndex(
    (line, index) =>
      index > parentClose &&
      line.includes('"event":"view-cleaned","view":"first"'),
  );
  assert(
    parentClose >= 0 && childClean > parentClose && parentClean > childClean,
    "Child resources must finish before parent resources",
  );
  await writeFile(
    reportPath,
    JSON.stringify({
      pass: true,
      quitChecks,
      arrivals: Object.fromEntries(arrivals),
    }),
  );
}

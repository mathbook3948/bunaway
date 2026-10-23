import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CommandContext,
  type DesktopContext,
  defineApp,
} from "@bunaway/backend";
import windows from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

const root =
  process.env.BUNAWAY_READINESS_TEST_ROOT ?? resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-window-readiness");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
assert.equal(process.platform, "win32");
if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/window-readiness.js"),
    ],
    target: "browser",
  });
  assert(web.success, web.logs.map(String).join("\n"));
  await writeFile(
    resolve(assets, "readiness.js"),
    (await web.outputs[0]?.text()) ?? "",
  );
  const entry = await bundleNativeWorker(
    "windows-window-readiness",
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
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        BUNAWAY_READINESS_TEST_ROOT: root,
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    assert.equal(await child.exited, 0, `${await stderr}\n${await stdout}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.pass, true);
    console.log(
      "PASS WebView2 preparation: native/document/SDK, hidden creation, auto-show, navigation, recreation, failures, cancellation and final quit",
      report,
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
} else {
  const dataRoot = resolve(output, `data-${process.pid}`);
  const counts = new Map<string, number>();
  /** Which document the next window loads from the home URL. */
  let mode: "main" | "bad" | "cancel" | "nosdk" = "main";
  let held = true;
  const resourceWaiters: (() => void)[] = [];
  const script = await readFile(resolve(assets, "readiness.js"), "utf8");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/readiness.js") {
        return new Response(script, {
          headers: {
            "Content-Type": "text/javascript",
          },
        });
      }
      if (url.pathname === "/held.svg") {
        if (held) {
          await new Promise<void>((done) => resourceWaiters.push(done));
        }
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
          {
            headers: {
              "Content-Type": "image/svg+xml",
            },
          },
        );
      }
      if (url.pathname === "/main.html" && mode === "bad") {
        return new Response("failed", {
          status: 404,
        });
      }
      if (url.pathname === "/main.html" && mode === "cancel") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://outside.bunaway.invalid/",
          },
        });
      }
      if (url.pathname === "/main.html" && mode === "nosdk") {
        return new Response("<!doctype html><title>No SDK</title>", {
          headers: {
            "Content-Type": "text/html",
          },
        });
      }
      return new Response(
        `<!doctype html><title>${url.pathname}</title>${url.pathname === "/main.html" ? '<img src="/held.svg">' : ""}<script type="module" src="/readiness.js"></script>`,
        {
          headers: {
            "Content-Type": "text/html",
          },
        },
      );
    },
  });
  const origin = server.url.origin;
  const policy: Policy = {
    version: 1,
    backend: {
      permissions: [
        ...windowPermissions(),
      ],
    },
    views: [
      {
        id: "main",
        origins: [
          origin,
        ],
        commands: [
          "test.arrived",
          "plugin.windows.getReadiness",
        ],
        events: [
          "test.action",
        ],
        host: {
          permissions: windowPermissions(),
        },
      },
    ],
  };
  const waitFor = async (
    check: () => boolean | Promise<boolean>,
    durationMs = 15_000,
  ) => {
    const deadline = Date.now() + durationMs;
    while (!(await check())) {
      assert(Date.now() < deadline, "Readiness scenario timed out");
      await Bun.sleep(10);
    }
  };
  const ready = () =>
    waitFor(async () => {
      const state = await windows.getReadiness();
      return state.document === "ready" && state.sdk === "ready";
    });
  const releaseResources = () => {
    held = false;
    for (const done of resourceWaiters.splice(0)) {
      done();
    }
  };
  let quitChecks = 0;
  let completed = false;
  let exerciseTask: Promise<void> | undefined;
  let exerciseFailure: unknown;
  let desktop: DesktopContext | undefined;
  /** Closes the window and waits until the next create is accepted. */
  async function closeWindow() {
    await windows.close();
    await waitFor(async () => !(await windows.isOpen()));
  }
  async function exercise(context: CommandContext): Promise<void> {
    await windows.create({
      options: {
        title: "Creation override",
        visible: false,
        showWhenReady: null,
        window: {
          width: 700,
          height: 500,
          minWidth: 900,
          maxWidth: 1100,
        },
      },
    });
    const overriddenSize = await windows.getContentSize();
    assert.equal(overriddenSize.width, 900);
    assert.equal(overriddenSize.height, 500);
    const originalId = (await windows.getReadiness()).windowId;
    await assert.rejects(
      windows.recreate({
        options: {
          window: {
            minWidth: 1000,
            maxWidth: 900,
          },
        },
      }),
      {
        code: "INVALID_ARGUMENT",
      },
    );
    assert.equal((await windows.getReadiness()).windowId, originalId);
    await waitFor(() => counts.get("main") === 1);
    const partial = await windows.getReadiness();
    assert.equal(partial.nativeCreated, true);
    assert.equal(partial.document, "pending");
    assert.equal(partial.sdk, "ready");
    assert.equal(await windows.isVisible(), false);
    assert.equal(await windows.isFocused(), false);
    releaseResources();
    await ready();
    assert.equal(await windows.isVisible(), false);
    await context.events.emit("test.action", "navigate", {
      kind: "view",
      viewId: "main",
    });
    await waitFor(() => counts.get("main") === 2);
    await ready();
    const navigated = await windows.getReadiness();
    assert.equal(navigated.windowId, partial.windowId);
    assert(navigated.documentGeneration > partial.documentGeneration);
    await context.events.emit("test.action", "fragment", {
      kind: "view",
      viewId: "main",
    });
    await waitFor(() => counts.has("fragment"));
    assert.equal(
      (await windows.getReadiness()).documentGeneration,
      navigated.documentGeneration,
    );
    await windows.recreate();
    await waitFor(() => counts.get("main") === 3);
    await ready();
    const recreated = await windows.getReadiness();
    const declaredSize = await windows.getContentSize();
    assert.equal(declaredSize.width, 640);
    assert.equal(declaredSize.height, 480);
    assert.notEqual(recreated.windowId, partial.windowId);
    assert(recreated.documentGeneration <= navigated.documentGeneration);
    await context.events.emit("test.action", "close-sdk", {
      kind: "view",
      viewId: "main",
    });
    await waitFor(
      async () => (await windows.getReadiness()).sdk === "cancelled",
    );
    assert.equal((await windows.getReadiness()).document, "ready");
    await windows.recreate();
    await waitFor(() => counts.get("main") === 4);
    await ready();
    // Creating needs the window to be gone, so the recreated one is closed first.
    await closeWindow();
    for (const showWhenReady of [
      "sdk",
      "document",
    ] as const) {
      mode = showWhenReady === "document" ? "nosdk" : "main";
      await windows.create({
        options: {
          showWhenReady,
        },
      });
      await waitFor(
        async () => (await windows.getReadiness()).document === "ready",
      );
      if (showWhenReady === "sdk") {
        await ready();
      }
      if (showWhenReady === "document") {
        assert.equal((await windows.getReadiness()).sdk, "pending");
      }
      await waitFor(() => windows.isVisible());
      await windows.hide();
      await closeWindow();
    }
    mode = "bad";
    await windows.create({
      options: {
        showWhenReady: "sdk",
      },
    });
    await waitFor(
      async () => (await windows.getReadiness()).document === "failed",
    );
    assert.equal(await windows.isVisible(), false);
    await closeWindow();
    const closed = await windows.getReadiness();
    assert.equal(closed.document, "cancelled");
    held = true;
    mode = "cancel";
    await windows.create({
      options: {
        showWhenReady: "sdk",
      },
    });
    await waitFor(
      async () => (await windows.getReadiness()).document === "cancelled",
    );
    assert.equal(await windows.isVisible(), false);
    await closeWindow();
    releaseResources();
    mode = "nosdk";
    await windows.create({
      options: {
        showWhenReady: "sdk",
      },
    });
    await waitFor(
      async () => (await windows.getReadiness()).document === "ready",
    );
    assert.equal((await windows.getReadiness()).sdk, "pending");
    assert.equal(await windows.isVisible(), false);
    await waitFor(
      async () => (await windows.getReadiness()).sdk === "failed",
      35_000,
    );
    assert.equal((await windows.getReadiness()).error?.code, "TIMEOUT");
    assert.equal(await windows.isVisible(), false);
    await closeWindow();
    // The scenario ends the app explicitly; quitting asks beforeQuit once more, now approved.
    mode = "main";
    completed = true;
    await windows.create({});
    await ready();
    assert(desktop);
    await desktop.quit();
  }
  const app = defineApp({
    modules: [],
    plugins: [
      windows,
      {
        name: "readiness-test",
        version: "1.0.0",
        async setup(context: CommandContext) {
          exerciseTask = exercise(context).catch(async (error) => {
            if (completed && error?.code === "CANCELLED") {
              return;
            }
            exerciseFailure = error;
            console.error(error);
            completed = true;
            await desktop?.quit();
          });
        },
      },
    ],
    desktop: {
      // The app has no window at start and stays up when its window closes; the scenario quits it.
      closeBehavior: "keep-alive",
      onReady(context) {
        desktop = context;
      },
      // A quit before the scenario is over is refused.
      beforeQuit() {
        quitChecks++;
        return completed;
      },
    },
    events: {
      "test.action": {
        type: "string",
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
          const role = String(input);
          counts.set(role, (counts.get(role) ?? 0) + 1);
          return null;
        },
      },
    },
  });
  try {
    await runWindowsApp(app, {
      appMetadata: testAppMetadata,
      runtime: {
        id: "window-readiness",
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
      windows: [
        {
          view: "main",
          title: "Readiness main",
          home: `${origin}/main.html`,
          window: {
            width: 640,
            height: 480,
          },
          startup: false,
        },
      ],
    });
    await exerciseTask;
    if (exerciseFailure) {
      throw exerciseFailure;
    }
    assert(completed);
    assert(quitChecks >= 1);
    await writeFile(
      reportPath,
      JSON.stringify({
        pass: true,
        documents: counts.get("main"),
        quitChecks,
      }),
    );
  } finally {
    releaseResources();
    await server.stop(true);
  }
}

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { killAfter, waitFor } from "../fixtures/deadlines.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-hidden-paint");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
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
        "https://app.bunaway.local",
      ],
      commands: [
        "test.hidden",
        "test.awaitShown",
        "test.shown",
      ],
      events: [],
      host: {
        permissions: [
          ...windowPermissions(),
        ],
      },
    },
  ],
};

/** What the page observed about its own visibility and painting in one phase. */
type PageSample = {
  visibilityState: string;
  hidden: boolean;
  frame: boolean;
  paintEntries: string[];
};

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  await writeFile(
    resolve(assets, "web/index.html"),
    '<!doctype html><title>Hidden</title><body style="background:#fff">hidden paint</body><script type="module" src="/hidden-paint.js"></script>',
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/hidden-paint.js"),
    ],
    target: "browser",
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const artifact of web.outputs) {
    await writeFile(
      resolve(assets, "web/hidden-paint.js"),
      await artifact.text(),
    );
  }
  const entry = await bundleNativeWorker(
    "windows-hidden-paint",
    assets,
    fileURLToPath(import.meta.url),
  );
  // A report left by an earlier run must not satisfy this one.
  await rm(reportPath, {
    force: true,
  });
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
        BUNAWAY_HIDDEN_PAINT_TEST_ROOT: root,
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timeout = killAfter(child, "nativeFixture");
  try {
    const code = await child.exited;
    // The child writes what it saw before each later step, so a failure still leaves the values.
    const written = await readFile(reportPath, "utf8").catch(() => "{}");
    console.log("hidden paint observation", written);
    assert.equal(code, 0, `${await stderr}\n${await stdout}`);
    const report = JSON.parse(written);
    // Document scripts run and the document reaches readiness while the window stays hidden.
    assert.equal(report.hidden.timerRan, true);
    // The hidden page is already painted: frames are delivered and first paint is reported.
    assert.equal(report.hidden.frame, true);
    assert(report.hidden.paintEntries.includes("first-paint"));
    assert.equal(report.hiddenNative.isVisible, false);
    assert.equal(report.hiddenNative.document, "ready");
    // After an explicit show the native window is visible and the page still reports visible frames.
    assert.equal(report.shownNative.isVisible, true);
    assert.equal(report.shown.visibilityState, "visible");
    assert.equal(report.shown.hidden, false);
    assert.equal(report.shown.frame, true);
    console.log(
      "PASS hidden WebView2 window: scripts, frames, first paint and readiness while hidden, native window visible after show",
    );
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
} else {
  // The bundled child has a different import.meta.dir; use the driver-selected repository root.
  const childRoot = process.env.BUNAWAY_HIDDEN_PAINT_TEST_ROOT;
  assert(childRoot);
  const childAssets = resolve(childRoot, "build/windows-hidden-paint/assets");
  const childReport = resolve(
    childRoot,
    "build/windows-hidden-paint/report.json",
  );
  const samples: Record<string, unknown> = {};
  const natives: Record<string, unknown> = {};
  let release: () => void = () => {};
  const shownRequested = new Promise<void>((resolveShown) => {
    release = resolveShown;
  });
  /** Resolves once the page has delivered the named sample. */
  const sampleArrived = (name: string) =>
    waitFor(() => samples[name], {
      deadline: "childStep",
      what: `the ${name} page sample`,
    });
  const recordCommand = (name: string) => ({
    input: {
      type: "object" as const,
    },
    output: {
      const: null,
    },
    async run(input: unknown) {
      samples[name] = (
        input as {
          payload: PageSample;
        }
      ).payload;
      return null;
    },
  });
  let desktop: DesktopContext | undefined;
  /** Writes what has been observed so far, so a later failure still leaves the earlier values. */
  const writeReport = () =>
    writeFile(
      childReport,
      JSON.stringify({
        hidden: samples.hidden,
        hiddenNative: natives.hidden,
        shown: samples.shown,
        shownNative: natives.shown,
      }),
    );
  async function scenario(): Promise<void> {
    await windows.create({
      options: {
        visible: false,
      },
    });
    await sampleArrived("hidden");
    await writeReport();
    // Readiness is checked after the page's own sample, so the document may still be loading.
    await waitFor(
      async () => (await windows.getReadiness()).document === "ready",
      {
        deadline: "childStep",
        what: "document readiness of the hidden window",
      },
    );
    natives.hidden = {
      isVisible: await windows.isVisible(),
      document: (await windows.getReadiness()).document,
    };
    await writeReport();
    await windows.show();
    natives.shown = {
      isVisible: await windows.isVisible(),
    };
    release();
    await sampleArrived("shown");
    await writeReport();
    await windows.close();
    // The app has no startup window and stays up when its window closes; the scenario quits it.
    assert(desktop, "desktop context");
    await desktop.quit();
  }
  const app = defineApp({
    modules: [],
    plugins: [
      windows,
      {
        name: "hidden-paint-test",
        version: "1.0.0",
        async setup(_context: CommandContext) {
          void scenario().catch(async (error) => {
            console.error(error);
            process.exitCode = 1;
            // A page still waiting for the show must not hold the shutdown.
            release();
            // Leave the values seen so far before the process ends.
            await writeReport().catch(console.error);
            if (desktop === undefined) {
              process.exit(1);
            }
            void desktop.quit().catch((quitError) => {
              console.error(quitError);
              process.exit(1);
            });
          });
        },
      },
    ],
    desktop: {
      closeBehavior: "keep-alive",
      onReady(context) {
        desktop = context;
      },
    },
    commands: {
      "test.hidden": recordCommand("hidden"),
      "test.shown": recordCommand("shown"),
      "test.awaitShown": {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run() {
          await shownRequested;
          return null;
        },
      },
    },
  });
  await runWindowsApp(app, {
    appMetadata: testAppMetadata,
    runtime: {
      id: "hidden-paint",
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    assets: childAssets,
    dataRoot: resolve(
      childRoot,
      `build/windows-hidden-paint/data-${process.pid}`,
    ),
    loader: resolve(
      childRoot,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    windows: [
      {
        view: "main",
        title: "Hidden paint",
        home: "https://app.bunaway.local/index.html",
        window: {
          width: 640,
          height: 480,
        },
        startup: false,
      },
    ],
  });
}

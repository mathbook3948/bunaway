import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "@bunaway/backend";
import windows from "@bunaway/plugin-windows";
import type { HostContext, Policy } from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { testAppMetadata } from "../fixtures/app-info.ts";
import { killAfter } from "../fixtures/deadlines.ts";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-document-title");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
const LIMIT = 1024;
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
        "test.record",
        "test.finish",
      ],
      events: [
        "windows.documentTitleChanged",
      ],
      host: {
        permissions: [
          ...windowPermissions(),
        ],
      },
    },
  ],
};

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  await writeFile(
    resolve(assets, "web/index.html"),
    '<!doctype html><title>Initial</title><script type="module" src="/title.js"></script>',
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/document-title.js"),
    ],
    target: "browser",
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const artifact of web.outputs) {
    await writeFile(resolve(assets, "web/title.js"), await artifact.text());
  }
  const entry = await bundleNativeWorker(
    "windows-document-title",
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
        BUNAWAY_TITLE_TEST_ROOT: root,
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timeout = killAfter(child, "nativeFixture");
  try {
    const code = await child.exited;
    assert.equal(code, 0, `${await stderr}\n${await stdout}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    // The first load may report the initial title before the page subscribes.
    const titles: string[] = report.titles.filter(
      (title: string) => title !== "Initial",
    );
    assert.deepEqual(titles, [
      "Second",
      "한글 제목 ✓",
      "x".repeat(LIMIT),
      "y".repeat(LIMIT - 1),
      "Last",
    ]);
    assert.deepEqual(report.windowIds, [
      report.windowId,
    ]);
    assert.deepEqual(report.viewIds, [
      "main",
    ]);
    // The event is notification only: the caption keeps the title the app declared.
    assert.equal(report.caption, "Title main");
    console.log(
      "PASS WebView2 document title events: each change in order, Unicode, 1024 unit limit with a whole surrogate pair, caption unchanged",
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
  const childRoot = process.env.BUNAWAY_TITLE_TEST_ROOT;
  assert(childRoot);
  const childAssets = resolve(childRoot, "build/windows-document-title/assets");
  const childReport = resolve(
    childRoot,
    "build/windows-document-title/report.json",
  );
  const payloads: {
    windowId: string;
    viewId: string;
    title: string;
  }[] = [];
  const app = defineApp({
    modules: [],
    plugins: [
      windows,
    ],
    commands: {
      "test.record": {
        input: {
          type: "object",
        },
        output: {
          const: null,
        },
        async run(input: unknown) {
          payloads.push(
            (
              input as {
                payload: (typeof payloads)[number];
              }
            ).payload,
          );
          return null;
        },
      },
      "test.finish": {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run() {
          const snapshot = await windows.getSnapshot();
          await writeFile(
            childReport,
            JSON.stringify({
              titles: payloads.map((payload) => payload.title),
              windowId: snapshot.windowId,
              windowIds: [
                ...new Set(payloads.map((payload) => payload.windowId)),
              ],
              viewIds: [
                ...new Set(payloads.map((payload) => payload.viewId)),
              ],
              caption: await windows.getTitle(),
            }),
          );
          await windows.close();
          return null;
        },
      },
    },
  });
  await runWindowsApp(app, {
    appMetadata: testAppMetadata,
    runtime: {
      id: "document-title",
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    assets: childAssets,
    dataRoot: resolve(
      childRoot,
      `build/windows-document-title/data-${process.pid}`,
    ),
    loader: resolve(
      childRoot,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    windows: [
      {
        view: "main",
        title: "Title main",
        home: "https://app.bunaway.local/index.html",
        window: {
          width: 640,
          height: 480,
        },
      },
    ],
  });
}

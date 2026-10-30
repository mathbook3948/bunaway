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
import {
  checkReport,
  formatReport,
  type PermissionReport,
} from "./windows-webview-permission-report.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-webview-permission-denial");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
const APP_ORIGIN = "https://app.bunaway.local";
const DENIAL_LOG_EVENT = '"event":"permission-request-denied"';
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
        APP_ORIGIN,
      ],
      commands: [
        "test.mark",
        "test.record",
        "test.finish",
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

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  await writeFile(
    resolve(assets, "web/index.html"),
    '<!doctype html><title>Permission denial</title><script type="module" src="/probe.js"></script>',
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/webview-permission-denial.js"),
    ],
    target: "browser",
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const artifact of web.outputs) {
    await writeFile(resolve(assets, "web/probe.js"), await artifact.text());
  }
  const entry = await bundleNativeWorker(
    "windows-webview-permission-denial",
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
        BUNAWAY_PERMISSION_TEST_ROOT: root,
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timeout = killAfter(child, "nativeFixture");
  try {
    const code = await child.exited;
    assert.equal(code, 0, `${await stderr}\n${await stdout}`);
    const report: PermissionReport = JSON.parse(
      await readFile(reportPath, "utf8"),
    );
    // The observed values are the result of this test: print them before judging them.
    console.log(`WebView2 ${report.userAgent}\n${formatReport(report)}`);
    assert.deepEqual(checkReport(report, APP_ORIGIN), []);
    console.log(
      "PASS WebView2 page permissions: no request without a user gesture was granted or left waiting for a prompt",
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
  const childRoot = process.env.BUNAWAY_PERMISSION_TEST_ROOT;
  assert(childRoot);
  const childOutput = resolve(
    childRoot,
    "build/windows-webview-permission-denial",
  );
  const dataRoot = resolve(childOutput, `data-${process.pid}`);
  /** Counts the refusals the host has logged so far; no log file yet means none. */
  const countDenials = async () => {
    const log = Bun.file(resolve(dataRoot, "logs/host.log"));
    if (!(await log.exists())) {
      return 0;
    }
    return (await log.text()).split(DENIAL_LOG_EVENT).length - 1;
  };
  let received: Record<string, unknown> | undefined;
  const app = defineApp({
    modules: [],
    plugins: [
      windows,
    ],
    commands: {
      "test.mark": {
        input: {
          type: "object",
        },
        output: {
          type: "object",
        },
        async run() {
          return {
            denials: await countDenials(),
          };
        },
      },
      "test.record": {
        input: {
          type: "object",
        },
        output: {
          const: null,
        },
        async run(input: unknown) {
          received = (
            input as {
              report: Record<string, unknown>;
            }
          ).report;
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
          await writeFile(
            resolve(childOutput, "report.json"),
            JSON.stringify({
              ...received,
              hostDenialTotal: await countDenials(),
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
      id: "webview-permission-denial",
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    assets: resolve(childOutput, "assets"),
    dataRoot,
    loader: resolve(
      childRoot,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    windows: [
      {
        view: "main",
        title: "Permission denial",
        home: `${APP_ORIGIN}/index.html`,
        window: {
          width: 640,
          height: 480,
        },
      },
    ],
  });
}

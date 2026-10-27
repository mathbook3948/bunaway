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
  type ProbeReport,
} from "./web-api-probe-report.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-web-api-probe");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
const APP_ORIGIN = "https://app.bunaway.local";
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
    '<!doctype html><title>Web API probe</title><script type="module" src="/probe.js"></script>',
  );
  // One script serves both the dedicated worker and the shared worker: each echoes what it gets.
  await writeFile(
    resolve(assets, "web/probe-worker.js"),
    "self.onmessage = (event) => self.postMessage(event.data);\n" +
      "self.onconnect = (event) => {\n" +
      "  const port = event.ports[0];\n" +
      "  port.onmessage = (message) => port.postMessage(message.data);\n" +
      "};\n",
  );
  await writeFile(
    resolve(assets, "web/probe-sw.js"),
    "self.addEventListener('install', () => self.skipWaiting());\n" +
      "self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));\n",
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/web-api-probe.js"),
    ],
    target: "browser",
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const artifact of web.outputs) {
    await writeFile(resolve(assets, "web/probe.js"), await artifact.text());
  }
  const entry = await bundleNativeWorker(
    "windows-web-api-probe",
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
        BUNAWAY_WEB_API_TEST_ROOT: root,
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timeout = killAfter(child, "nativeFixture");
  try {
    const code = await child.exited;
    assert.equal(code, 0, `${await stderr}\n${await stdout}`);
    const report: ProbeReport = JSON.parse(await readFile(reportPath, "utf8"));
    // The observed values are the result of this test: print them before judging them.
    console.log(`WebView2 ${report.userAgent}\n${formatReport(report)}`);
    assert.deepEqual(checkReport(report, APP_ORIGIN), []);
    console.log(
      "PASS WebView2 Web APIs: required probes supported on the asset origin, runner-dependent probes recorded",
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
  const childRoot = process.env.BUNAWAY_WEB_API_TEST_ROOT;
  assert(childRoot);
  const childAssets = resolve(childRoot, "build/windows-web-api-probe/assets");
  const childReport = resolve(
    childRoot,
    "build/windows-web-api-probe/report.json",
  );
  let received: unknown;
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
          received = (
            input as {
              report: unknown;
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
          await writeFile(childReport, JSON.stringify(received));
          await windows.close();
          return null;
        },
      },
    },
  });
  await runWindowsApp(app, {
    appMetadata: testAppMetadata,
    runtime: {
      id: "web-api-probe",
      generation: crypto.randomUUID(),
    },
    backendContext: `backend-${crypto.randomUUID()}` as HostContext,
    policy,
    assets: childAssets,
    dataRoot: resolve(
      childRoot,
      `build/windows-web-api-probe/data-${process.pid}`,
    ),
    loader: resolve(
      childRoot,
      "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
    ),
    windows: [
      {
        view: "main",
        title: "Web API probe",
        home: `${APP_ORIGIN}/index.html`,
        window: {
          width: 640,
          height: 480,
        },
      },
    ],
  });
}

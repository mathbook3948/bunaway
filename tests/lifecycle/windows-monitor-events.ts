import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "@bunaway/backend";
import {
  monitorChangeSchema,
  windows,
  windowsPlugin,
} from "@bunaway/plugin-windows";
import {
  type HostContext,
  type Policy,
  validateValue,
} from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";

assert.equal(process.platform, "win32");
const root =
  process.env.BUNAWAY_MONITOR_TEST_ROOT ?? resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-monitor-events");
const assets = resolve(output, "assets");
const reportPath = resolve(output, "report.json");
const controlPath = resolve(output, "control.txt");
const noInput = {
  input: {
    const: null,
  },
  output: {
    const: null,
  },
} as const;

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  await writeFile(controlPath, "initial");
  for (const name of [
    "index",
    "no-event",
    "no-operation",
  ]) {
    await writeFile(
      resolve(assets, `web/${name}.html`),
      '<!doctype html><title>Monitor events</title><script type="module" src="/events.js"></script>',
    );
  }
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/monitor-events.js"),
    ],
    target: "browser",
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const artifact of web.outputs) {
    await writeFile(resolve(assets, "web/events.js"), await artifact.text());
  }
  const entry = await bundleNativeWorker(
    "windows-monitor-events",
    assets,
    fileURLToPath(import.meta.url),
    [
      {
        name: "controlled-display-metrics",
        setup(build) {
          build.onResolve(
            {
              filter: /^\.\/monitors\.ts$/,
            },
            (args) =>
              args.importer.endsWith("/ui.ts") ||
              args.importer.endsWith("\\ui.ts")
                ? {
                    path: resolve(
                      root,
                      "tests/fixtures/windows-monitor-source.ts",
                    ),
                  }
                : undefined,
          );
        },
      },
    ],
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
        BUNAWAY_MONITOR_TEST_ROOT: root,
        BUNAWAY_MONITOR_CONTROL: controlPath,
      },
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill(), 90000);
  try {
    assert.equal(await child.exited, 0, `${await stderr}\n${await stdout}`);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.pass, true);
    assert.equal(report.documents, 3);
    assert.equal(report.denied, 2);
    console.log(
      "PASS actual Win32/WebView2 monitor routing with synthetic notifications/metrics: permissions, error recovery, unlisten, navigation, recreation, cleanup; hardware hotplug not exercised",
    );
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
} else {
  const { dlopen, ptr } = await import("bun:ffi");
  const driver = dlopen("user32.dll", {
    FindWindowW: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "u64",
    },
    SendMessageW: {
      args: [
        "u64",
        "u32",
        "u64",
        "i64",
      ],
      returns: "i64",
    },
  });
  let documents = 0;
  let finished = false;
  let deniedListenerReady = false;
  const denied = new Set<string>();
  const records: ReturnType<
    typeof validateValue<typeof monitorChangeSchema>
  >[] = [];
  const sources: string[] = [];
  async function waitFor(check: () => boolean) {
    const deadline = Date.now() + 10000;
    while (!check()) {
      assert(Date.now() < deadline, "Monitor event fixture timed out");
      await Bun.sleep(5);
    }
  }
  async function notify(mode: string) {
    await writeFile(controlPath, mode);
    const title = Buffer.from("Bunaway display notifications\0", "utf16le");
    const hwnd = driver.symbols.FindWindowW(null, ptr(title));
    assert(hwnd, "Display notification HWND missing");
    for (const message of [
      0x007e,
      0x001a,
      0x0219,
    ]) {
      driver.symbols.SendMessageW(hwnd, message, 0n, 0n);
    }
  }
  const commands = [
    "test.record",
    "test.exercise",
    "test.unsubscribed",
    "test.recreate",
    "test.finish",
    "plugin.windows.getMonitorSnapshot",
  ];
  const policy: Policy = {
    version: 1,
    backend: {
      permissions: [
        "windows.getMonitorSnapshot",
        "windows.recreate",
        "windows.close",
      ],
    },
    views: [
      "main",
      "no-event",
      "no-operation",
    ].map((id) => ({
      id,
      origins: [
        "https://app.bunaway.local",
      ],
      commands:
        id === "main"
          ? commands
          : [
              "test.denied",
              "test.waitDenied",
              "plugin.windows.getMonitorSnapshot",
            ],
      events:
        id === "no-event"
          ? []
          : [
              "windows.monitorsChanged",
            ],
      host: {
        permissions:
          id === "no-operation"
            ? []
            : [
                "windows.getMonitorSnapshot",
                ...(id === "main"
                  ? [
                      "windows.recreate",
                      "windows.close",
                    ]
                  : []),
              ],
      },
    })),
  };
  const app = defineApp({
    modules: [],
    plugins: [
      windowsPlugin,
    ],
    commands: {
      "test.record": {
        input: monitorChangeSchema,
        output: {
          const: null,
        },
        async run(input: unknown) {
          records.push(validateValue(monitorChangeSchema, input));
          return null;
        },
      },
      "test.denied": {
        input: {
          type: "string",
        },
        output: {
          const: null,
        },
        async run(input: unknown) {
          assert.equal(typeof input, "string");
          denied.add(input as string);
          return null;
        },
      },
      "test.waitDenied": {
        input: {
          const: null,
        },
        output: {
          type: "boolean",
        },
        async run() {
          deniedListenerReady = true;
          return finished;
        },
      },
      "test.exercise": {
        input: {
          const: null,
        },
        output: {
          type: "integer",
        },
        async run() {
          await waitFor(() => deniedListenerReady);
          documents++;
          assert.equal(
            records.length,
            (documents - 1) * 3,
            "Subscription replayed a previous observation",
          );
          const before = await windows.getMonitorSnapshot();
          sources.push(before.sourceId);
          const start = records.length;
          await notify(
            documents === 1 ? "initial" : `unsubscribed-${documents - 1}`,
          );
          await Bun.sleep(100);
          assert.equal(
            records.length,
            start,
            "Unchanged metrics or initial replay emitted an event",
          );
          await notify(`phase-${documents}`);
          await waitFor(() => records.length > start);
          const changed = await windows.getMonitorSnapshot();
          assert(changed.revision > before.revision);
          // Protocol validation deliberately returns objects with a null prototype.
          assert.deepEqual(
            records.at(-1),
            validateValue(monitorChangeSchema, {
              sourceId: changed.sourceId,
              revision: changed.revision,
              added: [],
              removed: [],
              changed: [
                changed.monitors[0]?.id,
              ],
              error: null,
            }),
          );
          const afterChange = records.length;
          await notify("fail");
          await waitFor(() => records.length > afterChange);
          const failed = await windows.getMonitorSnapshot();
          assert.deepEqual(failed.monitors, changed.monitors);
          assert.deepEqual(
            {
              ...failed.error,
            },
            {
              code: "INTERNAL",
              message: "Display information is unavailable.",
            },
          );
          assert(failed.revision > changed.revision);
          const afterError = records.length;
          await notify(`phase-${documents}`);
          await waitFor(() => records.length > afterError);
          const recovered = await windows.getMonitorSnapshot();
          assert.equal(recovered.error, null);
          assert(recovered.revision > failed.revision);
          assert(
            records
              .slice(start)
              .every((record) => record.sourceId === before.sourceId),
          );
          return documents;
        },
      },
      "test.unsubscribed": {
        ...noInput,
        async run() {
          const start = records.length;
          await notify(`unsubscribed-${documents}`);
          const snapshot = await windows.getMonitorSnapshot();
          assert.equal(
            snapshot.monitors[0]?.name,
            `Synthetic metrics unsubscribed-${documents}`,
          );
          await Bun.sleep(100);
          assert.equal(
            records.length,
            start,
            "Released monitor listener received an event",
          );
          return null;
        },
      },
      "test.recreate": {
        ...noInput,
        async run() {
          await windows.recreate({
            view: "main",
          });
          return null;
        },
      },
      "test.finish": {
        ...noInput,
        async run() {
          finished = true;
          await waitFor(() => denied.size === 2);
          assert.equal(
            new Set(sources).size,
            1,
            "Navigation or recreation changed monitor source identity",
          );
          await writeFile(
            reportPath,
            JSON.stringify({
              pass: true,
              documents,
              denied: denied.size,
              records: records.length,
            }),
          );
          for (const view of [
            "no-event",
            "no-operation",
            "main",
          ]) {
            await windows.close({
              view,
            });
          }
          return null;
        },
      },
    },
  });
  try {
    await runWindowsApp(app, {
      runtime: {
        id: "monitor-events",
        generation: crypto.randomUUID(),
      },
      backendContext: `backend-${crypto.randomUUID()}` as HostContext,
      policy,
      assets,
      dataRoot: resolve(output, `data-${process.pid}`),
      loader: resolve(
        root,
        "build/cache/webview2/sdk/build/native/x64/WebView2Loader.dll",
      ),
      windows: [
        "main",
        "no-event",
        "no-operation",
      ].map((view) => ({
        view,
        title: `Monitor ${view}`,
        home: `https://app.bunaway.local/${view === "main" ? "index" : view}.html`,
        window: {
          width: 640,
          height: 480,
        },
      })),
    });
  } finally {
    driver.close();
  }
}

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CommandContext, defineApp } from "@bunaway/backend";
import type { WindowReadiness } from "@bunaway/plugin-api/native";
import {
  windowReadinessSchema,
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
      "PASS WebView2 preparation: native/document/SDK, hidden creation, auto-show, scoped events, navigation, recreation, failures, cancellation, splashscreen handoff and final quit",
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
  const counts = new Map<string, number>();
  const records: {
    recipient: string;
    state: WindowReadiness;
  }[] = [];
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
      if (url.pathname === "/bad.html") {
        return new Response("failed", {
          status: 404,
        });
      }
      if (url.pathname === "/cancel.html") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://outside.bunaway.invalid/",
          },
        });
      }
      if (url.pathname === "/nosdk.html") {
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
  const views = [
    "splash",
    "observer",
    "denied",
    "main",
    "automatic",
    "document",
    "bad",
    "cancel",
    "nosdk",
  ];
  const grant = {
    identifier: "windows:control",
    allow: views.map((view) => ({
      view,
    })),
  };
  const policy: Policy = {
    version: 1,
    backend: {
      permissions: [
        grant,
      ],
    },
    views: views.map((id) => ({
      id,
      origins: [
        origin,
      ],
      commands: [
        "test.arrived",
        "test.record",
        ...(id === "splash"
          ? [
              "test.exercise",
            ]
          : []),
        "plugin.windows.getReadiness",
      ],
      events:
        id === "denied"
          ? []
          : [
              "windows.readiness",
              "test.action",
            ],
      host: {
        permissions: [
          {
            identifier: "windows:control",
            allow:
              id === "splash"
                ? views.map((view) => ({
                    view,
                  }))
                : [
                    {
                      view: id,
                    },
                  ],
          },
        ],
      },
    })),
  };
  const main = {
    view: "main",
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
  const ready = (view: string) =>
    waitFor(async () => {
      const state = await windows.getReadiness({
        view,
      });
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
  async function exercise(context: CommandContext): Promise<void> {
    await waitFor(
      () =>
        counts.has("splash") && counts.has("observer") && counts.has("denied"),
    );
    await windows.create(main);
    await waitFor(() => counts.get("main") === 1);
    const partial = await windows.getReadiness(main);
    assert.equal(partial.nativeCreated, true);
    assert.equal(partial.document, "pending");
    assert.equal(partial.sdk, "ready");
    assert.equal(await windows.isVisible(main), false);
    assert.equal(await windows.isFocused(main), false);
    await assert.rejects(
      windows.completeSplashscreen({
        ...main,
        splash: "splash",
      }),
      {
        code: "BUSY",
      },
    );
    releaseResources();
    await ready("main");
    assert.equal(await windows.isVisible(main), false);
    await context.events.emit("test.action", "navigate", {
      kind: "view",
      viewId: "main",
    });
    await waitFor(() => counts.get("main") === 2);
    await ready("main");
    const navigated = await windows.getReadiness(main);
    assert.equal(navigated.windowId, partial.windowId);
    assert(navigated.documentGeneration > partial.documentGeneration);
    await context.events.emit("test.action", "fragment", {
      kind: "view",
      viewId: "main",
    });
    await waitFor(() => counts.has("fragment"));
    assert.equal(
      (await windows.getReadiness(main)).documentGeneration,
      navigated.documentGeneration,
    );
    await windows.recreate(main);
    await waitFor(() => counts.get("main") === 3);
    await ready("main");
    const recreated = await windows.getReadiness(main);
    assert.notEqual(recreated.windowId, partial.windowId);
    assert(recreated.documentGeneration <= navigated.documentGeneration);
    await context.events.emit("test.action", "close-sdk", {
      kind: "view",
      viewId: "main",
    });
    await waitFor(
      async () => (await windows.getReadiness(main)).sdk === "cancelled",
    );
    assert.equal((await windows.getReadiness(main)).document, "ready");
    await windows.recreate(main);
    await waitFor(() => counts.get("main") === 4);
    await ready("main");
    for (const view of [
      "automatic",
      "document",
    ]) {
      await windows.create({
        view,
      });
      await waitFor(
        async () =>
          (
            await windows.getReadiness({
              view,
            })
          ).document === "ready",
      );
      if (view === "automatic") {
        await ready(view);
      }
      if (view === "document") {
        assert.equal(
          (
            await windows.getReadiness({
              view,
            })
          ).sdk,
          "pending",
        );
      }
      await waitFor(() =>
        windows.isVisible({
          view,
        }),
      );
      await windows.hide({
        view,
      });
      await windows.close({
        view,
      });
    }
    await windows.create({
      view: "bad",
    });
    await waitFor(
      async () =>
        (
          await windows.getReadiness({
            view: "bad",
          })
        ).document === "failed",
    );
    assert.equal(
      await windows.isVisible({
        view: "bad",
      }),
      false,
    );
    await windows.close({
      view: "bad",
    });
    const closed = await windows.getReadiness({
      view: "bad",
    });
    assert.equal(closed.document, "cancelled");
    held = true;
    await windows.create({
      view: "cancel",
    });
    await waitFor(
      async () =>
        (
          await windows.getReadiness({
            view: "cancel",
          })
        ).document === "cancelled",
    );
    assert.equal(
      await windows.isVisible({
        view: "cancel",
      }),
      false,
    );
    await windows.close({
      view: "cancel",
    });
    releaseResources();
    await windows.create({
      view: "nosdk",
    });
    await waitFor(
      async () =>
        (
          await windows.getReadiness({
            view: "nosdk",
          })
        ).document === "ready",
    );
    assert.equal(
      (
        await windows.getReadiness({
          view: "nosdk",
        })
      ).sdk,
      "pending",
    );
    assert.equal(
      await windows.isVisible({
        view: "nosdk",
      }),
      false,
    );
    await waitFor(
      async () =>
        (
          await windows.getReadiness({
            view: "nosdk",
          })
        ).sdk === "failed",
      35_000,
    );
    assert.equal(
      (
        await windows.getReadiness({
          view: "nosdk",
        })
      ).error?.code,
      "TIMEOUT",
    );
    assert.equal(
      await windows.isVisible({
        view: "nosdk",
      }),
      false,
    );
    await windows.close({
      view: "nosdk",
    });
    await Bun.sleep(100);
    assert(
      records.some(
        (record) =>
          record.recipient === "splash" &&
          record.state.viewId === "main" &&
          record.state.revision === 0,
      ),
    );
    assert(
      records.some(
        (record) =>
          record.recipient === "splash" &&
          record.state.document === "ready" &&
          record.state.sdk === "ready",
      ),
    );
    assert(
      !records.some(
        (record) =>
          record.recipient === "observer" && record.state.viewId !== "observer",
      ),
    );
    for (const view of [
      "observer",
      "denied",
    ]) {
      await windows.close({
        view,
      });
    }
    assert.equal(
      await windows.completeSplashscreen({
        ...main,
        splash: "splash",
      }),
      true,
    );
    assert.equal(quitChecks, 0, "Handoff invoked the final-window quit rule");
    assert.equal(await windows.isVisible(main), true);
    completed = true;
    await windows.close(main);
  }
  const app = defineApp({
    modules: [],
    plugins: [
      windowsPlugin,
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
            for (const view of views) {
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
    desktop: {
      beforeQuit() {
        quitChecks++;
        return true;
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
      "test.record": {
        input: {
          type: "object",
          properties: {
            recipient: {
              type: "string",
            },
            state: windowReadinessSchema,
          },
          required: [
            "recipient",
            "state",
          ],
          additionalProperties: false,
        },
        output: {
          const: null,
        },
        async run(input: unknown) {
          const record = validateValue(
            {
              type: "object",
              properties: {
                recipient: {
                  type: "string",
                },
                state: windowReadinessSchema,
              },
              required: [
                "recipient",
                "state",
              ],
              additionalProperties: false,
            } as const,
            input,
          );
          records.push(record);
          return null;
        },
      },
    },
  });
  try {
    await runWindowsApp(app, {
      runtime: {
        id: "window-readiness",
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
      windows: views.map((view) => ({
        view,
        title: `Readiness ${view}`,
        home: `${origin}/${view === "document" ? "nosdk" : view}.html`,
        window: {
          width: 640,
          height: 480,
        },
        startup: [
          "splash",
          "observer",
          "denied",
        ].includes(view),
        visible: view === "splash",
        ...([
          "automatic",
          "bad",
          "cancel",
          "nosdk",
        ].includes(view)
          ? {
              showWhenReady: "sdk" as const,
            }
          : {}),
        ...(view === "document"
          ? {
              showWhenReady: "document" as const,
            }
          : {}),
      })),
    });
    await exerciseTask;
    if (exerciseFailure) {
      throw exerciseFailure;
    }
    assert(completed);
    assert.equal(quitChecks, 1);
    await writeFile(
      reportPath,
      JSON.stringify({
        pass: true,
        documents: counts.get("main"),
        records: records.length,
        quitChecks,
      }),
    );
  } finally {
    releaseResources();
    await server.stop(true);
  }
}

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CommandContext, defineApp } from "@bunaway/backend";
import type { WindowIdentity, WindowSpec } from "@bunaway/plugin-api/native";
import { windows, windowsPlugin } from "@bunaway/plugin-windows";
import {
  type HostContext,
  type Policy,
  validateValue,
} from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";

const TEST_TIMEOUT_MS = 150_000;
const STATE_TIMEOUT_MS = 40_000;
const root =
  process.env.BUNAWAY_MULTIPLE_TEST_ROOT ?? resolve(import.meta.dir, "../..");
const output = resolve(root, "build/windows-multiple-windows");
const assets = resolve(output, "assets");
const dataRoot =
  process.env.BUNAWAY_MULTIPLE_DATA_ROOT ??
  resolve(output, `data-${crypto.randomUUID()}`);
const reportPath = resolve(output, "report.json");
assert.equal(process.platform, "win32");

if (!process.argv.includes("--child")) {
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/lifecycle/windows-bun/multiple-windows.js"),
    ],
    target: "browser",
  });
  assert(web.success && web.outputs[0], web.logs.map(String).join("\n"));
  await writeFile(resolve(assets, "app.js"), await web.outputs[0].text());
  const entry = await bundleNativeWorker(
    "windows-multiple-windows",
    assets,
    fileURLToPath(import.meta.url),
  );
  let port = "0";
  let previousLogLines = 0;
  for (const phase of [
    "exercise",
    "restart",
  ]) {
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
          BUNAWAY_MULTIPLE_TEST_ROOT: root,
          BUNAWAY_MULTIPLE_DATA_ROOT: dataRoot,
          BUNAWAY_MULTIPLE_PHASE: phase,
          BUNAWAY_MULTIPLE_PORT: port,
        },
      },
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const timer = setTimeout(() => child.kill(), TEST_TIMEOUT_MS);
    try {
      assert.equal(await child.exited, 0, `${await stderr}\n${await stdout}`);
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      assert.equal(report.pass, true);
      assert.equal(report.phase, phase);
      assert(Number.isInteger(report.port) && report.port > 0);
      port = String(report.port);
      const diagnosticLines = (
        await readFile(resolve(dataRoot, "logs/host.log"), "utf8")
      )
        .trim()
        .split("\n");
      const diagnostics = diagnosticLines
        .slice(previousLogLines)
        .map((line) => {
          const record: unknown = JSON.parse(line);
          assert(record && typeof record === "object" && "event" in record);
          return validateValue(
            {
              type: "object",
              properties: {
                event: {
                  type: "string",
                },
                view: {
                  type: "string",
                },
                browserPid: {
                  type: "integer",
                },
              },
              required: [
                "event",
                "view",
                "browserPid",
              ],
              additionalProperties: false,
            } as const,
            {
              event: record.event,
              view: "view" in record ? record.view : "",
              browserPid: "browserPid" in record ? record.browserPid : 0,
            },
          );
        });
      const sharedPids = diagnostics
        .filter(
          (record) =>
            record.event === "webview-ready" && record.view === "shared",
        )
        .map((record) => record.browserPid);
      assert(sharedPids.length > 0);
      assert.equal(
        new Set(sharedPids).size,
        1,
        "Shared windows created distinct browser environments",
      );
      assert(
        diagnostics.some((record) => record.event === "callbacks-quiescent"),
      );
      previousLogLines = diagnosticLines.length;
      const temporary = await readdir(
        resolve(dataRoot, "webview/temporary"),
      ).catch((error) => {
        if (error.code === "ENOENT") {
          return [];
        }
        throw error;
      });
      assert.deepEqual(
        temporary,
        [],
        "Final closure retained an isolated profile",
      );
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) {
        child.kill();
      }
      await child.exited;
    }
  }
  console.log(
    "PASS multiple WebView2 instances: exact caller identity, independent replies, scoped events, ID targeting, bounds, navigation, recreation, shared and isolated profiles, ownership, cleanup and restart",
  );
} else {
  const resultSchema = {
    type: "object",
    properties: {
      windowId: {
        type: "string",
      },
      viewId: {
        type: "string",
      },
      token: {
        type: "string",
      },
      action: {
        type: "string",
      },
      value: {
        type: "string",
      },
    },
    required: [
      "windowId",
      "viewId",
      "token",
      "action",
      "value",
    ],
    additionalProperties: false,
  } as const;
  const actionSchema = {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: {
          type: "string",
        },
      },
      action: {
        type: "string",
      },
      value: {
        type: "string",
      },
    },
    required: [
      "ids",
      "action",
      "value",
    ],
    additionalProperties: false,
  } as const;
  const records: ReturnType<typeof validateValue<typeof resultSchema>>[] = [];
  const held = new Set<string>();
  const aborted = new Set<string>();
  let denied = false;
  let completed = false;
  let exerciseTask: Promise<void> | undefined;
  let exerciseFailure: unknown;
  const phase = process.env.BUNAWAY_MULTIPLE_PHASE ?? "exercise";
  const script = await readFile(resolve(assets, "app.js"), "utf8");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.BUNAWAY_MULTIPLE_PORT ?? "0"),
    fetch(request) {
      return new URL(request.url).pathname === "/app.js"
        ? new Response(script, {
            headers: {
              "Content-Type": "text/javascript",
            },
          })
        : new Response(
            '<!doctype html><script type="module" src="/app.js"></script>',
            {
              headers: {
                "Content-Type": "text/html",
              },
            },
          );
    },
  });
  const origin = server.url.origin;
  const roles = [
    "main",
    "shared",
    "isolated",
    "denied",
  ];
  const grant = {
    identifier: "windows:control",
    allow: roles.map((view) => ({
      view,
    })),
  };
  const policy: Policy = {
    version: 1,
    backend: {
      permissions: [
        "windows:list",
        grant,
        {
          identifier: "windows:destroy",
          allow: roles.map((view) => ({
            view,
          })),
        },
      ],
    },
    views: roles.map((role) => ({
      id: role,
      origins: [
        origin,
      ],
      commands: [
        "test.echo",
        "test.result",
        "test.hold",
        "test.denied",
        "plugin.windows.getCurrent",
        "plugin.windows.createInstance",
      ],
      events: [
        "test.action",
        "windows.changed",
      ],
      host: {
        permissions:
          role === "denied"
            ? []
            : [
                "windows:list",
                {
                  identifier: "windows:control",
                  allow: [
                    {
                      view: role,
                    },
                  ],
                },
              ],
      },
    })),
  };
  const specs: WindowSpec[] = roles.map((view) => ({
    view,
    title: view,
    home: `${origin}/${view}.html`,
    window: {
      width: 640,
      height: 480,
    },
    startup: view !== "isolated",
    visible: false,
    ...(view === "shared"
      ? {
          instances: "multiple" as const,
          maxInstances: 3,
        }
      : {}),
    ...(view === "isolated"
      ? {
          instances: "multiple" as const,
          maxInstances: 2,
          profile: "isolated" as const,
        }
      : {}),
  }));
  async function waitFor(
    check: () => boolean | Promise<boolean>,
  ): Promise<void> {
    const deadline = Date.now() + STATE_TIMEOUT_MS;
    while (!(await check())) {
      const error = records.find((record) => record.action === "error");
      assert(!error, error?.value ?? "Instance page reported an error");
      assert(Date.now() < deadline, "Instance state timed out");
      await Bun.sleep(10);
    }
  }
  const target = (identity: WindowIdentity) => ({
    view: identity.viewId,
    windowId: identity.windowId,
  });
  const arrivals = (id: string) =>
    records.filter(
      (record) => record.windowId === id && record.action === "arrived",
    );
  async function exercise(context: CommandContext): Promise<void> {
    await waitFor(
      () =>
        denied &&
        records.some((record) => record.viewId === "main") &&
        records.some((record) => record.viewId === "shared"),
    );
    assert.equal(await windows.getCurrent(), null);
    const initial = await windows.listInstances();
    const main = initial.find((identity) => identity.viewId === "main");
    const first = initial.find((identity) => identity.viewId === "shared");
    assert(main && first);
    assert.equal(
      initial.filter((identity) => identity.viewId === "shared").length,
      1,
      "Startup created more than one instance",
    );
    async function action(
      identity: WindowIdentity,
      name: string,
      value = "",
    ): Promise<string> {
      const count = records.filter(
        (record) =>
          record.windowId === identity.windowId && record.action === name,
      ).length;
      await context.events.emit(
        "test.action",
        {
          ids: [
            identity.windowId,
          ],
          action: name,
          value,
        },
        {
          kind: "view",
          viewId: identity.viewId,
        },
      );
      await waitFor(
        () =>
          records.filter(
            (record) =>
              record.windowId === identity.windowId && record.action === name,
          ).length > count,
      );
      const record = records
        .filter(
          (record) =>
            record.windowId === identity.windowId && record.action === name,
        )
        .at(-1);
      assert(record);
      return record.value;
    }
    if (phase === "restart") {
      assert((await action(first, "read")).startsWith("persisted|"));
      const isolated = await windows.createInstance({
        view: "isolated",
      });
      await waitFor(() => arrivals(isolated.windowId).length === 1);
      assert((await action(isolated, "read")).startsWith("|"));
    } else {
      const [second, third] = await Promise.all([
        windows.createInstance({
          view: "shared",
          options: {
            title: "Second",
          },
        }),
        windows.createInstance({
          view: "shared",
        }),
      ]);
      assert.equal(
        new Set([
          first.windowId,
          second.windowId,
          third.windowId,
        ]).size,
        3,
      );
      await waitFor(
        () =>
          arrivals(second.windowId).length === 1 &&
          arrivals(third.windowId).length === 1,
      );
      await assert.rejects(
        windows.createInstance({
          view: "shared",
        }),
        {
          code: "BUSY",
        },
      );
      await assert.rejects(
        windows.show({
          view: "shared",
        }),
        {
          code: "INVALID_ARGUMENT",
        },
      );
      await assert.rejects(
        windows.show({
          view: "isolated",
          windowId: second.windowId,
        }),
        {
          code: "INVALID_ARGUMENT",
        },
      );
      await assert.rejects(
        windows.create({
          view: "shared",
        }),
        {
          code: "INVALID_ARGUMENT",
        },
      );
      await action(first, "set", "persisted");
      assert((await action(second, "read")).startsWith("persisted|"));
      assert(
        (await action(third, "read")).includes("instance-value=persisted"),
      );
      await context.events.emit(
        "test.action",
        {
          ids: [
            first.windowId,
          ],
          action: "hold",
          value: "",
        },
        {
          kind: "view",
          viewId: "shared",
        },
      );
      await waitFor(() => held.has(first.windowId));
      const firstToken = arrivals(first.windowId)[0]?.token;
      await context.events.emit(
        "test.action",
        {
          ids: [
            first.windowId,
          ],
          action: "navigate",
          value: "",
        },
        {
          kind: "view",
          viewId: "shared",
        },
      );
      await waitFor(
        () =>
          arrivals(first.windowId).length === 2 && aborted.has(first.windowId),
      );
      assert.notEqual(arrivals(first.windowId)[1]?.token, firstToken);
      assert((await action(second, "read")).startsWith("persisted|"));
      const secondChanges = records.filter(
        (record) =>
          record.windowId === second.windowId && record.action === "changed",
      ).length;
      await windows.setSize({
        ...target(second),
        width: 700,
        height: 500,
      });
      await waitFor(
        () =>
          records.filter(
            (record) =>
              record.windowId === second.windowId &&
              record.action === "changed",
          ).length > secondChanges,
      );
      await windows.close(target(first));
      await waitFor(
        async () =>
          (await windows.getById({
            windowId: first.windowId,
          })) === null,
      );
      // Closing the environment's first controller must leave its sibling sessions running.
      assert((await action(second, "read")).startsWith("persisted|"));
      await assert.rejects(windows.recreateInstance(target(first)), {
        code: "INVALID_ARGUMENT",
      });
      assert.equal(await windows.isDestroyed(target(first)), true);
      const replaced = await windows.recreateInstance({
        ...target(second),
        options: {
          window: {
            width: 900,
          },
        },
      });
      assert.notEqual(replaced.windowId, second.windowId);
      await waitFor(() => arrivals(replaced.windowId).length === 1);
      assert((await action(replaced, "read")).startsWith("persisted|"));
      assert.equal(
        await windows.getById({
          windowId: second.windowId,
        }),
        null,
      );
      const [isolatedA, isolatedB] = await Promise.all([
        windows.createInstance({
          view: "isolated",
        }),
        windows.createInstance({
          view: "isolated",
        }),
      ]);
      await waitFor(
        () =>
          arrivals(isolatedA.windowId).length === 1 &&
          arrivals(isolatedB.windowId).length === 1,
      );
      assert((await action(isolatedA, "read")).startsWith("|"));
      await action(isolatedA, "set", "private");
      assert((await action(isolatedB, "read")).startsWith("|"));
      await windows.setParent({
        ...target(isolatedA),
        parent: replaced.windowId,
        modal: true,
      });
      assert.equal(await windows.isEnabled(target(replaced)), false);
      const isolatedReplacement = await windows.recreateInstance(
        target(isolatedA),
      );
      await waitFor(() => arrivals(isolatedReplacement.windowId).length === 1);
      assert(
        (await action(isolatedReplacement, "read")).startsWith("private|"),
      );
      assert.equal(
        (await windows.getParent(target(isolatedReplacement)))?.windowId,
        replaced.windowId,
      );
      assert.equal(await windows.isEnabled(target(replaced)), false);
      await windows.close(target(isolatedReplacement));
      await waitFor(async () => await windows.isEnabled(target(replaced)));
      // A cleaned final owner frees capacity and the next instance receives a fresh profile.
      let fresh: WindowIdentity | undefined;
      await waitFor(async () => {
        try {
          fresh = await windows.createInstance({
            view: "isolated",
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
      assert(fresh);
      await waitFor(
        () => fresh !== undefined && arrivals(fresh.windowId).length === 1,
      );
      assert((await action(fresh, "read")).startsWith("|"));
      assert(!records.some((record) => record.action === "error"));
    }
    for (const identity of await windows.listInstances()) {
      if (identity.windowId !== main.windowId) {
        await windows.close(target(identity));
      }
    }
    await windows.show({
      view: "main",
    });
    completed = true;
    await windows.destroy({
      view: "main",
    });
  }
  const app = defineApp({
    modules: [],
    desktop: {
      closeBehavior: "keep-alive",
    },
    plugins: [
      windowsPlugin,
      {
        name: "instances-test",
        version: "1.0.0",
        setup(context: CommandContext) {
          exerciseTask = exercise(context).catch(async (error) => {
            if (
              completed &&
              error instanceof Error &&
              "code" in error &&
              error.code === "CANCELLED"
            ) {
              return;
            }
            exerciseFailure = error;
            console.error(error);
            for (const identity of await windows
              .listInstances()
              .catch(() => [])) {
              await windows.close(target(identity)).catch(() => {});
            }
            await windows
              .destroy({
                view: "main",
              })
              .catch(() => {});
          });
        },
      },
    ],
    events: {
      "test.action": actionSchema,
    },
    commands: {
      "test.echo": {
        input: {
          type: "string",
        },
        output: {
          type: "string",
        },
        async run(input: unknown) {
          assert.equal(typeof input, "string");
          return String(input);
        },
      },
      "test.result": {
        input: resultSchema,
        output: {
          const: null,
        },
        async run(input: unknown) {
          records.push(validateValue(resultSchema, input));
          return null;
        },
      },
      "test.denied": {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run() {
          denied = true;
          return null;
        },
      },
      "test.hold": {
        input: {
          type: "string",
        },
        output: {
          const: null,
        },
        run(input: unknown, context: CommandContext) {
          assert.equal(typeof input, "string");
          const id = String(input);
          held.add(id);
          return new Promise<null>((_resolve, reject) => {
            context.signal.addEventListener("abort", () => {
              aborted.add(id);
              reject(new Error("Instance session revoked"));
            });
          });
        },
      },
    },
  });
  try {
    await runWindowsApp(app, {
      runtime: {
        id: "multiple-windows",
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
      windows: specs,
    });
    await exerciseTask;
    if (exerciseFailure) {
      throw exerciseFailure;
    }
    assert(completed);
    await writeFile(
      reportPath,
      JSON.stringify({
        pass: true,
        phase,
        port: server.port,
        records: records.length,
        aborted: [
          ...aborted,
        ],
      }),
    );
  } finally {
    server.stop(true);
  }
}

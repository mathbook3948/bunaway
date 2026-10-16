import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CommandContext, defineApp } from "@bunaway/backend";
import type { WindowIdentity, WindowSpec } from "@bunaway/plugin-api/native";
import windows from "@bunaway/plugin-windows";
import {
  type HostContext,
  type Policy,
  validateValue,
} from "@bunaway/protocol";
import { runWindowsApp } from "#native/windows/bun/entry";
import { bundleNativeWorker } from "../fixtures/native-worker.ts";
import { windowPermissions } from "../fixtures/window-permissions.ts";

const WM_CLOSE = 0x10;
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
  const phases = [];
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
                browserVersion: {
                  type: "string",
                },
              },
              required: [
                "event",
                "view",
                "browserPid",
                "browserVersion",
              ],
              additionalProperties: false,
            } as const,
            {
              event: record.event,
              view: "view" in record ? record.view : "",
              browserPid: "browserPid" in record ? record.browserPid : 0,
              browserVersion:
                "browserVersion" in record ? record.browserVersion : "",
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
      const firstFailure = diagnostics.findIndex(
        (record) =>
          record.event === "webview-process-failed" && record.view === "shared",
      );
      const beforeFailure =
        firstFailure === -1 ? diagnostics : diagnostics.slice(0, firstFailure);
      const beforeFailurePids = beforeFailure
        .filter(
          (record) =>
            record.event === "webview-ready" && record.view === "shared",
        )
        .map((record) => record.browserPid);
      assert.equal(
        new Set(beforeFailurePids.slice(0, phase === "exercise" ? 4 : 1)).size,
        1,
        "Shared windows created distinct browser environments",
      );
      if (phase === "exercise") {
        assert.equal(beforeFailurePids.length, 8);
        assert.equal(new Set(beforeFailurePids.slice(4, 6)).size, 1);
        assert.equal(new Set(beforeFailurePids.slice(6)).size, 1);
        assert.notEqual(beforeFailurePids[6], beforeFailurePids[4]);
      }
      assert.equal(new Set(sharedPids).size, phase === "exercise" ? 4 : 1);
      const browserVersions = [
        ...new Set(
          diagnostics
            .filter((record) => record.event === "webview-ready")
            .map((record) => record.browserVersion),
        ),
      ];
      assert(
        browserVersions.length > 0 &&
          browserVersions.every((version) => version.length > 0),
      );
      phases.push({
        phase,
        browserVersions,
        report,
      });
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
  const summary = {
    pass: true,
    platform: process.platform,
    osRelease: release(),
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    phases,
  };
  await writeFile(
    resolve(root, "build/windows-multiple-windows-results.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(summary);
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

  const policy: Policy = {
    version: 1,
    backend: {
      permissions: windowPermissions(),
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
        "windows.lifecycle",
      ],
      host: {
        permissions: role === "denied" ? [] : windowPermissions(),
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
  /** Phases the `main` document observed for one windowId, from its longest reported snapshot. */
  function lifecyclePhases(windowId: string): string[] {
    let longest: readonly string[] = [];
    for (const record of records) {
      if (record.action !== "lifecycle") {
        continue;
      }
      const snapshot = validateValue(
        {
          type: "array",
          items: {
            type: "string",
          },
        } as const,
        JSON.parse(record.value),
      );
      if (snapshot.length > longest.length) {
        longest = snapshot;
      }
    }
    return longest
      .filter((entry) => entry.startsWith(`${windowId}:`))
      .map((entry) => entry.slice(windowId.length + 1));
  }
  /** The host logs each HWND when it creates a window; the newest entry belongs to the latest instance. */
  async function newestWindowHandle(view: string): Promise<bigint> {
    const lines = (await readFile(resolve(dataRoot, "logs/host.log"), "utf8"))
      .trim()
      .split("\n");
    const handles = lines.flatMap((line) => {
      const record: unknown = JSON.parse(line);
      return record &&
        typeof record === "object" &&
        "event" in record &&
        record.event === "window-created" &&
        "view" in record &&
        record.view === view &&
        "hwnd" in record &&
        typeof record.hwnd === "string"
        ? [
            BigInt(record.hwnd),
          ]
        : [];
    });
    const handle = handles.at(-1);
    assert(handle, `No window-created record for ${view}`);
    return handle;
  }
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
    async function createWhenReady(view: string): Promise<WindowIdentity> {
      let created: WindowIdentity | undefined;
      await waitFor(async () => {
        try {
          created = await windows.createInstance({
            view,
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
      assert(created);
      const identity = created;
      await waitFor(() => arrivals(identity.windowId).length === 1);
      return identity;
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
      // `main` observes windows.lifecycle: a user close (WM_CLOSE, no confirmation set) of a new
      // instance must report exactly created, ready, closed and destroyed, in that order.
      const observed = await createWhenReady("isolated");
      await waitFor(() => lifecyclePhases(observed.windowId).includes("ready"));
      const user32 = dlopen("user32.dll", {
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
      assert(
        user32.symbols.PostMessageW(
          await newestWindowHandle("isolated"),
          WM_CLOSE,
          0n,
          0n,
        ),
      );
      await waitFor(() => lifecyclePhases(observed.windowId).length >= 4);
      assert.deepEqual(lifecyclePhases(observed.windowId), [
        "created",
        "ready",
        "closed",
        "destroyed",
      ]);
      user32.close();
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
      const fresh = await createWhenReady("isolated");
      assert((await action(fresh, "read")).startsWith("|"));
      // A normal profile shutdown commits storage before testing an abrupt browser failure.
      await windows.close(target(replaced));
      await windows.close(target(third));
      let checkpoint = await createWhenReady("shared");
      assert((await action(checkpoint, "read")).startsWith("persisted|"));
      let checkpointPeer = await createWhenReady("shared");
      // Retire every controller concurrently. Each replacement waits for the shared
      // environment drain, then joins one fresh environment without losing its slot.
      const retired = [
        checkpoint,
        checkpointPeer,
      ];
      [checkpoint, checkpointPeer] = await Promise.all([
        windows.recreateInstance(target(checkpoint)),
        windows.recreateInstance(target(checkpointPeer)),
      ]);
      await waitFor(() =>
        [
          checkpoint,
          checkpointPeer,
        ].every((identity) => arrivals(identity.windowId).length === 1),
      );
      for (const identity of retired) {
        assert.equal(
          await windows.getById({
            windowId: identity.windowId,
          }),
          null,
        );
      }
      assert((await action(checkpoint, "read")).startsWith("persisted|"));
      assert((await action(checkpointPeer, "read")).startsWith("persisted|"));
      // A shared browser failure closes all its controllers while isolated profiles keep serving calls.
      const diagnosticLines = (
        await readFile(resolve(dataRoot, "logs/host.log"), "utf8")
      )
        .trim()
        .split("\n");
      const ready = diagnosticLines
        .map((line) => {
          const record: unknown = JSON.parse(line);
          return record &&
            typeof record === "object" &&
            "event" in record &&
            record.event === "webview-ready" &&
            "view" in record &&
            record.view === "shared" &&
            "browserPid" in record &&
            typeof record.browserPid === "number"
            ? record.browserPid
            : undefined;
        })
        .filter((pid) => pid !== undefined)
        .at(-1);
      assert(ready);
      const killed = Bun.spawn(
        [
          "taskkill",
          "/PID",
          String(ready),
          "/F",
          "/T",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const killedOutput = new Response(killed.stdout).text();
      const killedErrors = new Response(killed.stderr).text();
      assert.equal(
        await killed.exited,
        0,
        `${await killedOutput}\n${await killedErrors}`,
      );
      await waitFor(
        async () =>
          (await windows.getById({
            windowId: checkpoint.windowId,
          })) === null &&
          (await windows.getById({
            windowId: checkpointPeer.windowId,
          })) === null,
      );
      assert((await action(isolatedB, "read")).startsWith("|"));
      const recovered = await createWhenReady("shared");
      assert((await action(recovered, "read")).startsWith("persisted|"));
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
      windows,
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

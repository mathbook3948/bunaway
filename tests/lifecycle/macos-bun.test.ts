import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { type HostContext, PROTOCOL_VERSION } from "@bunaway/protocol";
import {
  Channel,
  type Packet,
  validatePacket,
} from "@bunaway/runtime-bun/worker-channel";
import { appModules } from "#cli/app-modules";
import { bundleMacosHost } from "#cli/assets";
import { type InstalledPlugin, writePluginManifest } from "#cli/plugins";
import {
  type MacosConfig,
  readMacosWindowSpecs,
} from "#native/macos/bun/config";
import {
  macosOrigin,
  platformUrl,
  resourceRules,
} from "#native/macos/bun/urls";
import { windowPermissions } from "../fixtures/window-permissions.ts";

test("macOS rejects declared focusability rather than ignoring an unsupported native flag", () => {
  const config = workerConfig("unused");
  const first = config.windows[0];
  if (!first) {
    throw new Error("Missing test window.");
  }
  for (const focusable of [
    true,
    false,
  ]) {
    expect(() =>
      readMacosWindowSpecs(
        [
          {
            ...first,
            window: {
              ...first.window,
              focusable,
            },
          },
        ],
        config.policy,
      ),
    ).toThrow("Initial window focusability is not implemented on macOS");
  }
});

test("macOS rejects declared initial window state rather than ignoring it", () => {
  const config = workerConfig("unused");
  const first = config.windows[0];
  if (!first) {
    throw new Error("Missing test window.");
  }
  for (const state of [
    {
      maximized: true,
    },
    {
      fullscreen: true,
    },
    {
      maximized: false,
      fullscreen: false,
    },
  ]) {
    expect(() =>
      readMacosWindowSpecs(
        [
          {
            ...first,
            window: {
              ...first.window,
              ...state,
            },
          },
        ],
        config.policy,
      ),
    ).toThrow("Initial window state options are not implemented on macOS");
  }
});

test("macOS rejects explicitly declared initial placement, including defaults on deferred windows", () => {
  const config = workerConfig("unused");
  const first = config.windows[0];
  if (!first) {
    throw new Error("Missing test window.");
  }
  const policyView = config.policy.views[0];
  if (!policyView) {
    throw new Error("Missing policy view.");
  }
  for (const placement of [
    {
      x: -100,
      y: 0,
    },
    {
      x: null,
      y: null,
    },
    {
      center: false,
    },
    {
      useContentSize: true,
    },
    {
      preventOverflow: false,
    },
  ]) {
    expect(() =>
      readMacosWindowSpecs(
        [
          first,
          {
            ...first,
            view: "deferred",
            startup: false,
            window: {
              ...first.window,
              ...placement,
            },
          },
        ],
        {
          ...config.policy,
          views: [
            ...config.policy.views,
            {
              ...policyView,
              id: "deferred",
            },
          ],
        },
      ),
    ).toThrow("Initial window placement options are not implemented on macOS");
  }
  expect(() =>
    readMacosWindowSpecs(
      [
        {
          ...first,
          window: {
            ...first.window,
            x: 1,
          },
        },
      ],
      config.policy,
    ),
  ).toThrow("Window placement");
});

/** Minimal validated configuration shared by real Worker lifecycle tests. */
function workerConfig(directory: string): MacosConfig {
  return {
    runtime: {
      id: "test",
      generation: crypto.randomUUID(),
    },
    backendContext: "backend-test" as HostContext,
    assets: directory,
    dataRoot: directory,
    windows: [
      {
        view: "main",
        home: "https://app.bunaway.local/",
        title: "Test",
        window: {
          width: 800,
          height: 600,
        },
      },
    ],
    policy: {
      version: 1,
      backend: {
        permissions: [],
      },
      views: [
        {
          id: "main",
          origins: [
            "https://app.bunaway.local",
          ],
          commands: [
            "ping",
          ],
          events: [],
          host: {
            permissions: [],
          },
        },
      ],
    },
  };
}

/** Bundle the real host lifecycle with a replaceable native UI for process tests. */
async function bundleTestHost(
  directory: string,
  plugins: readonly InstalledPlugin[] = [],
): Promise<void> {
  // Keep the lifecycle and Worker real, replacing only the native UI dependency.
  const build = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../../native/macos/bun/entry.ts"),
      resolve(import.meta.dir, "../../native/macos/bun/host-operations.ts"),
    ],
    target: "bun",
    outdir: directory,
    plugins: [
      {
        name: "test-ui",
        setup(build) {
          appModules({
            platform: "macos",
            plugins,
          }).setup(build);
          if (process.platform !== "darwin") {
            build.onResolve(
              {
                filter: /^\.\/process-group\.ts$/,
              },
              () => ({
                path: "test-process-group",
                namespace: "test",
              }),
            );
            build.onLoad(
              {
                filter: /.*/,
                namespace: "test",
              },
              () => ({
                contents:
                  "export async function containMacosProcess() { return {stopDescendants: async () => {}, close: async () => {}}; }",
                loader: "js",
              }),
            );
          }
          build.onResolve(
            {
              filter: /^\.\/application\.ts$/,
            },
            () => ({
              path: "test-application",
              namespace: "test-application",
            }),
          );
          build.onLoad(
            {
              filter: /.*/,
              namespace: "test-application",
            },
            () => ({
              contents:
                "export class MacosApplication { activate() {} close() {} }",
              loader: "js",
            }),
          );
          build.onResolve(
            {
              filter: /^\.\/webview\.ts$/,
            },
            () => ({
              path: pathToFileURL(resolve(directory, "webview.ts")).href,
              external: true,
            }),
          );
        },
      },
    ],
  });
  expect(build.success).toBe(true);
}

test("macOS asset origins reject credentials and preserve non-default ports", () => {
  expect(macosOrigin("bunaway://app.bunaway.local/a")).toBe(
    "https://app.bunaway.local",
  );
  expect(macosOrigin("bunaway://app.bunaway.local:443/a")).toBe(
    "https://app.bunaway.local",
  );
  expect(macosOrigin("bunaway://app.bunaway.local:444/a")).toBe(
    "https://app.bunaway.local:444",
  );
  expect(macosOrigin("bunaway://user@app.bunaway.local/a")).toBe("");
  expect(macosOrigin("file:///private/tmp/a")).toBe("");
  expect(platformUrl("https://app.bunaway.local/index.html")).toBe(
    "bunaway://app.bunaway.local/index.html",
  );
  expect(platformUrl("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
  const filters = JSON.parse(
    resourceRules([
      "http://127.0.0.1:5173",
    ]),
  );
  expect(filters[1].trigger["url-filter"]).toBe(
    "^http://127\\.0\\.0\\.1:5173[/?#]",
  );
});

test("macOS native registration validates its direction and exact metadata before dispatch", () => {
  const packet = {
    kind: "native-register",
    plugins: [],
    complete: true,
  } satisfies Packet;
  expect(validatePacket(packet, "macos-main")).toEqual(packet);
  expect(() => validatePacket(packet, "macos-backend")).toThrow();
  const native = {
    operations: [],
  };
  expect(() =>
    validatePacket(
      {
        ...packet,
        complete: "true",
      },
      "macos-main",
    ),
  ).toThrow();
  expect(() =>
    validatePacket(
      {
        ...packet,
        complete: false,
      },
      "macos-main",
    ),
  ).toThrow();
  for (const registration of [
    {
      name: 123,
      version: "1",
      native,
    },
    {
      name: "test",
      version: 123,
      native,
    },
    {
      name: "test",
      version: "1",
      native,
      extra: true,
    },
    {
      name: "test",
      version: "1",
    },
    null,
  ]) {
    expect(() =>
      validatePacket(
        {
          ...packet,
          plugins: [
            registration,
          ],
        },
        "macos-main",
      ),
    ).toThrow();
  }
});

test("macOS window declarations preserve exact asset ports and reject mixed origins", () => {
  const config = workerConfig("/tmp");
  const first = config.windows[0];
  if (!first) {
    throw new Error("Missing test window.");
  }
  const policy = {
    ...config.policy,
    views: [
      {
        ...config.policy.views[0],
        id: "main",
        origins: [
          "https://app.bunaway.local:8443",
        ],
        commands: [],
        events: [],
        host: {
          permissions: [],
        },
      },
    ],
  };
  expect(
    readMacosWindowSpecs(
      [
        {
          ...first,
          home: "https://app.bunaway.local:8443/",
        },
      ],
      policy,
    )[0]?.home,
  ).toContain(":8443");
  expect(() =>
    readMacosWindowSpecs(
      [
        {
          ...first,
          home: "https://app.bunaway.local/",
        },
      ],
      policy,
    ),
  ).toThrow();
  expect(() =>
    readMacosWindowSpecs(
      [
        {
          ...first,
          home: "https://external.example/",
        },
      ],
      policy,
    ),
  ).toThrow();
  expect(() => readMacosWindowSpecs([], policy)).toThrow(
    "macOS requires at least one startup window",
  );
  expect(() =>
    readMacosWindowSpecs(
      [
        {
          ...first,
          home: "https://app.bunaway.local:8443/",
          startup: false,
        },
      ],
      policy,
    ),
  ).toThrow("macOS requires at least one startup window");
});

test("macOS backend Worker uses core sessions and acknowledges shutdown before plugin cleanup", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-worker-"));
  let worker: Worker | undefined;
  let channel: Channel | undefined;
  try {
    const app = resolve(directory, "app.ts");
    const marker = resolve(directory, "stopped.txt");
    await Bun.write(
      app,
      `export default {
      events: {},
      commands: { ping: { input: {const:null}, output: {const:"pong"}, run: () => "pong" } },
      plugins: [{name:"cleanup",version:"1.0.0",setup(){return () => Bun.write(${JSON.stringify(marker)},"stopped").then(() => {});}}]
    };`,
    );
    await bundleMacosHost(
      resolve(import.meta.dir, "../../native/macos/bun"),
      directory,
      app,
    );
    const config = workerConfig(directory);
    const runtime = config.runtime;
    const packets: Packet[] = [];
    const waiters = new Map<string, (packet: Packet) => void>();
    const next = (kind: Packet["kind"]) =>
      new Promise<Packet>((done) => waiters.set(kind, done));
    const ready = next("ready");
    const backend = new Worker(
      new URL(`file://${resolve(directory, "backend.js")}`),
      {
        workerData: config,
      },
    );
    worker = backend;
    const exited = new Promise<number>((done) => backend.once("exit", done));
    const errors: unknown[] = [];
    backend.on("error", (error) => errors.push(error));
    channel = new Channel(
      backend,
      runtime,
      "macos-main",
      (packet) => {
        packets.push(packet);
        waiters.get(packet.kind)?.(packet);
        waiters.delete(packet.kind);
      },
      (error) => errors.push(error),
    );
    await ready;
    const route = {
      viewId: "main",
      documentGeneration: 0,
      context: "ctx-test" as HostContext,
    };
    await channel.send({
      kind: "session-open",
      route,
    });
    const hello = next("server");
    await channel.send({
      kind: "client",
      route,
      message: {
        kind: "hello",
        protocol: PROTOCOL_VERSION,
        features: [],
        buildId: "test",
      },
    });
    expect((await hello).kind).toBe("server");
    const result = next("server");
    await channel.send({
      kind: "client",
      route,
      message: {
        kind: "invoke",
        protocol: PROTOCOL_VERSION,
        id: "request-1",
        command: "ping",
        payload: null,
      },
    });
    expect(await result).toMatchObject({
      kind: "server",
      message: {
        kind: "result",
        payload: "pong",
      },
    });
    await channel.send({
      kind: "revoke",
      route,
    });
    const cleaned = next("cleaned");
    await channel.send({
      kind: "shutdown",
    });
    await cleaned;
    expect(await exited).toBe(0);
    expect(await Bun.file(marker).text()).toBe("stopped");
    expect(errors).toEqual([]);
    expect(packets.filter((packet) => packet.kind === "fatal")).toEqual([]);
  } finally {
    channel?.close();
    await worker?.terminate();
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}, 15000);

test.each([
  "cooperative",
  "blocked",
  "close-during-setup",
  "unexpected-exit",
] as const)(
  "macOS startup %s preserves its outcome and waits for backend cleanup without UI ticks",
  async (cleanup) => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "bunaway-macos-startup-"),
    );
    try {
      const started = resolve(directory, "started.txt");
      const stopped = resolve(directory, "stopped.txt");
      const continueSetup = resolve(directory, "continue-setup.txt");
      const closeDuringSetup = cleanup === "close-during-setup";
      const app = resolve(directory, "app.ts");
      await Bun.write(
        app,
        `${cleanup === "unexpected-exit" ? "process.exit(0);" : ""}
        export default {
        commands: {}, events: {},
        plugins: [{name:"cleanup", version:"1.0.0", async setup() {
          await Bun.write(${JSON.stringify(started)}, "started");
          ${closeDuringSetup ? `while (!await Bun.file(${JSON.stringify(continueSetup)}).exists()) await Bun.sleep(5);` : ""}
          return async () => {
            ${cleanup === "blocked" ? "while (true) {}" : `await Bun.sleep(100); await Bun.write(${JSON.stringify(stopped)}, "stopped");`}
          };
        }}]
      };`,
      );
      await bundleMacosHost(
        resolve(import.meta.dir, "../../native/macos/bun"),
        directory,
        app,
      );
      await bundleTestHost(directory);
      await Bun.write(
        resolve(directory, "webview.ts"),
        `export class MacosWebview {
        observeStartup() {}
        constructor(config, hooks) {
        this.ready = (async () => {
          ${cleanup === "unexpected-exit" ? "return;" : ""}
          const deadline = Date.now() + 5000;
          while (!await Bun.file(${JSON.stringify(started)}).exists()) {
            if (Date.now() >= deadline) throw new Error("Backend setup timed out");
            await Bun.sleep(5);
          }
          ${closeDuringSetup ? `hooks.close(); await Bun.write(${JSON.stringify(continueSetup)}, "continue");` : 'throw new Error("UI setup failed");'}
        })();
        }
        start() {}
        close() {}
      }`,
      );
      await Bun.write(
        resolve(directory, "run.ts"),
        `
        import {runMacosApp} from "./entry.js";
        try { await runMacosApp(${JSON.stringify(workerConfig(directory))}); }
        catch (error) { console.error(error.message); process.exitCode = 1; }
      `,
      );
      const startedAt = performance.now();
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(directory, "run.ts"),
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15000,
        },
      );
      const output = new Response(child.stdout).text();
      const errors = new Response(child.stderr).text();
      expect(await child.exited, await errors).toBe(closeDuringSetup ? 0 : 1);
      if (cleanup === "blocked") {
        expect(performance.now() - startedAt).toBeGreaterThanOrEqual(5000);
      }
      await output;
      if (closeDuringSetup) {
        expect(await errors).toBe("");
      } else {
        expect(await errors).toContain(
          cleanup === "unexpected-exit"
            ? "macOS backend exited during startup (0)."
            : "UI setup failed",
        );
      }
      expect(await Bun.file(stopped).exists()).toBe(
        cleanup === "cooperative" || closeDuringSetup,
      );
      const records = (
        await Bun.file(resolve(directory, "logs/host.log")).text()
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({
        event: "host-stopped",
        exitCode: closeDuringSetup ? 0 : 1,
        failed: !closeDuringSetup,
        forced: cleanup === "blocked",
      });
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  },
  20000,
);

test.each([
  "valid",
  "duplicate",
  "mismatch",
  "limit",
] as const)(
  "macOS batched native registration %s validates the complete registry before setup",
  async (mode) => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "bunaway-macos-batches-"),
    );
    try {
      const marker = resolve(directory, "setup.txt");
      const plugins = Array.from(
        {
          length: 3,
        },
        (_, index) => {
          const name = `example${index}`;
          const native = {
            operations: Array.from(
              {
                length: mode === "limit" ? 100 : 1,
              },
              (_, operation) => ({
                name: `${name}.read${operation}`,
              }),
            ),
          };
          return {
            name,
            version: "1",
            native,
            packageName: name,
            root: directory,
            targets: {},
          };
        },
      );
      const registrations = plugins.map(({ name, version, native }) => ({
        name,
        version,
        native,
      }));
      const app = resolve(directory, "app.ts");
      await Bun.write(
        app,
        `
        const plugins = ${JSON.stringify(registrations)};
        ${mode === "duplicate" ? "plugins[2] = plugins[0];" : ""}
        ${mode === "mismatch" ? 'plugins[2].native.operations[0].name = "example2.changed";' : ""}
        plugins.push({ name:"setup", version:"1", setup:()=>Bun.write(${JSON.stringify(marker)}, "started") });
        export default { commands:{}, events:{}, plugins };
      `,
      );
      await bundleMacosHost(
        resolve(import.meta.dir, "../../native/macos/bun"),
        directory,
        app,
        undefined,
        false,
        plugins,
      );
      await bundleTestHost(directory, plugins);
      await Bun.write(
        resolve(directory, "webview.ts"),
        `export class MacosWebview {
        observeStartup() {}
        ready = Promise.resolve();
        constructor(config, hooks) { this.hooks = hooks; }
        start() { this.hooks.close(); }
        close() {}
      }`,
      );
      await Bun.write(
        resolve(directory, "run.ts"),
        `
        import { runMacosApp } from "./entry.js";
        try { await runMacosApp(${JSON.stringify(workerConfig(directory))}); }
        catch (error) { console.error(error.message); process.exitCode = 1; }
      `,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(directory, "run.ts"),
        ],
        {
          stdout: "ignore",
          stderr: "pipe",
          timeout: 15_000,
        },
      );
      const errors = new Response(child.stderr).text();
      expect(await child.exited, await errors).toBe(mode === "valid" ? 0 : 1);
      const expectedError = {
        valid: "",
        duplicate: "Invalid or duplicate plugin name.",
        mismatch: "Registered plugin does not match its installed package.",
        limit: "Plugin contract limit reached.",
      }[mode];
      if (mode === "valid") {
        expect(await errors).toBe("");
        expect(registrations.map((plugin) => plugin.native.operations)).toEqual(
          [
            [
              {
                name: "example0.read0",
              },
            ],
            [
              {
                name: "example1.read0",
              },
            ],
            [
              {
                name: "example2.read0",
              },
            ],
          ],
        );
        expect(await Bun.file(marker).text()).toBe("started");
      } else {
        expect(await errors).toContain(expectedError);
        expect(await Bun.file(marker).exists()).toBe(false);
      }
      const records = (
        await Bun.file(resolve(directory, "logs/host.log")).text()
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({
        event: "host-stopped",
        failed: mode !== "valid",
        forced: false,
      });
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  },
  20_000,
);

test("macOS native registration failure acknowledges the backend and exits without forced cleanup", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-reject-"));
  try {
    const app = resolve(directory, "app.ts");
    await Bun.write(app, "export default {commands: {}, events: {}};");
    await bundleMacosHost(
      resolve(import.meta.dir, "../../native/macos/bun"),
      directory,
      app,
    );
    await bundleTestHost(directory);
    await Bun.write(
      resolve(directory, "webview.ts"),
      `export class MacosWebview {
        observeStartup() {}
        ready = Promise.resolve();
        start() {}
        close() {}
      }`,
    );
    // The main thread is the only registry check, so an unregistered grant fails there.
    const config = workerConfig(directory);
    config.policy.backend.permissions = [
      "missing:allow-call",
    ];
    await Bun.write(
      resolve(directory, "run.ts"),
      `import {runMacosApp} from "./entry.js";
      try { await runMacosApp(${JSON.stringify(config)}); }
      catch (error) { console.error(error.message); process.exitCode = 1; }`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(directory, "run.ts"),
      ],
      {
        stdout: "ignore",
        stderr: "pipe",
        timeout: 15000,
      },
    );
    const errors = new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(await errors).toContain(
      "Policy references an unregistered operation.",
    );
    const records = (await Bun.file(resolve(directory, "logs/host.log")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      event: "host-stopped",
      failed: true,
      forced: false,
    });
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}, 15000);

for (const mode of [
  "referenced",
  "unref",
  "blocked",
  "host-killed",
] as const) {
  test.skipIf(process.platform !== "darwin")(
    `macOS ${mode} shutdown removes inherited subprocesses and its guard`,
    async () => {
      const directory = await mkdtemp(
        resolve(tmpdir(), "bunaway-macos-descendants-"),
      );
      const unrelated = Bun.spawn(
        [
          "/bin/sleep",
          "120",
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      let host: ReturnType<typeof Bun.spawn> | undefined;
      const pids: number[] = [];
      try {
        const pidFile = resolve(directory, "child.pid");
        const grandchildFile = resolve(directory, "grandchild.pid");
        const app = resolve(directory, "app.ts");
        await Bun.write(
          app,
          `export default {
          commands: {}, events: {},
          plugins: [{name: "subprocess", version: "1.0.0", async setup() {
            const child = Bun.spawn(["/bin/sh", "-c", 'sleep 120 & printf "%s\\n" "$!" > "$1"; wait', "test-child", ${JSON.stringify(grandchildFile)}], {stdin: "ignore", stdout: "ignore", stderr: "ignore"});
            ${mode === "unref" ? "child.unref();" : ""}
            await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));
            return () => { ${mode === "blocked" ? "while (true) {}" : ""} };
          }}]
        };`,
        );
        await bundleMacosHost(
          resolve(import.meta.dir, "../../native/macos/bun"),
          directory,
          app,
        );
        await bundleTestHost(directory);
        await Bun.write(
          resolve(directory, "webview.ts"),
          `export class MacosWebview {
        observeStartup() {}
          ready = Promise.resolve();
          constructor(config, hooks) { this.hooks = hooks; }
          start() { ${mode === "host-killed" ? "" : "setTimeout(() => this.hooks.close(), 100);"} }
          close() {}
        }`,
        );
        await Bun.write(
          resolve(directory, "run.ts"),
          `import {runMacosApp} from "./entry.js";
          try { await runMacosApp(${JSON.stringify(workerConfig(directory))}); process.exit(0); }
          catch (error) { console.error(error.message); process.exit(1); }`,
        );
        const launched = Bun.spawn(
          [
            process.execPath,
            resolve(directory, "run.ts"),
          ],
          {
            stdout: "ignore",
            stderr: "pipe",
            timeout: 15000,
          },
        );
        host = launched;
        const errors = new Response(launched.stderr).text();
        const deadline = Date.now() + 10000;
        while (
          !(await Bun.file(pidFile).exists()) ||
          !(await Bun.file(grandchildFile).exists())
        ) {
          expect(Date.now()).toBeLessThan(deadline);
          await Bun.sleep(10);
        }
        pids.push(
          Number(await Bun.file(pidFile).text()),
          Number(await Bun.file(grandchildFile).text()),
        );
        const logPath = resolve(directory, "logs/host.log");
        const started = (await Bun.file(logPath).text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .find((record) => record.event === "host-started");
        expect(started.guardPid).toBeGreaterThan(0);
        pids.push(started.guardPid);
        if (mode === "host-killed") {
          host.kill("SIGKILL");
        }
        const exit = await host.exited;
        if (mode === "host-killed") {
          expect(host.signalCode).toBe("SIGKILL");
        } else {
          expect(exit, await errors).toBe(mode === "blocked" ? 1 : 0);
        }
        const cleanupDeadline = Date.now() + 5000;
        while (true) {
          const probe = Bun.spawnSync(
            [
              "/bin/ps",
              "-p",
              pids.join(","),
              "-o",
              "stat=",
            ],
            {
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          expect([
            0,
            1,
          ]).toContain(probe.exitCode);
          const live = probe.stdout
            .toString()
            .trim()
            .split("\n")
            .some((line) => line.trim() && !line.trim().startsWith("Z"));
          if (!live) {
            break;
          }
          expect(Date.now()).toBeLessThan(cleanupDeadline);
          await Bun.sleep(10);
        }
        expect(unrelated.exitCode).toBeNull();
        if (mode !== "host-killed") {
          const records = (await Bun.file(logPath).text())
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(records.at(-1)).toMatchObject({
            event: "host-stopped",
            forced: mode === "blocked",
            activeProcesses: 0,
          });
        }
        await errors;
      } finally {
        if (host?.exitCode === null) {
          host.kill("SIGKILL");
        }
        await host?.exited;
        unrelated.kill("SIGKILL");
        await unrelated.exited;
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
          }
        }
        await rm(directory, {
          recursive: true,
          force: true,
        });
      }
    },
    25000,
  );
}

test("macOS shutdown during native registration acknowledges acceptance and skips core setup", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-register-"));
  let worker: Worker | undefined;
  let channel: Channel | undefined;
  try {
    const app = resolve(directory, "app.ts");
    const marker = resolve(directory, "setup.txt");
    await Bun.write(
      app,
      `export default {commands: {}, events: {}, plugins: [
        ...Array.from({length:2}, (_,index)=>({name:"native"+index,version:"1",native:{operations:[]}})),
        {name:"setup",version:"1.0.0",setup:()=>Bun.write(${JSON.stringify(marker)},"started")} ]};`,
    );
    await bundleMacosHost(
      resolve(import.meta.dir, "../../native/macos/bun"),
      directory,
      app,
    );
    const errors: unknown[] = [];
    let cleaned = false;
    let registrations = 0;
    // Hold registration's ack until shutdown has been accepted by the backend.
    const config = workerConfig(directory);
    const running = new Worker(
      new URL(`file://${resolve(directory, "backend.js")}`),
      {
        workerData: config,
      },
    );
    worker = running;
    const stopped = new Promise<number>((done) => running.once("exit", done));
    running.on("error", (error) => errors.push(error));
    channel = new Channel(
      running,
      config.runtime,
      "macos-main",
      async (packet) => {
        if (packet.kind === "native-register") {
          registrations++;
          expect(packet.complete).toBe(false);
          expect(packet.plugins).toHaveLength(1);
          await channel?.send({
            kind: "shutdown",
          });
        } else if (packet.kind === "cleaned") {
          cleaned = true;
        } else {
          errors.push(packet);
        }
      },
      (error) => errors.push(error),
    );
    expect(await stopped).toBe(0);
    expect(registrations).toBe(1);
    expect(cleaned).toBe(true);
    expect(errors).toEqual([]);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    channel?.close();
    await worker?.terminate();
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}, 15000);

test("macOS shutdown cancels setup Host calls before waiting for plugin cleanup", async () => {
  const directory = await mkdtemp(
    resolve(tmpdir(), "bunaway-macos-setup-call-"),
  );
  let worker: Worker | undefined;
  let channel: Channel | undefined;
  try {
    const app = resolve(directory, "app.ts");
    const marker = resolve(directory, "stopped.txt");
    const cancelled = resolve(directory, "cancelled.txt");
    const plugin = Bun.resolveSync("@bunaway/plugin-windows", import.meta.dir);
    await Bun.write(
      app,
      `import {windowsPlugin} from ${JSON.stringify(plugin)};
      export default {commands: {}, events: {}, plugins: [windowsPlugin,
        {name:"cleanup",version:"1.0.0",setup(){return () => Bun.write(${JSON.stringify(marker)},"stopped").then(() => {});}},
        {name:"close",version:"1.0.0",async setup(context){
          const operation = windowsPlugin.native.operations.find(operation => operation.name === "windows.close");
          try { await context.host.call(operation, {view:"main"}); }
          catch (error) { await Bun.write(${JSON.stringify(cancelled)}, error.code); throw error; }
        }}
      ]};`,
    );
    await bundleMacosHost(
      resolve(import.meta.dir, "../../native/macos/bun"),
      directory,
      app,
    );
    const config = workerConfig(directory);
    config.policy.backend.permissions = [
      ...windowPermissions(),
    ];
    const running = new Worker(
      new URL(`file://${resolve(directory, "backend.js")}`),
      {
        workerData: config,
      },
    );
    worker = running;
    const stopped = new Promise<number>((done) => running.once("exit", done));
    const errors: unknown[] = [];
    const packets: Packet[] = [];
    running.on("error", (error) => errors.push(error));
    channel = new Channel(
      running,
      config.runtime,
      "macos-main",
      async (packet) => {
        packets.push(packet);
        if (packet.kind === "operation") {
          // Closing the last window starts shutdown and suppresses its Host response.
          await channel?.send({
            kind: "shutdown",
          });
        }
      },
      (error) => errors.push(error),
    );
    expect(
      await Promise.race([
        stopped,
        Bun.sleep(2000).then(() => "timeout"),
      ]),
    ).toBe(0);
    expect(await Bun.file(cancelled).text()).toBe("CANCELLED");
    expect(await Bun.file(marker).text()).toBe("stopped");
    expect(packets.map((packet) => packet.kind)).toContain("cleaned");
    expect(
      packets.some(
        (packet) => packet.kind === "ready" || packet.kind === "fatal",
      ),
    ).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    channel?.close();
    await worker?.terminate();
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}, 15000);

test.each([
  {
    execution: "ui",
    phase: "input",
  },
  {
    execution: "ui",
    phase: "output",
  },
  {
    execution: "ui",
    phase: "execution",
  },
  {
    execution: "io",
    phase: "input",
  },
  {
    execution: "io",
    phase: "output",
  },
] as const)(
  "macOS cancelled $execution $phase releases request and channel capacity before settlement",
  async ({ execution, phase }) => {
    const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-cancel-"));
    try {
      const marker = resolve(directory, "started.txt");
      const done = resolve(directory, "done.txt");
      const operations = resolve(directory, "operations.ts");
      await Bun.write(
        operations,
        `
        import { writeFileSync } from "node:fs";
        import { defineNativePlugin } from ${JSON.stringify(resolve(import.meta.dir, "../../packages/plugin-sdk/src/index.ts"))};
        import { z } from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
        const gates = [];
        const pause = async value => {
          writeFileSync(${JSON.stringify(marker)}, value);
          if (value.startsWith("never")) await new Promise(() => {});
          if (value.startsWith("late")) {
            await new Promise(resolve => gates.push(resolve));
            if (value === "late-error") throw new Error("late parser failure");
          }
          return value;
        };
        const phase = ${JSON.stringify(phase)};
        const plugin = defineNativePlugin({ name:"parser", operations:{run:{
          input: phase === "input" ? z.string().transform(pause) : z.string(),
          output: phase === "output" ? z.string().transform(pause) : z.string(),
        }}, platforms:{macos:{execution:${JSON.stringify(execution)},create:()=>({
          execute(_name,input) {
            if(input === "release") for(const release of gates.splice(0)) release();
            return input;
          },
          async executeUI(_name,input,_source,context) {
            if(!context.signal || !context.permissions.permissions.includes("parser.run")) throw new Error("Missing execution context");
            if (phase === "execution") context.signal.addEventListener("abort",()=>writeFileSync(${JSON.stringify(resolve(directory, "aborted.txt"))},input),{once:true});
            if(input === "release") for(const release of gates.splice(0)) release();
            return phase === "execution" ? pause(input) : input;
          }, dispose(){},
        })}}});
        export default plugin.definition;
      `,
      );
      const native = {
        operations: [
          {
            name: "parser.run",
          },
        ],
      };
      const plugins: InstalledPlugin[] = [
        {
          name: "parser",
          version: "1",
          packageName: "parser",
          root: directory,
          native,
          targets: {
            macos: {
              execution,
              operations,
            },
          },
        },
      ];
      await writePluginManifest(directory, plugins, "macos");
      await bundleTestHost(directory, plugins);
      await Bun.write(
        resolve(directory, "webview.ts"),
        "export class MacosWebview {}",
      );
      await Bun.write(
        resolve(directory, "backend.js"),
        `
        import assert from "node:assert/strict";
        import { readFileSync, writeFileSync } from "node:fs";
        import { parentPort, workerData } from "node:worker_threads";
        import { API_LIMITS } from ${JSON.stringify(resolve(import.meta.dir, "../../packages/protocol/src/index.ts"))};
        import { Channel } from ${JSON.stringify(resolve(import.meta.dir, "../../packages/runtime-bun/src/worker-channel.ts"))};
        const responses = new Map();
        const channel = new Channel(parentPort, workerData.runtime, "macos-backend", packet => {
          if(packet.kind === "host-response") responses.set(packet.requestId,packet.response);
          else if(packet.kind === "shutdown") void (async()=> {
            await channel.send({kind:"cleaned"});
            await channel.drain(); channel.close(); parentPort.close();
          })().catch(error=>{console.error(error);process.exit(1)});
        }, error=>{console.error(error);process.exit(1)});
        const waitFor = async predicate => {
          const deadline=Date.now()+5000;
          while(!predicate()) { assert(Date.now()<deadline,"fixture timed out"); await Bun.sleep(1); }
        };
        const context = workerData.backendContext;
        const call = async payload => {
          await channel.send({kind:"operation",context,source:"backend",requestId:payload,call:{operation:"parser.run",payload}});
          await waitFor(()=> {try{return readFileSync(${JSON.stringify(marker)},"utf8") === payload;}catch{return false;}});
        };
        await channel.send({kind:"native-register",plugins:[{name:"parser",version:"1",native:${JSON.stringify(native)}}],complete:true});
        await channel.send({kind:"ready"});
        for(let index=0;index<API_LIMITS.maxPending;index++) {
          const requestId="never-"+index;
          await call(requestId);
          await channel.send({kind:"cancel",context,requestId});
          ${phase === "execution" ? `await waitFor(()=>{try{return readFileSync(${JSON.stringify(resolve(directory, "aborted.txt"))},"utf8")===requestId;}catch{return false;}});` : ""}
        }
        assert(channel.canSend(API_LIMITS.maxPending));
        for(const requestId of ["late-success","late-error"]) {
          await call(requestId);
          await channel.send({kind:"cancel",context,requestId});
        }
        await call("release");
        await waitFor(()=>responses.has("release"));
        await call("healthy");
        await waitFor(()=>responses.has("healthy"));
        assert.deepEqual(responses.get("healthy"),{kind:"result",payload:"healthy"});
        assert.deepEqual([...responses.keys()],["release","healthy"]);
        await channel.drain();
        assert(channel.canSend(API_LIMITS.maxPending));
        await call("never-shutdown");
        writeFileSync(${JSON.stringify(done)},"passed");
      `,
      );
      const config = workerConfig(directory);
      config.windows = [];
      config.policy.backend.permissions = [
        "parser.run",
      ];
      await Bun.write(
        resolve(directory, "run.ts"),
        `
        import { existsSync } from "node:fs";
        import { runMacosApp } from "./entry.js";
        const timer=setInterval(()=> {if(existsSync(${JSON.stringify(done)})) process.emit("SIGTERM","SIGTERM");},10);
        try {await runMacosApp(${JSON.stringify(config)});}
        catch(error){console.error(error);process.exitCode=1;}
        finally {clearInterval(timer);}
      `,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(directory, "run.ts"),
        ],
        {
          stdout: "ignore",
          stderr: "pipe",
          timeout: 20000,
        },
      );
      const errors = new Response(child.stderr).text();
      expect(await child.exited, await errors).toBe(0);
      expect(await Bun.file(done).text()).toBe("passed");
      const records = (
        await Bun.file(resolve(directory, "logs/host.log")).text()
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({
        event: "host-stopped",
        failed: false,
        forced: false,
      });
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  },
  25000,
);

test.each([
  "initialization",
  "cleanup",
] as const)(
  "macOS I/O %s failure remains owned by host shutdown",
  async (phase) => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "bunaway-macos-io-failure-"),
    );
    try {
      const operations = resolve(directory, "operations.ts");
      const native = {
        operations: [
          {
            name: "failure.run",
          },
        ],
      };
      const plugins: InstalledPlugin[] = [
        {
          name: "failure",
          version: "1",
          native,
          packageName: "fixture-failure",
          root: directory,
          targets: {
            macos: {
              execution: "io",
              operations,
            },
          },
        },
      ];
      const cleaned = resolve(directory, "core-cleaned");
      const disposing = resolve(directory, "io-disposing");
      await Bun.write(
        operations,
        `
        import { isMainThread } from "node:worker_threads";
        import { existsSync, writeFileSync } from "node:fs";
        export default {nativePlatforms:{macos:{create() {
          if (isMainThread) throw new Error("Wrong adapter owner");
          ${phase === "initialization" ? 'throw new Error("Fixture I/O initialization failed");' : ""}
          return {execute(){return null}, dispose(){
            if (!existsSync(${JSON.stringify(cleaned)})) throw new Error("Core cleanup order failed");
            writeFileSync(${JSON.stringify(disposing)}, "started");
            while(true) {}
          }};
        }}}};
      `,
      );
      const app = resolve(directory, "app.ts");
      await Bun.write(
        app,
        `export default {commands:{},events:{},plugins:[
        {name:"failure",version:"1",native:${JSON.stringify(native)}},
        {name:"setup",version:"1",setup(){return ()=>Bun.write(${JSON.stringify(cleaned)},"done");}}
      ]};`,
      );
      await bundleMacosHost(
        resolve(import.meta.dir, "../../native/macos/bun"),
        directory,
        app,
        undefined,
        false,
        plugins,
      );
      await bundleTestHost(directory, plugins);
      await Bun.write(
        resolve(directory, "webview.ts"),
        `export class MacosWebview {
        observeStartup() {}
        ready = Promise.resolve();
        constructor(config,hooks){this.hooks=hooks;}
        start(){this.hooks.close();}
        close(){}
      }`,
      );
      await Bun.write(
        resolve(directory, "run.ts"),
        `import {runMacosApp} from "./entry.js";
        try{await runMacosApp(${JSON.stringify(workerConfig(directory))});}
        catch(error){console.error(error);process.exitCode=1;}
      `,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(directory, "run.ts"),
        ],
        {
          stdout: "ignore",
          stderr: "pipe",
          timeout: 15_000,
        },
      );
      const errors = new Response(child.stderr).text();
      expect(await child.exited, await errors).toBe(1);
      expect(await Bun.file(cleaned).exists()).toBe(phase === "cleanup");
      expect(await Bun.file(disposing).exists()).toBe(phase === "cleanup");
      const records = (
        await Bun.file(resolve(directory, "logs/host.log")).text()
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({
        event: "host-stopped",
        failed: true,
        forced: phase === "cleanup",
      });
      if (phase === "initialization") {
        expect(await errors).toContain("Fixture I/O initialization failed");
      }
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  },
  20_000,
);

test("macOS shutdown aborts active backend I/O before Core stop hooks and adapter disposal", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-io-stop-"));
  try {
    const started = resolve(directory, "io-started");
    const aborted = resolve(directory, "io-aborted");
    const cleaned = resolve(directory, "core-cleaned");
    const disposed = resolve(directory, "io-disposed");
    const operations = resolve(directory, "operations.ts");
    const native = {
      operations: [
        {
          name: "waiting.run",
        },
      ],
    };
    const plugins: InstalledPlugin[] = [
      {
        name: "waiting",
        version: "1",
        native,
        packageName: "fixture-waiting",
        root: directory,
        targets: {
          macos: {
            execution: "io",
            operations,
          },
        },
      },
    ];
    await Bun.write(
      operations,
      `
      import { existsSync, writeFileSync } from "node:fs";
      import { defineNativePlugin } from ${JSON.stringify(resolve(import.meta.dir, "../../packages/plugin-sdk/src/index.ts"))};
      import { z } from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
      export const plugin = defineNativePlugin({name:"waiting",operations:{run:{input:z.null(),output:z.null()}},platforms:{macos:{execution:"io",create(){
        return {
          execute(){throw new Error("Missing execution context");},
          executeUI(_operation,_input,source,context){
            if(source!=="backend") throw new Error("Wrong backend source");
            context.signal.throwIfAborted();
            writeFileSync(${JSON.stringify(started)},"started");
            return new Promise(resolve=>context.signal.addEventListener("abort",()=>{
              if(existsSync(${JSON.stringify(disposed)})) throw new Error("Adapter disposed before cancellation");
              writeFileSync(${JSON.stringify(aborted)},"aborted"); resolve(null);
            },{once:true}));
          },
          dispose(){
            if(!existsSync(${JSON.stringify(cleaned)})) throw new Error("Adapter disposed before Core hooks");
            writeFileSync(${JSON.stringify(disposed)},"disposed");
          }
        };
      }}}});
      export default {...plugin.definition,version:"1"};
    `,
    );
    const app = resolve(directory, "app.ts");
    await Bun.write(
      app,
      `
      import { existsSync, writeFileSync } from "node:fs";
      import { defineApp } from ${JSON.stringify(Bun.resolveSync("@bunaway/backend", import.meta.dir))};
      import definition,{plugin} from ${JSON.stringify(operations)};
      export default defineApp({modules:[],commands:{},events:{},plugins:[definition,{name:"setup",version:"1",async setup(){
        const pending=plugin.api.run(null).catch(error=>{if(error.code!=="CANCELLED") throw error;});
        while(!existsSync(${JSON.stringify(started)})) await Bun.sleep(5);
        return async()=>{
          await pending;
          while(!existsSync(${JSON.stringify(aborted)})) await Bun.sleep(5);
          if(existsSync(${JSON.stringify(disposed)})) throw new Error("Stop hook ran after adapter disposal");
          writeFileSync(${JSON.stringify(cleaned)},"cleaned");
        };
      }}]});
    `,
    );
    await bundleMacosHost(
      resolve(import.meta.dir, "../../native/macos/bun"),
      directory,
      app,
      undefined,
      false,
      plugins,
    );
    await bundleTestHost(directory, plugins);
    await Bun.write(
      resolve(directory, "webview.ts"),
      `export class MacosWebview {
        observeStartup() {}
      ready=Promise.resolve(); constructor(config,hooks){this.hooks=hooks;}
      start(){this.hooks.close();} close(){}
    }`,
    );
    const config = workerConfig(directory);
    config.policy.backend.permissions = [
      "waiting.run",
    ];
    await Bun.write(
      resolve(directory, "run.ts"),
      `import {runMacosApp} from "./entry.js";
      try{await runMacosApp(${JSON.stringify(config)});}catch(error){console.error(error);process.exitCode=1;}
    `,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(directory, "run.ts"),
      ],
      {
        stdout: "ignore",
        stderr: "pipe",
        timeout: 15_000,
      },
    );
    const errors = new Response(child.stderr).text();
    expect(await child.exited, await errors).toBe(0);
    expect(await Bun.file(aborted).text()).toBe("aborted");
    expect(await Bun.file(cleaned).text()).toBe("cleaned");
    expect(await Bun.file(disposed).text()).toBe("disposed");
    const records = (await Bun.file(resolve(directory, "logs/host.log")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      event: "host-stopped",
      failed: false,
      forced: false,
    });
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}, 20_000);

test("macOS I/O receives only the trusted host app identity and rejects a caller appId", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-identity-"));
  const report = resolve(directory, "identity.json");
  const native = {
    operations: [
      {
        name: "identity.inspect",
      },
    ],
  };
  const modulePath = resolve(directory, "identity.ts");
  const plugins: InstalledPlugin[] = [
    {
      name: "identity",
      version: "1",
      native,
      packageName: "fixture-identity",
      root: directory,
      targets: {
        macos: {
          execution: "io",
          operations: modulePath,
        },
      },
    },
  ];
  try {
    await Bun.write(
      modulePath,
      `
      import { defineNativePlugin } from ${JSON.stringify(resolve(import.meta.dir, "../../packages/plugin-sdk/src/index.ts"))};
      import { z } from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
      const plugin = defineNativePlugin({name:"identity",operations:{inspect:{input:z.null(),output:z.unknown()}},
        platforms:{macos:{execution:"io",create(environment){return {
          execute(){return environment.app ?? null;},dispose(){}
        };}}}});
      export default {...plugin.definition,version:"1"};
    `,
    );
    await writePluginManifest(directory, plugins, "macos");
    await bundleTestHost(directory, plugins);
    await Bun.write(
      resolve(directory, "webview.ts"),
      "export class MacosWebview {}",
    );
    await Bun.write(
      resolve(directory, "backend.js"),
      `
      import assert from "node:assert/strict";
      import { writeFileSync } from "node:fs";
      import { parentPort, workerData } from "node:worker_threads";
      import { Channel } from ${JSON.stringify(resolve(import.meta.dir, "../../packages/runtime-bun/src/worker-channel.ts"))};
      const responses = new Map();
      const channel = new Channel(parentPort,workerData.runtime,"macos-backend",packet=>{
        if(packet.kind==="host-response") responses.set(packet.requestId,packet.response);
        if(packet.kind==="shutdown") void(async()=>{
          await channel.send({kind:"cleaned"}); await channel.drain(); channel.close(); parentPort.close();
        })().catch(error=>{console.error(error);process.exit(1)});
      },error=>{console.error(error);process.exit(1)});
      await channel.send({kind:"native-register",plugins:[{name:"identity",version:"1",native:${JSON.stringify(native)}}],complete:true});
      await channel.send({kind:"ready"});
      const context=workerData.backendContext;
      for(const [requestId,payload] of [["forged",{appId:"caller-selected"}],["trusted",null]]) {
        await channel.send({kind:"operation",context,source:"backend",requestId,call:{operation:"identity.inspect",payload}});
        const deadline=Date.now()+5000;
        while(!responses.has(requestId)){assert(Date.now()<deadline,"Identity request timed out");await Bun.sleep(1);}
      }
      assert.equal(responses.get("forged").error.code,"INVALID_ARGUMENT");
      writeFileSync(${JSON.stringify(report)},JSON.stringify(responses.get("trusted")));
    `,
    );
    const config = workerConfig(directory);
    config.windows = [];
    config.app = {
      id: "tests.trusted.host",
      launch: {
        mode: "development",
        executablePath: process.execPath,
        args: [
          "host-owned.js",
        ],
      },
    };
    config.policy.backend.permissions = [
      "identity.inspect",
    ];
    await Bun.write(
      resolve(directory, "run.ts"),
      `
      import { existsSync } from "node:fs";
      import { runMacosApp } from "./entry.js";
      const timer=setInterval(()=>{if(existsSync(${JSON.stringify(report)})) process.emit("SIGTERM","SIGTERM");},5);
      try{await runMacosApp(${JSON.stringify(config)});}catch(error){console.error(error);process.exitCode=1;}
      finally{clearInterval(timer);}
    `,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(directory, "run.ts"),
      ],
      {
        stdout: "ignore",
        stderr: "pipe",
        timeout: 15000,
      },
    );
    const errors = new Response(child.stderr).text();
    expect(await child.exited, await errors).toBe(0);
    expect(await Bun.file(report).json()).toEqual({
      kind: "result",
      payload: config.app,
    });
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}, 20000);

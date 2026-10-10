import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  type HostContext,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from "@bunaway/protocol";
import {
  Channel,
  type Packet,
  validatePacket,
} from "@bunaway/runtime-bun/worker-channel";
import { appModules } from "#cli/app-modules";
import { bundleMacosHost } from "#cli/assets";
import type { InstalledPlugin } from "#cli/plugins";
import {
  type MacosConfig,
  readMacosWindowSpecs,
} from "#native/macos/bun/config";
import {
  macosOrigin,
  platformUrl,
  resourceRules,
} from "#native/macos/bun/urls";

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
    permissions: [],
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
          const output = {
            const: "",
          };
          const native = {
            operations: Array.from(
              {
                length: mode === "limit" ? 100 : 1,
              },
              (_, operation) => ({
                name: `${name}.read${operation}`,
                permission: `${name}:read`,
                input: {
                  const: null,
                },
                output,
              }),
            ),
            permissions: [
              {
                name: `${name}:read`,
              },
            ],
          };
          if (mode !== "limit") {
            output.const = "x".repeat(
              index === 0
                ? MAX_MESSAGE_BYTES - Buffer.byteLength(JSON.stringify(native))
                : 400_000,
            );
          }
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
        ${mode === "mismatch" ? 'plugins[2].native.operations[0].output.const = "changed";' : ""}
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
        expect(Buffer.byteLength(JSON.stringify(plugins[0]?.native))).toBe(
          MAX_MESSAGE_BYTES,
        );
        expect(
          Buffer.byteLength(JSON.stringify(registrations)),
        ).toBeGreaterThan(MAX_MESSAGE_BYTES + 1024);
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
      "Policy references an unregistered permission.",
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
        ...Array.from({length:2}, (_,index)=>({name:"native"+index,version:"1",native:{operations:[],permissions:[]}})),
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
      {
        identifier: "windows:control",
        allow: [
          {
            view: "main",
          },
        ],
      },
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

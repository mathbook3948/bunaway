import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { type HostContext, PROTOCOL_VERSION } from "@bunaway/protocol";
import { Channel, type Packet } from "@bunaway/runtime-bun/worker-channel";
import { bundleMacosHost } from "#cli/assets";
import type { MacosConfig } from "#native/macos/bun/config";
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
    window: {
      view: "main",
      home: "https://app.bunaway.local/",
      title: "Test",
      window: {
        width: 800,
        height: 600,
      },
    },
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
async function bundleTestHost(directory: string): Promise<void> {
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

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { MacosConfig } from "#native/macos/bun/config";
import { bundleMacosHost } from "#cli/assets";
import {
  macosOrigin,
  platformUrl,
  resourceRules,
} from "#native/macos/bun/urls";
import { Channel, type Packet } from "@bunaway/runtime-bun/worker-channel";
import { type HostContext, PROTOCOL_VERSION } from "@bunaway/protocol";

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
] as const)(
  "macOS UI startup failure waits for %s backend cleanup without UI ticks",
  async (cleanup) => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "bunaway-macos-startup-"),
    );
    try {
      const started = resolve(directory, "started.txt");
      const stopped = resolve(directory, "stopped.txt");
      const app = resolve(directory, "app.ts");
      await Bun.write(
        app,
        `export default {
        commands: {}, events: {},
        plugins: [{name:"cleanup", version:"1.0.0", async setup() {
          await Bun.write(${JSON.stringify(started)}, "started");
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
      await Bun.write(
        resolve(directory, "webview.ts"),
        `export class MacosWebview {
        ready = (async () => {
          const deadline = Date.now() + 5000;
          while (!await Bun.file(${JSON.stringify(started)}).exists()) {
            if (Date.now() >= deadline) throw new Error("Backend setup timed out");
            await Bun.sleep(5);
          }
          throw new Error("UI setup failed");
        })();
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
      expect(await child.exited, await errors).toBe(1);
      if (cleanup === "blocked") {
        expect(performance.now() - startedAt).toBeGreaterThanOrEqual(5000);
      }
      await output;
      expect(await errors).toContain("UI setup failed");
      expect(await Bun.file(stopped).exists()).toBe(cleanup === "cooperative");
      const records = (
        await Bun.file(resolve(directory, "logs/host.log")).text()
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({
        event: "host-stopped",
        failed: true,
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

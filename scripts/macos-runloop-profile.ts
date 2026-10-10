// A reproducible idle profile for the cooperative AppKit/Bun event loop.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { MacosWebview } from "#native/macos/bun/webview";
import type { HostContext } from "@bunaway/protocol";

const directory = await mkdtemp(resolve(tmpdir(), "bunaway-runloop-"));
const intervals: number[] = [];
let previous = performance.now();
let failure: unknown;
let view: MacosWebview | undefined;
try {
  await mkdir(resolve(directory, "web"));
  await Bun.write(
    resolve(directory, "web/index.html"),
    "<!doctype html><title>Bun FFI idle profile</title><p>Idle WKWebView</p>",
  );
  view = new MacosWebview(
    {
      runtime: {
        id: "profile",
        generation: crypto.randomUUID(),
      },
      backendContext: "backend-profile" as HostContext,
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
            commands: [],
            events: [],
            host: {
              permissions: [],
            },
          },
        ],
      },
      window: {
        view: "main",
        home: "https://app.bunaway.local/index.html",
        title: "Bun FFI profile",
        window: {
          width: 800,
          height: 600,
        },
      },
      assets: directory,
      dataRoot: directory,
    },
    {
      receive() {},
      revoke() {},
      close() {
        failure = new Error("Profile window closed.");
      },
      log() {},
      fail(error) {
        failure = error;
      },
      tick() {
        const now = performance.now();
        intervals.push(now - previous);
        previous = now;
      },
    },
  );
  await view.ready;
  view.start();
  await Bun.sleep(500);
  intervals.length = 0;
  previous = performance.now();
  const started = previous;
  const cpu = process.cpuUsage();
  await Bun.sleep(3000);
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  if (failure) {
    throw failure;
  }
  intervals.sort((a, b) => a - b);
  const result = {
    bun: Bun.version,
    platform: process.platform,
    architecture: process.arch,
    workload: "one 800x600 idle WKWebView, 500ms warmup, 3000ms sampling",
    elapsedMs,
    samples: intervals.length,
    intervalP50Ms: intervals[Math.floor(intervals.length * 0.5)],
    intervalP95Ms: intervals[Math.floor(intervals.length * 0.95)],
    intervalMaxMs: intervals.at(-1),
    processCpuMs: (used.user + used.system) / 1000,
  };
  await Bun.write(
    resolve(import.meta.dir, "../build/macos-runloop-profile.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(result);
} finally {
  view?.close();
  await rm(directory, {
    recursive: true,
    force: true,
  });
}
process.exit(0);

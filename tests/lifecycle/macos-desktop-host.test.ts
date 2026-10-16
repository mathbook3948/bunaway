import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { type HostContext, PROTOCOL_VERSION } from "@bunaway/protocol";
import {
  Channel,
  type Packet,
  type Route,
} from "@bunaway/runtime-bun/worker-channel";
import { appModules } from "#cli/app-modules";
import { bundleMacosHost } from "#cli/assets";
import type { MacosConfig } from "#native/macos/bun/config";

/**
 * The real main-thread host (entry.ts) and backend Worker run against a fake AppKit layer, so the
 * order of the app's lifecycle hooks is checked on every platform. The fake exposes the hooks that
 * AppKit would call (`quitRequested`, `sessionEnding`, `reopened`, `openUrlsRequested`, a window close) to the driver.
 * Real AppKit behavior is covered by tests/lifecycle/macos-desktop.ts on macOS.
 */

type Scenario = {
  /** Source of the `desktop` options object; may use `log` and `vetoes`. */
  desktop: string;
  /** Number of beforeQuit calls that veto before one is approved. */
  vetoes?: number;
  /** Driver body, run once the initial `onOpen` was logged (or at once with `holdSetup`). */
  drive: string;
  /**
   * Holds the backend in a plugin setup, so it is not `ready` yet, until the driver calls
   * `releaseSetup()`. The driver then starts as soon as the setup is held.
   */
  holdSetup?: boolean;
  /**
   * Driver code run synchronously while the fake application is constructed, which is before its
   * first tick and before the backend's `desktop-config` can arrive. It receives the application
   * hooks as `application`, the earliest point a cold-launch open request can be delivered.
   */
  atLaunch?: string;
  /** Expected process exit code. */
  exitCode?: number;
};

const OPEN_LINE = "onOpen:initial:0:string";

function workerConfig(directory: string, events: string[] = []): MacosConfig {
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
          commands: [],
          events,
          host: {
            permissions: [],
          },
        },
      ],
    },
  };
}

/** Bundles the real host with a fake application and WebView, and returns the recorded hook events. */
async function runScenario(scenario: Scenario) {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-desktop-"));
  try {
    const events = resolve(directory, "events.log");
    const app = resolve(directory, "app.ts");
    const setupGate = resolve(directory, "setup-gate");
    await Bun.write(
      app,
      `import { appendFileSync, existsSync } from "node:fs";
      const log = (line) => appendFileSync(${JSON.stringify(events)}, line + "\\n");
      let vetoes = ${scenario.vetoes ?? 0};
      export default {
        commands: {}, events: {},
        plugins: [{name: "cleanup", version: "1.0.0", async setup() {
          if (${scenario.holdSetup === true}) {
            log("setupHeld");
            while (!existsSync(${JSON.stringify(setupGate)})) await Bun.sleep(5);
          }
          return () => log("stopHook");
        }}],
        desktop: ${scenario.desktop},
      };`,
    );
    await bundleMacosHost(
      resolve(import.meta.dir, "../../native/macos/bun"),
      directory,
      app,
    );
    const build = await Bun.build({
      entrypoints: [
        resolve(import.meta.dir, "../../native/macos/bun/entry.ts"),
        resolve(import.meta.dir, "../../native/macos/bun/host-operations.ts"),
      ],
      target: "bun",
      outdir: directory,
      plugins: [
        {
          name: "fake-appkit",
          setup(build) {
            appModules({
              platform: "macos",
              plugins: [],
            }).setup(build);
            if (process.platform !== "darwin") {
              build.onResolve(
                {
                  filter: /^\.\/process-group\.ts$/,
                },
                () => ({
                  path: "fake-process-group",
                  namespace: "fake",
                }),
              );
              build.onLoad(
                {
                  filter: /^fake-process-group$/,
                  namespace: "fake",
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
                path: "fake-application",
                namespace: "fake",
              }),
            );
            build.onLoad(
              {
                filter: /^fake-application$/,
                namespace: "fake",
              },
              () => ({
                // The pump is replaced by a timer so deferred window cleanup still runs.
                contents: `export class MacosApplication {
                  constructor(hooks) {
                    globalThis.application = hooks;
                    // Synchronous on purpose: the constructor runs before the first tick is scheduled.
                    globalThis.onApplicationCreated?.(hooks);
                    this.timer = setInterval(() => hooks.tick(), 5);
                  }
                  activate() {}
                  appCleanedUp() {}
                  close() { clearInterval(this.timer); }
                }`,
                loader: "js",
              }),
            );
            build.onResolve(
              {
                filter: /^\.\/webview\.ts$/,
              },
              () => ({
                path: resolve(directory, "webview.ts"),
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
        constructor(config, hooks) {
          (globalThis.webviews ??= []).push(hooks);
          this.ready = Promise.resolve();
        }
        source() { return "https://app.bunaway.local/"; }
        deliver() {}
        present() { globalThis.presented = (globalThis.presented ?? 0) + 1; }
        start() {}
        observeStartup() {}
        close() {}
        isFocused() { return false; }
      }`,
    );
    await Bun.write(
      resolve(directory, "run.ts"),
      `import { appendFileSync, existsSync, readFileSync } from "node:fs";
      import { runMacosApp } from "./entry.js";
      const events = () => existsSync(${JSON.stringify(events)})
        ? readFileSync(${JSON.stringify(events)}, "utf8").trim().split("\\n") : [];
      const until = async (line) => {
        const deadline = Date.now() + 8000;
        while (!events().includes(line)) {
          if (Date.now() > deadline) throw new Error("Timed out waiting for " + line);
          await Bun.sleep(5);
        }
      };
      const note = (line) => appendFileSync(${JSON.stringify(events)}, line + "\\n");
      const releaseSetup = () => Bun.write(${JSON.stringify(setupGate)}, "");
      globalThis.onApplicationCreated = (application) => {
        ${scenario.atLaunch ?? ""}
      };
      (async () => {
        await until(${JSON.stringify(scenario.holdSetup ? "setupHeld" : OPEN_LINE)});
        ${scenario.drive}
      })().catch((error) => { console.error(error); process.exit(3); });
      try { await runMacosApp(${JSON.stringify(workerConfig(directory))}); }
      catch (error) { console.error(error.message); process.exitCode = 1; }`,
    );
    const startedAt = Date.now();
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(directory, "run.ts"),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20000,
      },
    );
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, `${output}\n${errors}`).toBe(scenario.exitCode ?? 0);
    const log = (await Bun.file(events).exists())
      ? (await Bun.file(events).text()).trim().split("\n")
      : [];
    return {
      log,
      errors,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}

/** The hooks every scenario records, so each test lists only what is specific to it. */
const RECORD_ALL = `{
  onReady() { log("onReady"); },
  onOpen(request) { log("onOpen:" + request.source + ":" + request.argv.length + ":" + typeof request.cwd); },
  beforeQuit(reason) { log("beforeQuit:" + reason); if (vetoes-- > 0) return false; },
  onWillQuit(reason) { log("onWillQuit:" + reason); },
  onQuit(reason) { log("onQuit:" + reason); },
  onAllWindowsClosed() { log("onAllWindowsClosed"); },
  CLOSE_BEHAVIOR
}`;
const withClose = (closeBehavior?: string) =>
  RECORD_ALL.replace(
    "CLOSE_BEHAVIOR",
    closeBehavior ? `closeBehavior: "${closeBehavior}"` : "",
  );

test("macOS Quit command: a veto keeps the app, the approved quit runs hooks around Core stop", async () => {
  const { log } = await runScenario({
    desktop: withClose(),
    vetoes: 1,
    drive: `
      application.quitRequested();
      await until("beforeQuit:quit-command");
      await Bun.sleep(100);
      application.quitRequested();`,
  });
  expect(log).toEqual([
    "onReady",
    OPEN_LINE,
    "beforeQuit:quit-command",
    "beforeQuit:quit-command",
    // The app is told before Core stops, and onQuit follows native teardown.
    "onWillQuit:quit-command",
    "stopHook",
    "onQuit:quit-command",
  ]);
});

test("macOS last window with the default close behavior asks beforeQuit and then shuts down", async () => {
  const { log } = await runScenario({
    desktop: withClose(),
    drive: "webviews[0].close();",
  });
  expect(log).toEqual([
    "onReady",
    OPEN_LINE,
    "beforeQuit:last-window",
    "onWillQuit:last-window",
    "stopHook",
    "onQuit:last-window",
  ]);
});

test("macOS keep-alive reports an empty app once, reopens the first window and quits on the Quit command", async () => {
  const { log } = await runScenario({
    desktop: withClose("keep-alive"),
    drive: `
      webviews[0].close();
      await until("onAllWindowsClosed");
      await Bun.sleep(200);
      application.reopened(false);
      while (webviews.length < 2) await Bun.sleep(5);
      application.quitRequested();`,
  });
  expect(log).toEqual([
    "onReady",
    OPEN_LINE,
    // Closing the last window neither asks beforeQuit nor reports twice.
    "onAllWindowsClosed",
    "beforeQuit:quit-command",
    "onWillQuit:quit-command",
    "stopHook",
    "onQuit:quit-command",
  ]);
});

const OPEN_URLS_DESKTOP = `{
  onReady() { log("onReady"); },
  onOpen(request) { log("onOpen:" + request.source + ":" + request.argv.length + ":" + typeof request.cwd); },
  onOpenUrls(urls) { log("onOpenUrls:" + urls.join("|")); },
  onReopen(event) { log("onReopen:" + event.hasVisibleWindows); },
  onAllWindowsClosed() { log("onAllWindowsClosed"); },
  closeBehavior: "keep-alive",
}`;

test("macOS open requests reach onOpenUrls normalized, in order, after onReady and the initial onOpen", async () => {
  const { log } = await runScenario({
    desktop: OPEN_URLS_DESKTOP,
    drive: `
      application.openUrlsRequested(["BunAway-Test://open/a", "not a url", "file://localhost/tmp/x.txt"]);
      application.openUrlsRequested(["bunaway-test://open/b"]);
      // Nothing valid is left to forward, so no hook call follows.
      application.openUrlsRequested(["not a url"]);
      await until("onOpenUrls:bunaway-test://open/b");
      process.emit("SIGTERM", "SIGTERM");`,
  });
  expect(log.slice(0, 4)).toEqual([
    "onReady",
    OPEN_LINE,
    "onOpenUrls:bunaway-test://open/a|file:///tmp/x.txt",
    "onOpenUrls:bunaway-test://open/b",
  ]);
  expect(log.filter((line) => line.startsWith("onOpenUrls"))).toHaveLength(2);
});

test("macOS cold-launch open requests delivered before the first pump reach onOpenUrls after onReady and the initial onOpen", async () => {
  const { log } = await runScenario({
    desktop: OPEN_URLS_DESKTOP,
    atLaunch: `
      application.openUrlsRequested(["BunAway-Test://open/first", "file://localhost/tmp/launch.txt"]);
      application.openUrlsRequested(["bunaway-test://open/second"]);`,
    drive: `
      await until("onOpenUrls:bunaway-test://open/second");
      note("presented:" + (globalThis.presented ?? 0));
      process.emit("SIGTERM", "SIGTERM");`,
  });
  expect(log.slice(0, 4)).toEqual([
    "onReady",
    OPEN_LINE,
    "onOpenUrls:bunaway-test://open/first|file:///tmp/launch.txt",
    "onOpenUrls:bunaway-test://open/second",
  ]);
  // Delivering held requests shows no window.
  expect(log).toContain("presented:0");
});

test("macOS reopen with onReopen registered is forwarded and the host does not show a window itself", async () => {
  const { log } = await runScenario({
    desktop: OPEN_URLS_DESKTOP,
    drive: `
      application.reopened(true);
      await until("onReopen:true");
      webviews[0].close();
      await until("onAllWindowsClosed");
      await Bun.sleep(100);
      application.reopened(false);
      await until("onReopen:false");
      await Bun.sleep(200);
      note("windows:" + webviews.length);
      process.emit("SIGTERM", "SIGTERM");`,
  });
  expect(log).toContain("windows:1");
  expect(log.filter((line) => line.startsWith("onReopen"))).toEqual([
    "onReopen:true",
    "onReopen:false",
  ]);
});

test("macOS reopen without onReopen shows a window only when none is visible", async () => {
  const { log } = await runScenario({
    desktop: withClose("keep-alive"),
    drive: `
      application.reopened(true);
      await Bun.sleep(200);
      note("visible:" + webviews.length);
      webviews[0].close();
      await until("onAllWindowsClosed");
      await Bun.sleep(100);
      application.reopened(false);
      while (webviews.length < 2) await Bun.sleep(5);
      note("hidden:" + webviews.length);
      process.emit("SIGTERM", "SIGTERM");`,
  });
  expect(log).toContain("visible:1");
  expect(log).toContain("hidden:2");
});

/**
 * The host registers its signal handler with `process.on("SIGTERM")` (native/macos/bun/entry.ts), so
 * `process.emit("SIGTERM")` runs the same listener as a delivered signal on every platform. Emitting
 * replaces `process.kill` because on Windows a SIGTERM kill terminates the process without running
 * handlers. OS signal delivery itself is not covered here; the macOS native `sigterm` scenario in
 * tests/lifecycle/macos-desktop.ts checks it.
 */
const EMIT_SIGTERM = 'process.emit("SIGTERM", "SIGTERM");';

test("macOS SIGTERM handler runs the shutdown hooks with the interrupted reason", async () => {
  const { log } = await runScenario({
    desktop: withClose(),
    // A pending veto would not matter either: the signal is not cancellable.
    vetoes: 1_000,
    drive: EMIT_SIGTERM,
  });
  expect(log).toEqual([
    "onReady",
    OPEN_LINE,
    "onWillQuit:interrupted",
    "stopHook",
    "onQuit:interrupted",
  ]);
});

/** Well under the forced shutdown deadline, which a deadlocked shutdown would have to reach. */
const ORDERLY_STARTUP_SHUTDOWN_BUDGET_MS = 5_000;

test("macOS SIGTERM handler before the backend is ready shuts down in order without waiting for the forced deadline", async () => {
  const { log, elapsedMs } = await runScenario({
    desktop: withClose(),
    holdSetup: true,
    drive: `
      ${EMIT_SIGTERM}
      // Setup is still running when the signal arrives; it finishes while shutdown is under way.
      await Bun.sleep(200);
      await releaseSetup();`,
  });
  // The app never became ready, so only the shutdown hooks run.
  expect(log).toEqual([
    "setupHeld",
    "onWillQuit:interrupted",
    "stopHook",
    "onQuit:interrupted",
  ]);
  expect(elapsedMs).toBeLessThan(ORDERLY_STARTUP_SHUTDOWN_BUDGET_MS);
});

test("macOS session end ignores a pending beforeQuit veto and never consults beforeQuit again", async () => {
  const { log } = await runScenario({
    desktop: `{
      onReady() { log("onReady"); },
      onOpen(request) { log("onOpen:" + request.source + ":" + request.argv.length + ":" + typeof request.cwd); },
      async beforeQuit(reason) { log("beforeQuit:" + reason); await Bun.sleep(300); return false; },
      onWillQuit(reason) { log("onWillQuit:" + reason); },
      onQuit(reason) { log("onQuit:" + reason); },
    }`,
    drive: `
      application.quitRequested();
      await until("beforeQuit:quit-command");
      application.sessionEnding();`,
  });
  expect(log).toEqual([
    "onReady",
    OPEN_LINE,
    "beforeQuit:quit-command",
    "onWillQuit:session-end",
    "stopHook",
    "onQuit:session-end",
  ]);
});

test("macOS host failure skips the shutdown hooks but still stops Core", async () => {
  const { log, errors } = await runScenario({
    desktop: withClose(),
    drive: 'application.fail(new Error("host failed"));',
    exitCode: 1,
  });
  expect(log).toEqual([
    "onReady",
    OPEN_LINE,
    "stopHook",
  ]);
  expect(errors).toContain("host failed");
});

/**
 * Drives the real backend Worker as the main thread would, without the fake AppKit layer: the test
 * sends the packets the main thread sends, so the order of a quit and a native event is exact
 * instead of racing the host's own teardown.
 */
test("macOS backend drops native events after an approved quit committed the shutdown", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-backend-"));
  let worker: Worker | undefined;
  try {
    const app = resolve(directory, "app.ts");
    const opened = resolve(directory, "opened");
    await Bun.write(
      app,
      `import { writeFileSync } from "node:fs";
      export default {
        commands: {},
        events: { ping: {} },
        desktop: {
          beforeQuit() {},
          onOpenUrls() {
            writeFileSync(${JSON.stringify(opened)}, "");
          },
        },
      };`,
    );
    await bundleMacosHost(
      resolve(import.meta.dir, "../../native/macos/bun"),
      directory,
      app,
    );
    const config = workerConfig(directory, [
      "ping",
    ]);
    worker = new Worker(resolve(directory, "backend.js"), {
      workerData: config,
    });
    const exited = new Promise<number>((done) => worker?.once("exit", done));
    const failures: unknown[] = [];
    const received: Packet[] = [];
    const channel = new Channel(
      worker,
      config.runtime,
      "macos-main",
      (packet) => {
        received.push(packet);
      },
      (error) => failures.push(error),
    );
    const until = async (condition: () => boolean, what: string) => {
      const deadline = Date.now() + 8000;
      while (!condition()) {
        if (failures.length > 0 || Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${what}: ${failures}`);
        }
        await Bun.sleep(5);
      }
    };
    const eventsDelivered = () =>
      received.filter(
        (packet) => packet.kind === "server" && packet.message.kind === "event",
      ).length;

    await until(
      () => received.some((packet) => packet.kind === "ready"),
      "backend ready",
    );
    // Open a document session and subscribe it to the event, as the page's SDK would.
    const route: Route = {
      viewId: "main",
      context: "context-1" as HostContext,
      documentGeneration: 1,
    };
    await channel.send({
      kind: "session-open",
      route,
    });
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
    await channel.send({
      kind: "client",
      route,
      message: {
        kind: "listen",
        protocol: PROTOCOL_VERSION,
        id: "listen-1",
        event: "ping",
      },
    });
    const ping = {
      kind: "native-event",
      route,
      event: "ping",
      payload: null,
    } as const;

    // Before the commit a native event reaches the subscribed session.
    await channel.send(ping);
    await until(() => eventsDelivered() === 1, "the first native event");

    // The app approves the quit: the backend commits and tells the main thread.
    await channel.send({
      kind: "quit-request",
      reason: "quit-command",
    });
    await until(
      () => received.some((packet) => packet.kind === "shutdown-committed"),
      "shutdown-committed",
    );
    // The backend accepts the packet but no longer delivers it to the app.
    await channel.send(ping);
    await Bun.sleep(100);
    expect(eventsDelivered()).toBe(1);
    // An open request arriving after the commit is dropped with its own diagnostic, not reported
    // as a failed callback, and the diagnostic carries only the count.
    await channel.send({
      kind: "open-urls",
      urls: [
        "https://late.example/",
      ],
    });
    await until(
      () => received.some((packet) => packet.kind === "diagnostic"),
      "the open-urls diagnostic",
    );
    const diagnostics = received.filter(
      (packet) => packet.kind === "diagnostic",
    );
    expect(diagnostics).toEqual([
      {
        kind: "diagnostic",
        event: "open-urls-dropped",
        fields: {
          reason: "ending",
          count: 1,
        },
      },
    ]);
    expect(await Bun.file(opened).exists()).toBe(false);

    // The main thread finishes the orderly shutdown and the Worker exits cleanly.
    await channel.send({
      kind: "shutdown",
    });
    await until(
      () => received.some((packet) => packet.kind === "cleaned"),
      "cleaned",
    );
    await channel.send({
      kind: "native-stopped",
    });
    expect(await exited).toBe(0);
    expect(failures).toEqual([]);
  } finally {
    await worker?.terminate();
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}, 20000);

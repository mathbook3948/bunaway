import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { HostContext } from "@bunaway/protocol";
import { appModules } from "#cli/app-modules";
import { bundleMacosHost } from "#cli/assets";
import type { MacosConfig } from "#native/macos/bun/config";

/**
 * The real main-thread host (entry.ts) and backend Worker run against a fake AppKit layer, so the
 * order of the app's lifecycle hooks is checked on every platform. The fake exposes the hooks that
 * AppKit would call (`quitRequested`, `sessionEnding`, `reopened`, a window close) to the driver.
 * Real AppKit behavior is covered by tests/lifecycle/macos-desktop.ts on macOS.
 */

type Scenario = {
  /** Source of the `desktop` options object; may use `log` and `vetoes`. */
  desktop: string;
  /** Number of beforeQuit calls that veto before one is approved. */
  vetoes?: number;
  /** Driver body, run once the initial `onOpen` was logged. */
  drive: string;
  /** Expected process exit code. */
  exitCode?: number;
};

const OPEN_LINE = "onOpen:initial:0:string";

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
          commands: [],
          events: [],
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
    await Bun.write(
      app,
      `import { appendFileSync } from "node:fs";
      const log = (line) => appendFileSync(${JSON.stringify(events)}, line + "\\n");
      let vetoes = ${scenario.vetoes ?? 0};
      export default {
        commands: {}, events: {},
        plugins: [{name: "cleanup", version: "1.0.0", setup() { return () => log("stopHook"); }}],
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
      `import { existsSync, readFileSync } from "node:fs";
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
      (async () => {
        await until(${JSON.stringify(OPEN_LINE)});
        ${scenario.drive}
      })().catch((error) => { console.error(error); process.exit(3); });
      try { await runMacosApp(${JSON.stringify(workerConfig(directory))}); }
      catch (error) { console.error(error.message); process.exitCode = 1; }`,
    );
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
      application.reopened();
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

test("macOS SIGTERM runs the shutdown hooks with the interrupted reason", async () => {
  const { log } = await runScenario({
    desktop: withClose(),
    // A pending veto would not matter either: the signal is not cancellable.
    vetoes: 1_000,
    drive: 'process.kill(process.pid, "SIGTERM");',
  });
  expect(log).toEqual([
    "onReady",
    OPEN_LINE,
    "onWillQuit:interrupted",
    "stopHook",
    "onQuit:interrupted",
  ]);
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

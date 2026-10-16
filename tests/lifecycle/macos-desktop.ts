import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { type InstalledPlugin, installedPlugins } from "#cli/plugins";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";
import { driver } from "../fixtures/macos-desktop/driver.ts";
import {
  type DesktopFixture,
  desktopFixturePath,
} from "../fixtures/macos-desktop/fixture-config.ts";

/**
 * Real AppKit gate for the macOS close and quit lifecycle (ADR 0020). One compiled app runs seven
 * scenarios; a UI-thread driver plugin triggers the delegate and window paths the OS would (including
 * self-addressed reopen and quit Apple events), and the app's desktop hooks record what happened.
 *
 * Not covered, because CI cannot log out: a real logout, restart or shutdown. The `session-end`
 * scenario posts NSWorkspaceWillPowerOffNotification and then sends a quit Apple event;
 * `session-end-quit-reason` sends a quit Apple event whose quit reason is `shut`. Both exercise the
 * host's quit event handler, which suspends the event and replies after app cleanup.
 */

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-desktop-"));

/** Upper bound for a session-end shutdown. The host may hold the quit event reply for SESSION_END_WAIT_MS (4000) before it gives up. */
const SESSION_END_BUDGET_MS = 3000;
const LAUNCH_TIMEOUT_MS = 30_000;
const POLL_MS = 20;

const HOOK_LINE =
  /^(onReady|onOpen|beforeQuit|onWillQuit|onQuit|onAllWindowsClosed|stopHook)/;
/** `onReady` precedes the initial open in every scenario. */
const OPEN = [
  "onReady",
  "onOpen:initial",
];

type Scenario = {
  name: string;
  /** Hook lines, in order, after dropping page and lifecycle lines. */
  hooks: string[];
  /**
   * Hook lines that may follow `hooks` and may be missing. A session end lets AppKit exit right
   * after app cleanup, so `onQuit` and the host's final log record are not guaranteed.
   */
  optionalTail?: string[];
  /** Whether the host log may lack `host-stopped`; a session end may exit before it. */
  hostStoppedOptional?: boolean;
  /** Further checks on the whole log. */
  verify?: (lines: string[]) => void;
};

/** Index of a line that must exist; ordering checks compare these. */
function at(lines: string[], line: string): number {
  const index = lines.indexOf(line);
  assert.notEqual(index, -1, `Missing ${line} in\n${lines.join("\n")}`);
  return index;
}

const SHUTDOWN_AFTER = (reason: string) => [
  `onWillQuit:${reason}`,
  "stopHook",
  `onQuit:${reason}`,
];

/** A timer on the UI thread fired after the termination request, so the thread was not blocked. */
function verifyMainThreadStayedAlive(lines: string[]) {
  at(lines, "main-tick-after-terminate");
}

const scenarios: Scenario[] = [
  {
    // a: Quit command with a veto, then an approved Dock Quit Apple event.
    name: "quit-veto",
    hooks: [
      ...OPEN,
      "beforeQuit:quit-command",
      "beforeQuit:quit-command",
      ...SHUTDOWN_AFTER("quit-command"),
    ],
    verify(lines) {
      // The veto left the page connected, and the committed shutdown refuses host operations.
      assert(
        at(lines, "pageRoundTrip:quit-veto") >
          at(lines, "beforeQuit:quit-command"),
      );
      at(lines, "onWillQuitHostOperation:CANCELLED");
    },
  },
  {
    // b: closing the last window of a default (quit) app.
    name: "last-window",
    hooks: [
      ...OPEN,
      "beforeQuit:last-window",
      ...SHUTDOWN_AFTER("last-window"),
    ],
  },
  {
    // c: keep-alive reports an empty app once, a reopen Apple event brings a window back, Quit ends the app.
    name: "keep-alive",
    hooks: [
      ...OPEN,
      "onAllWindowsClosed",
      "beforeQuit:quit-command",
      ...SHUTDOWN_AFTER("quit-command"),
    ],
    verify(lines) {
      // The backend loop outlived the last window, and the reopen made a new window.
      assert(
        lines.some((line) => line.startsWith("tickAfterAllClosed:")),
        "the backend stopped after the last window closed",
      );
      const before = lines.find((line) =>
        line.startsWith("mainWindow:before:"),
      );
      const after = lines.find((line) => line.startsWith("mainWindow:after:"));
      assert(before && after, "reopen did not recreate main");
      assert.notEqual(
        before.split(":")[2],
        after.split(":")[2],
        "reopen reused the closed window",
      );
      assert(at(lines, after) > at(lines, "onAllWindowsClosed"));
    },
  },
  {
    // d: a declined close keeps the window, an accepted one reports closed then destroyed.
    name: "close-lifecycle",
    hooks: [
      ...OPEN,
      "beforeQuit:last-window",
      ...SHUTDOWN_AFTER("last-window"),
    ],
    verify(lines) {
      // While the first request was pending, the app could not close the window and the observer
      // could not answer for it.
      const busy = at(lines, "closeWhilePending:BUSY");
      const denied = at(lines, "observerRespond:PERMISSION_DENIED");
      const declined = at(lines, "answered:main:decline");
      assert(at(lines, "declining:main") < busy);
      assert(busy < declined && denied < declined);
      assert(at(lines, "visibleAfterDecline:2") > declined);
      // The recreated main reports created, ready, closed and destroyed in that order. The
      // decline produced no closed event; the second, accepted close did.
      const created = at(lines, "lifecycle:created:main");
      const ready = at(lines, "lifecycle:ready:main");
      const closed = lines.lastIndexOf("lifecycle:closed:main");
      const destroyed = lines.lastIndexOf("lifecycle:destroyed:main");
      assert(created < ready);
      assert(ready < declined);
      assert(closed > declined);
      assert(destroyed > closed);
      assert.equal(
        lines.filter((line) => line === "lifecycle:closed:main").length,
        2,
      );
    },
  },
  {
    // e: session end skips beforeQuit and suspends the quit Apple event without blocking Bun. The
    // OS may end the process right after the reply, so onQuit and the host's last log record may be missing.
    name: "session-end",
    hooks: [
      ...OPEN,
      "onWillQuit:session-end",
      "stopHook",
    ],
    optionalTail: [
      "onQuit:session-end",
    ],
    hostStoppedOptional: true,
    verify: verifyMainThreadStayedAlive,
  },
  {
    // f: the same, started by a quit Apple event whose quit reason is `shut`.
    name: "session-end-quit-reason",
    hooks: [
      ...OPEN,
      "onWillQuit:session-end",
      "stopHook",
    ],
    optionalTail: [
      "onQuit:session-end",
    ],
    hostStoppedOptional: true,
    verify: verifyMainThreadStayedAlive,
  },
  {
    // g: SIGTERM from the harness.
    name: "sigterm",
    hooks: [
      ...OPEN,
      ...SHUTDOWN_AFTER("interrupted"),
    ],
  },
];

const reports: object[] = [];
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const assets = resolve(directory, "assets");
  await mkdir(resolve(assets, "web"), {
    recursive: true,
  });
  const views = [
    "main",
    "observer",
  ];
  const app = {
    appId: "tests.macos.desktop",
    windows: views.map((view) => ({
      view,
      home: `https://app.bunaway.local/${view}.html`,
      title: view,
      window: {
        width: 500,
        height: 400,
      },
    })),
  };
  /** `main` is asked about its closes; `observer` watches the windows and probes the request. */
  const viewPolicies: Record<
    string,
    {
      commands: string[];
      events: string[];
      permissions: string[];
    }
  > = {
    main: {
      commands: [
        "test.scenario",
        "test.log",
        "test.vetoed",
        "test.pendingClose",
        "plugin.windows.respondClose",
      ],
      events: [
        "windows.closeRequested",
      ],
      permissions: [
        "windows.respondClose",
      ],
    },
    observer: {
      commands: [
        "test.scenario",
        "test.log",
        "test.pendingRequest",
        "plugin.windows.respondClose",
      ],
      events: [
        "windows.lifecycle",
      ],
      // listInstances is what entitles a window to receive windows.lifecycle.
      permissions: [
        "windows.listInstances",
        "windows.respondClose",
      ],
    },
  };
  const policy = {
    version: 1,
    backend: {
      permissions: [
        "driver.drive",
        "windows.list",
        "windows.listInstances",
        "windows.close",
        "windows.recreate",
      ],
    },
    views: views.map((id) => {
      const viewPolicy = viewPolicies[id];
      assert(viewPolicy, id);
      return {
        id,
        origins: [
          "https://app.bunaway.local",
        ],
        commands: viewPolicy.commands,
        events: viewPolicy.events,
        host: {
          permissions: viewPolicy.permissions,
        },
      };
    }),
  };
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app,
    policy,
    plugins: [],
    developmentSdk: {},
  });
  const installed: InstalledPlugin[] = [
    ...(await installedPlugins(root, "0.0.0")).filter(
      (plugin) => plugin.name === "windows",
    ),
    {
      name: driver._definition.name,
      version: driver._definition.version,
      packageName: "fixture-driver",
      root,
      native: driver._definition.native,
      targets: {
        macos: {
          thread: "ui",
          operations: resolve(root, "tests/fixtures/macos-desktop/native.ts"),
          supportedOperations: [
            "driver.drive",
          ],
        },
      },
    },
  ];
  const bundled = await bundleMacosHost(
    resolve(root, "native/macos/bun"),
    assets,
    resolve(root, "tests/fixtures/macos-desktop/app.ts"),
    undefined,
    false,
    installed,
  );
  const web = await Bun.build({
    entrypoints: [
      resolve(root, "tests/fixtures/macos-desktop/web.ts"),
    ],
    target: "browser",
    outdir: resolve(assets, "web"),
  });
  assert(web.success, web.logs.map(String).join("\n"));
  for (const output of web.outputs) {
    await Bun.write(output.path, await output.arrayBuffer());
  }
  for (const view of views) {
    await Bun.write(
      resolve(assets, "web", `${view}.html`),
      '<!doctype html><title>Desktop</title><script type="module" src="web.js"></script>',
    );
  }
  const executable = resolve(directory, "bunaway-host");
  await compileMacosApp(assets, process.execPath, executable, bundled);
  const inventory: Record<string, string> = {};
  for (const file of await files(assets)) {
    inventory[relative(directory, file)] = await hash(file);
  }
  await writeJson(resolve(directory, "manifest.json"), {
    bun: pin.bun,
    assets: inventory,
  });

  for (const scenario of scenarios) {
    const home = resolve(directory, scenario.name);
    const dataRoot = resolve(
      home,
      "Library/Application Support/bunaway",
      app.appId,
    );
    await mkdir(dataRoot, {
      recursive: true,
    });
    const eventsPath = resolve(home, "events.log");
    await Bun.write(eventsPath, "");
    // The host hands the backend and the native plugins a sanitized environment, so the scenario
    // reaches them through a file in the data root instead of environment variables.
    await writeJson(desktopFixturePath(dataRoot), {
      scenario: scenario.name,
      events: eventsPath,
    } satisfies DesktopFixture);
    const readLines = async () =>
      (await Bun.file(eventsPath).text()).split("\n").filter(Boolean);
    const launched = Bun.spawn(
      [
        executable,
        "--package",
        directory,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: LAUNCH_TIMEOUT_MS,
      },
    );
    child = launched;
    const output = new Response(launched.stdout).text();
    const errors = new Response(launched.stderr).text();
    let sessionEndStartedAt: number | undefined;
    // Observe the log while the app runs: the SIGTERM stimulus and the session-end clock need it.
    const watcher = (async () => {
      let signalled = false;
      while (launched.exitCode === null) {
        const lines = await readLines();
        if (
          scenario.name.startsWith("session-end") &&
          sessionEndStartedAt === undefined &&
          lines.includes("driving-session-end")
        ) {
          sessionEndStartedAt = Date.now();
        }
        if (
          scenario.name === "sigterm" &&
          !signalled &&
          lines.includes("ready-for-signal")
        ) {
          signalled = true;
          launched.kill("SIGTERM");
        }
        await Bun.sleep(POLL_MS);
      }
    })();
    const exitCode = await launched.exited;
    const exitedAt = Date.now();
    await watcher;
    await output;
    const stderr = await errors;
    const lines = await readLines();
    assert.equal(
      exitCode,
      0,
      `${scenario.name}\n${stderr}\n${lines.join("\n")}`,
    );
    assert.equal(
      lines.filter((line) => line.startsWith("script-failed")).length,
      0,
      lines.join("\n"),
    );
    const hooks = lines.filter((line) => HOOK_LINE.test(line));
    assert.deepEqual(
      hooks.slice(0, scenario.hooks.length),
      scenario.hooks,
      `${scenario.name}\n${lines.join("\n")}`,
    );
    // Whatever trails the required hooks must be a leading part of the optional tail.
    const trailing = hooks.slice(scenario.hooks.length);
    assert.deepEqual(
      trailing,
      (scenario.optionalTail ?? []).slice(0, trailing.length),
      `${scenario.name}\n${lines.join("\n")}`,
    );
    // The initial open carries no arguments and a working directory.
    at(lines, "openArgs:0");
    at(lines, "openCwd:nonempty");
    scenario.verify?.(lines);
    if (scenario.name.startsWith("session-end")) {
      assert(sessionEndStartedAt !== undefined, "session end was not driven");
      // Suspending the quit event must leave Bun's event loop running, so cleanup completes and the
      // reply is given long before the 4 s fallback timer. A blocked loop would only exit at the fallback.
      assert(
        exitedAt - sessionEndStartedAt < SESSION_END_BUDGET_MS,
        `session end took ${exitedAt - sessionEndStartedAt} ms`,
      );
    }
    const records = (await Bun.file(resolve(dataRoot, "logs/host.log")).text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const stopped = records.at(-1);
    // AppKit may exit a session end before the host writes its final record.
    if (!scenario.hostStoppedOptional || stopped?.event === "host-stopped") {
      assert.equal(stopped?.event, "host-stopped", scenario.name);
      assert.equal(stopped.failed, false, scenario.name);
      assert.equal(stopped.forced, false, scenario.name);
    }
    reports.push({
      scenario: scenario.name,
      exitCode,
      elapsedAfterSessionEndMs:
        sessionEndStartedAt === undefined
          ? undefined
          : exitedAt - sessionEndStartedAt,
      lines,
    });
  }
  await writeJson(resolve(root, "build/macos-desktop-results.json"), {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    revision: Bun.revision,
    reports,
  });
  console.log(
    "PASS compiled AppKit close and quit lifecycle: Quit veto, last window, keep-alive Apple event reopen, close requests and lifecycle events, session-end suspended quit event (notification and quit reason) and SIGTERM",
  );
} catch (error) {
  const diagnostics = resolve(root, "build/macos-desktop-diagnostics");
  await mkdir(diagnostics, {
    recursive: true,
  });
  for (const scenario of scenarios) {
    const logs = resolve(
      directory,
      scenario.name,
      "Library/Application Support/bunaway/tests.macos.desktop/logs",
    );
    if (await Bun.file(resolve(logs, "host.log")).exists()) {
      await cp(logs, resolve(diagnostics, scenario.name), {
        recursive: true,
      });
    }
  }
  await writeJson(resolve(root, "build/macos-desktop-results.json"), {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    revision: Bun.revision,
    reports,
    failure: error instanceof Error ? error.message : String(error),
  });
  throw error;
} finally {
  if (child?.exitCode === null) {
    child.kill("SIGKILL");
  }
  await child?.exited;
  await rm(directory, {
    recursive: true,
    force: true,
  });
}

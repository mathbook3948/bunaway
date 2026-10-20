import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { bundleMacosHost } from "#cli/assets";
import { files, hash, writeJson } from "#cli/files";
import { compileMacosApp } from "#cli/macos-compile";
import { type InstalledPlugin, installedPlugins } from "#cli/plugins";
import { SESSION_END_WAIT_MS } from "../../native/windows/bun/session-end.ts";
import pin from "../../runtime/build-manifests/darwin-aarch64.json";
import { waitFor } from "../fixtures/deadlines.ts";
import { driver } from "../fixtures/macos-desktop/driver.ts";
import {
  type DesktopFixture,
  desktopFixturePath,
  OPEN_URL,
} from "../fixtures/macos-desktop/fixture-config.ts";

/**
 * Real AppKit gate for the macOS close and quit lifecycle (ADR 0020). One compiled app runs twelve
 * scenarios; a UI-thread driver plugin triggers the delegate and window paths the OS would (including
 * self-addressed reopen and quit Apple events), and the app's desktop hooks record what happened.
 *
 * Not covered, because CI cannot log out: a real logout, restart or shutdown. The `session-end`
 * scenario posts NSWorkspaceWillPowerOffNotification and then sends a quit Apple event;
 * `session-end-quit-reason` sends a quit Apple event whose quit reason is `shut`. Both send with
 * `kAENoReply`, so nobody waits for the reply. `session-end-reply` therefore sends the same event from
 * a separate process that waits for the reply (fixtures/macos-desktop/quit-event-sender.ts) and checks
 * that the reply came after app cleanup and within SESSION_END_WAIT_MS. All three exercise the host's
 * quit event handler, which suspends the event and replies after app cleanup.
 */

assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
const root = resolve(import.meta.dir, "../..");
const directory = await mkdtemp(resolve(tmpdir(), "bunaway-macos-desktop-"));

/** Upper bound for a session-end shutdown. The host may hold the quit event reply for SESSION_END_WAIT_MS (4000) before it gives up. */
const SESSION_END_BUDGET_MS = 3000;
const LAUNCH_TIMEOUT_MS = 30_000;
const POLL_MS = 20;
const QUIT_EVENT_SENDER = resolve(
  root,
  "tests/fixtures/macos-desktop/quit-event-sender.ts",
);
/** Quit reason the sender attaches; one of the reasons that mean a session end. */
const SENDER_QUIT_REASON = "shut";
/** `errAEEventNotPermitted`: the system denied this process the right to send Apple events to the app. */
const ERR_AE_EVENT_NOT_PERMITTED = -1743;

const HOOK_LINE =
  /^(onReady|onOpen|beforeQuit|onWillQuit|onQuit|onAllWindowsClosed|onOpenUrls|onReopen|stopHook)(:|$)/;
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
  /**
   * Whether the app starts a second host process of itself (`relaunch()`). The scenario then
   * continues until that process has ended too, and `hooks` cover both processes.
   */
  relaunches?: boolean;
  /** Whether a separate process sends the quit event and waits for the reply; the reply is then checked against cleanup. */
  waitsForQuitReply?: boolean;
  /** Further checks on the whole log. */
  verify?: (lines: string[]) => void;
};

/** Host log records kept in a failure message; enough to cover a window's load and handshake. */
const HOST_LOG_TAIL_RECORDS = 60;

/**
 * The last host log records of a scenario without timestamps, as one line each. A page that fails
 * before its handshake completes cannot log, so these records (`navigation-completed`,
 * `session-open`, `web-message-rejected`, `revoke`, `request-timeout`) are the only account of it.
 */
async function hostLogTail(dataRoot: string): Promise<string> {
  const file = Bun.file(resolve(dataRoot, "logs/host.log"));
  if (!(await file.exists())) {
    return "host.log: missing";
  }
  const records = (await file.text()).split("\n").filter(Boolean);
  const summary = records.slice(-HOST_LOG_TAIL_RECORDS).map((line) => {
    try {
      const { t: _time, ...record } = JSON.parse(line);
      return JSON.stringify(record);
    } catch {
      return line;
    }
  });
  return `host.log tail:\n${summary.join("\n")}`;
}

/** What the quit event sender reported: its stdout line (see quit-event-sender.ts) and exit code. */
type SenderOutcome = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Checks the sender's outcome and the order of the app's cleanup against the reply. The sender
 * logs `quit-reply-received` right after the reply returned, so a reply that came before
 * `onWillQuit` or the stop hook shows as an earlier index.
 */
function verifyQuitReply(lines: string[], outcome: SenderOutcome) {
  const detail = `sender stdout: ${outcome.stdout}\nsender stderr: ${outcome.stderr}`;
  let report: {
    ok?: boolean;
    elapsedMs?: number;
    errorCode?: number;
  } = {};
  try {
    report = JSON.parse(outcome.stdout.trim());
  } catch {
    // The assertions below report the missing JSON with the raw output.
  }
  const permissionHint =
    report.errorCode === ERR_AE_EVENT_NOT_PERMITTED
      ? " (errAEEventNotPermitted: the system denied Apple events from the sender to the app, an Automation permission problem)"
      : "";
  assert(
    outcome.exitCode === 0 && report.ok === true,
    `quit event sender failed: exit ${outcome.exitCode}, errorCode ${report.errorCode}${permissionHint}\n${detail}`,
  );
  const replied = at(lines, "quit-reply-received");
  const cleanedUp = at(lines, "stopHook");
  const willQuit = at(lines, "onWillQuit:session-end");
  assert(
    cleanedUp < replied && willQuit < replied,
    `the quit event was answered before app cleanup: onWillQuit at ${willQuit}, stopHook at ${cleanedUp}, reply at ${replied}\n${lines.join("\n")}`,
  );
  assert(
    report.elapsedMs !== undefined && report.elapsedMs < SESSION_END_WAIT_MS,
    `the quit event reply took ${report.elapsedMs} ms, not under ${SESSION_END_WAIT_MS} ms\n${detail}`,
  );
}

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

/** Host process ids the fixture logged at each `onReady`, in start order. */
function hostPids(lines: string[]): number[] {
  return lines
    .filter((line) => line.startsWith("hostPid:"))
    .map((line) => Number(line.slice("hostPid:".length)));
}

/** True while a process with `pid` exists (signal 0 only checks). */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Waits for the process that `relaunch()` started to start and end. It is not a child of the test,
 * so its end is seen through its pid; a process that never ends is killed so it cannot leak.
 */
async function awaitRelaunchedHost(readLines: () => Promise<string[]>) {
  const pidOfSecondHost = async () => hostPids(await readLines())[1];
  try {
    await waitFor(pidOfSecondHost, {
      deadline: "nativeFixture",
      what: "the relaunched host to start",
    });
    await waitFor(
      async () => {
        const pid = await pidOfSecondHost();
        return pid !== undefined && !processExists(pid) ? true : undefined;
      },
      {
        deadline: "nativeFixture",
        what: "the relaunched host to end",
      },
    );
  } catch (error) {
    const pid = await pidOfSecondHost();
    if (pid !== undefined && processExists(pid)) {
      process.kill(pid, "SIGKILL");
    }
    throw error;
  }
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
      at(lines, "onWillQuitHostOperation:INVALID_ARGUMENT");
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
    // c2: the OS asks the app to open a URL scheme link and a document. Both reach onOpenUrls
    // after onReady and the initial onOpen, normalized.
    name: "open-urls",
    hooks: [
      ...OPEN,
      "onOpenUrls:1",
      "onOpenUrls:1",
      "beforeQuit:quit-command",
      ...SHUTDOWN_AFTER("quit-command"),
    ],
    verify(lines) {
      const opened = lines.filter((line) => line.startsWith("openedUrl:"));
      const expectedFile = lines
        .find((line) => line.startsWith("openFileExpected:"))
        ?.slice("openFileExpected:".length);
      assert(expectedFile, "the fixture did not record the expected file URL");
      assert.deepEqual(opened, [
        `openedUrl:${OPEN_URL}`,
        `openedUrl:${expectedFile}`,
      ]);
    },
  },
  {
    // c3: with onReopen registered a reopen reaches the app with the window visibility, and the
    // host does not show a window on its own.
    name: "reopen-handler",
    hooks: [
      ...OPEN,
      "onReopen:true",
      "onAllWindowsClosed",
      "onReopen:false",
      "beforeQuit:quit-command",
      ...SHUTDOWN_AFTER("quit-command"),
    ],
    verify(lines) {
      at(lines, "windowsAfterVisibleReopen:2");
      at(lines, "windowsAfterHiddenReopen:0");
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
    // d2: recreating a window repeatedly leaves one window of that title in `[NSApp windows]`, so the
    // replaced windows were released and deallocated.
    name: "recreate-release",
    hooks: [
      ...OPEN,
      "beforeQuit:last-window",
      ...SHUTDOWN_AFTER("last-window"),
    ],
    verify(lines) {
      at(lines, "mainWindowCount:1");
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
    // f2: the same, but the sender is a separate process that waits for the reply, so the host
    // must hold the reply back until cleanup instead of answering at once.
    name: "session-end-reply",
    hooks: [
      ...OPEN,
      "onWillQuit:session-end",
      "stopHook",
    ],
    optionalTail: [
      "onQuit:session-end",
    ],
    hostStoppedOptional: true,
    // The quit event comes from another process, not the driver, so no driver tick mark exists;
    // the reply arriving after cleanup and within the wait budget shows the main thread kept running.
    waitsForQuitReply: true,
  },
  {
    // h: relaunch() quits the first process and starts a second one, which quits for good.
    name: "relaunch",
    relaunches: true,
    hooks: [
      ...OPEN,
      "beforeQuit:api",
      ...SHUTDOWN_AFTER("api"),
      ...OPEN,
      "beforeQuit:api",
      ...SHUTDOWN_AFTER("api"),
    ],
    verify(lines) {
      at(lines, "relaunch:true");
      at(lines, "quit:true");
      const pids = hostPids(lines);
      assert.equal(pids.length, 2, lines.join("\n"));
      assert.notEqual(pids[0], pids[1]);
      // The second host started only after the first one was gone.
      at(lines, "previousAlive:false");
    },
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
/** Quit event sender of the running scenario. The scenario awaits it; `finally` kills it if a failure left it running. */
let sender: ReturnType<typeof Bun.spawn> | undefined;
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
        // test.pendingClose runs in main's command context and probes windows.close there.
        "windows.close",
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

  /** Launches the compiled app for one scenario and checks its hooks, log and host log. */
  const runScenario = async (scenario: Scenario) => {
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
    let senderOutcome: Promise<SenderOutcome> | undefined;
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
          scenario.waitsForQuitReply &&
          senderOutcome === undefined &&
          lines.includes("ready-for-quit-sender")
        ) {
          // The sender blocks until the app replied; a separate process keeps this loop polling.
          const started = Bun.spawn(
            [
              process.execPath,
              QUIT_EVENT_SENDER,
              String(launched.pid),
              SENDER_QUIT_REASON,
              eventsPath,
            ],
            {
              stdout: "pipe",
              stderr: "pipe",
              timeout: LAUNCH_TIMEOUT_MS,
            },
          );
          sender = started;
          senderOutcome = (async () => {
            const [stdout, stderr, exitCode] = await Promise.all([
              new Response(started.stdout).text(),
              new Response(started.stderr).text(),
              started.exited,
            ]);
            return {
              exitCode,
              stdout,
              stderr,
            };
          })();
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
    if (scenario.relaunches) {
      await awaitRelaunchedHost(readLines);
    }
    await watcher;
    await output;
    const stderr = await errors;
    // The app is gone, so the sender has its reply or its connection error; await it so its log
    // line and exit code are final before they are checked.
    const quitSender = await senderOutcome;
    const lines = await readLines();
    const hostTail = await hostLogTail(dataRoot);
    assert.equal(
      exitCode,
      0,
      `exit code ${exitCode}\n${stderr}\n${lines.join("\n")}\n${hostTail}`,
    );
    assert.equal(
      lines.filter((line) => line.startsWith("script-failed")).length,
      0,
      `${lines.join("\n")}\n${hostTail}`,
    );
    // A page that failed (or never got past its handshake) logs where it stopped.
    assert.equal(
      lines.filter((line) => line.startsWith("page-failed")).length,
      0,
      `${lines.join("\n")}\n${hostTail}`,
    );
    const hooks = lines.filter((line) => HOOK_LINE.test(line));
    assert.deepEqual(
      hooks.slice(0, scenario.hooks.length),
      scenario.hooks,
      `${lines.join("\n")}\n${hostTail}`,
    );
    // Whatever trails the required hooks must be a leading part of the optional tail.
    const trailing = hooks.slice(scenario.hooks.length);
    assert.deepEqual(
      trailing,
      (scenario.optionalTail ?? []).slice(0, trailing.length),
      `${lines.join("\n")}\n${hostTail}`,
    );
    // The initial open carries no arguments and a working directory.
    at(lines, "openArgs:0");
    at(lines, "openCwd:nonempty");
    scenario.verify?.(lines);
    if (scenario.waitsForQuitReply) {
      assert(quitSender, "the quit event sender was never started");
      verifyQuitReply(lines, quitSender);
    }
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
    if (scenario.relaunches) {
      // The first host logged that it started the replacement, and both hosts stopped cleanly.
      assert(
        records.some((record) => record.event === "relaunch-started"),
        scenario.name,
      );
      assert.equal(
        records.filter((record) => record.event === "host-stopped").length,
        2,
        scenario.name,
      );
    }
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
  };
  for (const scenario of scenarios) {
    try {
      await runScenario(scenario);
    } catch (error) {
      // Whatever failed, the first line of the message names the scenario.
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`[scenario ${scenario.name}] ${reason}`, {
        cause: error,
      });
    }
  }
  await writeJson(resolve(root, "build/macos-desktop-results.json"), {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    revision: Bun.revision,
    reports,
  });
  console.log(
    "PASS compiled AppKit close and quit lifecycle: Quit veto, last window, keep-alive Apple event reopen, URL scheme and document open Apple events, reopen delivery to onReopen, close requests and lifecycle events, repeated recreation without leaked windows, session-end suspended quit event (notification, quit reason and a separate process that waits for the reply) and SIGTERM",
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
  if (sender?.exitCode === null) {
    sender.kill("SIGKILL");
  }
  await sender?.exited;
  await rm(directory, {
    recursive: true,
    force: true,
  });
}

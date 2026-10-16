import { appendFileSync, readFileSync } from "node:fs";
import { defineApp } from "@bunaway/backend";
import windows from "@bunaway/plugin-windows";
import { driver } from "./driver.ts";
import { readDesktopFixture } from "./fixture-config.ts";

/**
 * App under test for tests/lifecycle/macos-desktop.ts. The scenario name and the log path come from
 * the fixture file in the data root (the backend Worker's `HOME`), so one compiled app serves every
 * scenario. Each hook appends one line to the log; the test asserts the order. The script for a
 * scenario runs in the backend and drives AppKit through the UI-thread `driver` plugin, never
 * through the page. Desktop hooks run outside any Host API scope, so the scripts do not start from
 * `onOpen`: the "scenario-runner" plugin starts them in its `setup` scope, which stays alive until
 * shutdown, and `onOpen` only signals that the first open happened.
 */
const dataRoot = process.env.HOME;
if (!dataRoot) {
  throw new Error("Missing HOME, the data root of the backend Worker.");
}
const { scenario, events: logPath } = readDesktopFixture(dataRoot);
const log = (line: string) => appendFileSync(logPath, `${line}\n`);
const lines = () => readFileSync(logPath, "utf8").trim().split("\n");

const POLL_MS = 10;
const STEP_TIMEOUT_MS = 10_000;
/** Pause that lets a vetoed or ignored request settle before the next stimulus. */
const SETTLE_MS = 300;
const TICK_MS = 50;
const TICKS_AFTER_ALL_CLOSED = 3;
const isSessionEnd = scenario.startsWith("session-end");

async function until(predicate: () => boolean, what: string) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}.`);
    }
    await Bun.sleep(POLL_MS);
  }
}
const logged = (line: string) => () => lines().includes(line);
const countOf = (line: string) =>
  lines().filter((candidate) => candidate === line).length;
/** Waits until `line` was logged `count` times, for lines a recreated window repeats. */
const loggedTimes = (line: string, count: number) => () =>
  countOf(line) >= count;
const drive = (action: string, title?: string) =>
  driver.drive({
    action: action as "terminate",
    ...(title
      ? {
          title,
        }
      : {}),
  });

/** Error code of a failed host operation, for logs that must not contain free text. */
function codeOf(error: unknown): string {
  const code =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof code === "string" ? code : "UNKNOWN";
}

/** The windowId of the live fixture window of `view`, or undefined while none exists. */
async function windowIdOf(view: string) {
  const instances = await windows.listInstances();
  return instances.find((instance) => instance.viewId === view)?.windowId;
}

/** Polls an async probe until it returns a value. */
async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}.`);
    }
    await Bun.sleep(POLL_MS);
  }
}

/** Request id of the close that `main` left pending, handed to the observer page. */
let pendingCloseRequestId = 0;
/** Counts backend turns; a loop that stays alive keeps raising it. */
let ticks = 0;
setInterval(() => {
  ticks++;
}, TICK_MS).unref();

const scripts: Record<string, () => Promise<void>> = {
  async "quit-veto"() {
    await until(logged("page:main"), "the main page");
    // `[NSApp terminate:]`, as the Quit menu item does, is vetoed once.
    await drive("terminate");
    await until(logged("beforeQuit:quit-command"), "the first beforeQuit");
    await until(
      logged("pageRoundTrip:quit-veto"),
      "a page command after the veto",
    );
    await Bun.sleep(SETTLE_MS);
    // The Dock's Quit item arrives as an Apple event without a quit reason.
    await drive("quitEvent");
  },
  async "last-window"() {
    await until(logged("page:main"), "the main page");
    await until(logged("page:observer"), "the observer page");
    await drive("close", "main");
    await until(logged("lifecycle:destroyed:main"), "main destroyed");
    // The observer window is now the last one.
    await drive("close", "observer");
  },
  async "keep-alive"() {
    await until(logged("page:main"), "the main page");
    await until(logged("page:observer"), "the observer page");
    log(`mainWindow:before:${await windowIdOf("main")}`);
    await drive("close", "main");
    await until(logged("lifecycle:destroyed:main"), "main destroyed");
    await drive("close", "observer");
    await until(logged("onAllWindowsClosed"), "onAllWindowsClosed");
    // The backend keeps running with no window left.
    const ticksWhenEmpty = ticks;
    await until(
      () => ticks >= ticksWhenEmpty + TICKS_AFTER_ALL_CLOSED,
      "backend ticks after onAllWindowsClosed",
    );
    log(`tickAfterAllClosed:${ticks - ticksWhenEmpty}`);
    // A real reopen Apple event brings back a new window instead of the closed one.
    await drive("reopen");
    const recreated = await waitFor(
      () => windowIdOf("main"),
      "a recreated main window",
    );
    log(`mainWindow:after:${recreated}`);
    await drive("quitEvent");
  },
  async "close-lifecycle"() {
    await until(logged("page:main"), "the main page");
    await until(logged("page:observer"), "the observer page");
    // The observer subscribes after main's first creation. Recreating main gives it a complete
    // created, ready, closed and destroyed sequence to watch.
    await windows.recreate({
      view: "main",
    });
    await until(loggedTimes("page:main", 2), "the recreated main page");
    await until(
      loggedTimes("lifecycle:ready:main", 1),
      "the recreated main ready",
    );
    await until(
      loggedTimes("lifecycle:destroyed:main", 1),
      "the replaced main destroyed",
    );
    // The main page declines its first close request and accepts the second. While the first is
    // pending, the page asks us (test.pendingClose) to probe it.
    await drive("close", "main");
    await until(logged("answered:main:decline"), "the declined close");
    log(`visibleAfterDecline:${await drive("visibleWindows")}`);
    await drive("close", "main");
    await until(loggedTimes("lifecycle:destroyed:main", 2), "main destroyed");
    // Closing the last window then asks beforeQuit and ends the app.
    await drive("close", "observer");
  },
  async "session-end"() {
    log("driving-session-end");
    await drive("powerOff");
    // The quit Apple event that follows is part of the session end: the host suspends it and
    // replies after cleanup, without blocking the main thread.
    await drive("quitEvent");
  },
  async "session-end-quit-reason"() {
    await until(logged("page:main"), "the main page");
    log("driving-session-end");
    // No power-off notification: only the quit reason of the Apple event marks a session end.
    await drive("quitEvent", "shut");
  },
  async sigterm() {
    log("ready-for-signal");
  },
};

let vetoes = scenario === "quit-veto" ? 1 : 0;
let opened = false;
/** Settles when the first `onOpen` ran; the runner plugin waits for it before it starts the script. */
let signalFirstOpen: () => void = () => undefined;
const firstOpen = new Promise<void>((resolve) => {
  signalFirstOpen = resolve;
});

export default defineApp({
  modules: [],
  plugins: [
    driver._definition,
    windows,
    {
      name: "lifecycle-log",
      version: "1",
      setup() {
        return () => log("stopHook");
      },
    },
    // After `driver` and `windows`: the script calls both from this setup scope, which the
    // `backend.permissions` of the fixture policy authorize.
    {
      name: "scenario-runner",
      version: "1",
      setup() {
        const script = scripts[scenario];
        if (!script) {
          throw new Error(`Unknown scenario ${scenario}.`);
        }
        // Not awaited: setup must finish for the app to start, and the first open comes after it.
        void (async () => {
          await firstOpen;
          await script();
        })().catch((error) => {
          log(`script-failed:${String(error).replaceAll("\n", " ")}`);
        });
      },
    },
  ],
  events: {},
  commands: {
    "test.scenario": {
      input: {
        const: null,
      },
      output: {
        type: "string",
      },
      run: async () => scenario,
    },
    "test.vetoed": {
      input: {
        const: null,
      },
      output: {
        type: "boolean",
      },
      run: async () => lines().includes("beforeQuit:quit-command"),
    },
    "test.log": {
      input: {
        type: "string",
        pattern: "^[A-Za-z0-9:_-]+$",
      },
      output: {
        const: null,
      },
      run: async (value: unknown) => {
        log(String(value));
        return null;
      },
    },
    "test.pendingRequest": {
      input: {
        const: null,
      },
      output: {
        type: "integer",
      },
      run: async () => pendingCloseRequestId,
    },
    /**
     * Called by `main` while its first close request is pending. Probes that the pending close
     * blocks `windows.close` and rejects a non-owner answer, then returns so `main` can decline.
     */
    "test.pendingClose": {
      input: {
        type: "integer",
        minimum: 1,
      },
      output: {
        const: null,
      },
      run: async (value: unknown) => {
        pendingCloseRequestId = Number(value);
        const closed = await windows
          .close({
            view: "main",
          })
          .then(
            () => "RESOLVED",
            (error: unknown) => codeOf(error),
          );
        log(`closeWhilePending:${closed}`);
        await until(
          () => lines().some((line) => line.startsWith("observerRespond:")),
          "the observer's answer attempt",
        );
        return null;
      },
    },
  },
  desktop: {
    ...(scenario === "keep-alive"
      ? {
          closeBehavior: "keep-alive" as const,
        }
      : {}),
    onReady() {
      log("onReady");
    },
    onOpen(request) {
      log(`onOpen:${request.source}`);
      log(`openArgs:${request.argv.length}`);
      log(`openCwd:${request.cwd.length > 0 ? "nonempty" : "empty"}`);
      if (opened) {
        return;
      }
      opened = true;
      signalFirstOpen();
    },
    beforeQuit(reason) {
      log(`beforeQuit:${reason}`);
      // A session end never asks, so a veto here would show up as a beforeQuit line.
      if (isSessionEnd) {
        return false;
      }
      if (vetoes > 0) {
        vetoes--;
        return false;
      }
    },
    async onWillQuit(reason) {
      log(`onWillQuit:${reason}`);
      if (scenario === "quit-veto") {
        // The hook has no Host API scope, so a host operation fails with INVALID_ARGUMENT.
        const code = await windows.list().then(
          () => "RESOLVED",
          (error: unknown) => codeOf(error),
        );
        log(`onWillQuitHostOperation:${code}`);
      }
    },
    onQuit(reason) {
      log(`onQuit:${reason}`);
    },
    onAllWindowsClosed() {
      log("onAllWindowsClosed");
    },
  },
});

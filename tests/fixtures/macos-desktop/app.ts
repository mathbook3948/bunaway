import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineApp } from "@bunaway/backend";
import windows from "@bunaway/plugin-windows";
import { BunawayError } from "@bunaway/protocol";
import { driver } from "./driver.ts";
import { OPEN_URL, readDesktopFixture } from "./fixture-config.ts";

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
/** Marks the scenario step about to run, so a timed-out script shows how far it got. */
const step = (name: string) => log(`step:${name}`);
const lines = () => readFileSync(logPath, "utf8").trim().split("\n");

const POLL_MS = 10;
/**
 * A first page load that WKWebView leaves stalled is reissued three times and then replaced by a
 * fresh view about 13 s after it started (native/macos/bun/webview-diagnostics.ts), and the
 * replacement still has to load. The wait must outlast that recovery, so it matches the 30 s
 * document deadline that bounds the whole load.
 */
const STEP_TIMEOUT_MS = 30_000;
/** Pause that lets a vetoed or ignored request settle before the next stimulus. */
const SETTLE_MS = 300;
const TICK_MS = 50;
const TICKS_AFTER_ALL_CLOSED = 3;
/** Enough replacements to show that none of the replaced windows stays in `[NSApp windows]`. */
const RECREATIONS = 3;
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
const drive = (action: string, title?: string, value?: string) =>
  driver.drive({
    action: action as "terminate",
    ...(title
      ? {
          title,
        }
      : {}),
    ...(value
      ? {
          value,
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

/**
 * One-line description of a failed scenario script for the `script-failed:` log line. Unlike
 * `codeOf`, it keeps the free text: the log is a test artifact, and a bare `INTERNAL` from the host
 * hides which operation failed and why. A BunawayError contributes its code, message and details,
 * any other error its name and message, and both add the cause when one exists.
 */
function describeFailure(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof BunawayError) {
    parts.push(
      `${error.name} code=${error.code} message=${error.message} details=${JSON.stringify(error.details)}`,
    );
  } else if (error instanceof Error) {
    parts.push(`${error.name}: ${error.message}`);
  } else {
    parts.push(String(error));
  }
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause !== undefined) {
    const causeCode = Reflect.get(Object(cause), "code");
    parts.push(
      `cause=${String(cause)}${causeCode === undefined ? "" : ` causeCode=${String(causeCode)}`}`,
    );
  }
  return parts.join(" ").replaceAll(/\s*\n\s*/g, " ");
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
    step("wait-main-page");
    await until(logged("page:main"), "the main page");
    // `[NSApp terminate:]`, as the Quit menu item does, is vetoed once.
    step("terminate");
    await drive("terminate");
    step("wait-first-before-quit");
    await until(logged("beforeQuit:quit-command"), "the first beforeQuit");
    step("wait-round-trip-after-veto");
    await until(
      logged("pageRoundTrip:quit-veto"),
      "a page command after the veto",
    );
    await Bun.sleep(SETTLE_MS);
    // The Dock's Quit item arrives as an Apple event without a quit reason.
    step("quit-event");
    await drive("quitEvent");
  },
  async "last-window"() {
    step("wait-main-page");
    await until(logged("page:main"), "the main page");
    step("wait-observer-page");
    await until(logged("page:observer"), "the observer page");
    step("close-main");
    await drive("close", "main");
    step("wait-main-destroyed");
    await until(logged("lifecycle:destroyed:main"), "main destroyed");
    // The observer window is now the last one.
    step("close-observer");
    await drive("close", "observer");
  },
  async "keep-alive"() {
    step("wait-main-page");
    await until(logged("page:main"), "the main page");
    step("wait-observer-page");
    await until(logged("page:observer"), "the observer page");
    log(`mainWindow:before:${await windowIdOf("main")}`);
    step("close-main");
    await drive("close", "main");
    step("wait-main-destroyed");
    await until(logged("lifecycle:destroyed:main"), "main destroyed");
    step("close-observer");
    await drive("close", "observer");
    step("wait-all-windows-closed");
    await until(logged("onAllWindowsClosed"), "onAllWindowsClosed");
    // The backend keeps running with no window left.
    step("wait-ticks");
    const ticksWhenEmpty = ticks;
    await until(
      () => ticks >= ticksWhenEmpty + TICKS_AFTER_ALL_CLOSED,
      "backend ticks after onAllWindowsClosed",
    );
    log(`tickAfterAllClosed:${ticks - ticksWhenEmpty}`);
    // A real reopen Apple event brings back a new window instead of the closed one.
    step("reopen");
    await drive("reopen");
    step("wait-recreated-main");
    const recreated = await waitFor(
      () => windowIdOf("main"),
      "a recreated main window",
    );
    log(`mainWindow:after:${recreated}`);
    step("quit-event");
    await drive("quitEvent");
  },
  async "close-lifecycle"() {
    step("wait-main-page");
    await until(logged("page:main"), "the main page");
    step("wait-observer-page");
    await until(logged("page:observer"), "the observer page");
    // The observer subscribes after main's first creation. Recreating main gives it a complete
    // created, ready, closed and destroyed sequence to watch.
    step("recreate-main");
    await windows.recreate({
      view: "main",
    });
    step("wait-recreated-main-page");
    await until(loggedTimes("page:main", 2), "the recreated main page");
    step("wait-recreated-main-ready");
    await until(
      loggedTimes("lifecycle:ready:main", 1),
      "the recreated main ready",
    );
    step("wait-replaced-main-destroyed");
    await until(
      loggedTimes("lifecycle:destroyed:main", 1),
      "the replaced main destroyed",
    );
    // The main page declines its first close request and accepts the second. While the first is
    // pending, the page asks us (test.pendingClose) to probe it.
    step("close-main-to-decline");
    await drive("close", "main");
    step("wait-decline");
    await until(logged("answered:main:decline"), "the declined close");
    step("count-visible-windows");
    log(`visibleAfterDecline:${await drive("visibleWindows")}`);
    step("close-main-to-accept");
    await drive("close", "main");
    step("wait-main-destroyed");
    await until(loggedTimes("lifecycle:destroyed:main", 2), "main destroyed");
    // Closing the last window then asks beforeQuit and ends the app.
    step("close-observer");
    await drive("close", "observer");
  },
  async "recreate-release"() {
    step("wait-main-page");
    await until(logged("page:main"), "the main page");
    step("wait-observer-page");
    await until(logged("page:observer"), "the observer page");
    for (let round = 1; round <= RECREATIONS; round++) {
      step(`recreate-main-${round}`);
      await windows.recreate({
        view: "main",
      });
      step(`wait-recreated-main-page-${round}`);
      await until(
        loggedTimes("page:main", round + 1),
        `the main page after recreation ${round}`,
      );
      step(`wait-replaced-main-destroyed-${round}`);
      await until(
        loggedTimes("lifecycle:destroyed:main", round),
        `the replaced main destroyed after recreation ${round}`,
      );
    }
    // The host released every replaced window. AppKit deallocates them on a later turn, so poll
    // until the list holds only the live one instead of reading it once.
    step("wait-replaced-windows-deallocated");
    let listed = 0;
    try {
      await waitFor(async () => {
        listed = await drive("windowCount", "main");
        return listed === 1 ? listed : undefined;
      }, "one window titled main in [NSApp windows]");
    } catch (error) {
      throw new Error(
        `${String(error)} Last count: ${listed}, after ${RECREATIONS} recreations.`,
        {
          cause: error,
        },
      );
    }
    log(`mainWindowCount:${listed}`);
    step("close-main");
    await drive("close", "main");
    step("wait-main-destroyed");
    await until(
      loggedTimes("lifecycle:destroyed:main", RECREATIONS + 1),
      "main destroyed",
    );
    step("close-observer");
    await drive("close", "observer");
  },
  async "open-urls"() {
    step("wait-main-page");
    await until(logged("page:main"), "the main page");
    step("open-url");
    await drive("openUrl", undefined, OPEN_URL);
    step("wait-open-url");
    await until(logged(`openedUrl:${OPEN_URL}`), "the URL scheme open");
    // A file with a space and a non-ASCII name, in a real path so no symlink changes its spelling.
    const folder = mkdtempSync(
      resolve(realpathSync(tmpdir()), "bunaway-open-"),
    );
    const file = resolve(folder, "open file \u00e9.txt");
    writeFileSync(file, "");
    log(`openFileExpected:${pathToFileURL(file).href}`);
    step("open-file");
    await drive("openFile", undefined, file);
    step("wait-open-file");
    await until(
      () => lines().some((line) => line.startsWith("openedUrl:file:")),
      "the document open",
    );
    step("quit-event");
    await drive("quitEvent");
  },
  async "reopen-handler"() {
    step("wait-main-page");
    await until(logged("page:main"), "the main page");
    step("wait-observer-page");
    await until(logged("page:observer"), "the observer page");
    // A reopen while windows are visible reaches the app and creates nothing.
    step("reopen-visible");
    await drive("reopen");
    await until(logged("onReopen:true"), "onReopen with a visible window");
    await Bun.sleep(SETTLE_MS);
    log(`windowsAfterVisibleReopen:${(await windows.listInstances()).length}`);
    step("close-main");
    await drive("close", "main");
    step("wait-main-destroyed");
    await until(logged("lifecycle:destroyed:main"), "main destroyed");
    step("close-observer");
    await drive("close", "observer");
    step("wait-all-windows-closed");
    await until(logged("onAllWindowsClosed"), "onAllWindowsClosed");
    // With onReopen registered the host leaves the empty app to the app: no window comes back.
    step("reopen-hidden");
    await drive("reopen");
    await until(logged("onReopen:false"), "onReopen without a visible window");
    await Bun.sleep(SETTLE_MS);
    log(`windowsAfterHiddenReopen:${(await windows.listInstances()).length}`);
    step("quit-event");
    await drive("quitEvent");
  },
  async "session-end"() {
    log("driving-session-end");
    // The quit Apple event that follows the power-off is part of the session end: the host
    // suspends it and replies after cleanup, without blocking the main thread. Both go in one
    // stimulus so the second is not a host call cancelled by the shutdown the first began.
    step("power-off-quit-event");
    await drive("powerOffThenQuitEvent");
  },
  async "session-end-quit-reason"() {
    step("wait-main-page");
    await until(logged("page:main"), "the main page");
    log("driving-session-end");
    // No power-off notification: only the quit reason of the Apple event marks a session end.
    step("quit-event-shut");
    await drive("quitEvent", "shut");
  },
  async "session-end-reply"() {
    step("wait-main-page");
    await until(logged("page:main"), "the main page");
    log("driving-session-end");
    // The stimulus comes from outside: the harness starts quit-event-sender.ts as a separate
    // process once it sees this line, and that process waits for the reply to the quit event.
    step("ready-for-quit-sender");
    log("ready-for-quit-sender");
  },
  async sigterm() {
    step("ready-for-signal");
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
          step("start");
          await script();
        })().catch((error) => {
          log(`script-failed:${describeFailure(error)}`);
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
    ...(scenario === "keep-alive" || scenario === "reopen-handler"
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
    onOpenUrls(urls) {
      log(`onOpenUrls:${urls.length}`);
      for (const url of urls) {
        log(`openedUrl:${url}`);
      }
    },
    // Registered only for the scenario that checks it, so the other scenarios keep the host's own
    // reopen behavior (the keep-alive scenario recreates the window).
    ...(scenario === "reopen-handler"
      ? {
          onReopen(event: { hasVisibleWindows: boolean }) {
            log(`onReopen:${event.hasVisibleWindows}`);
          },
        }
      : {}),
  },
});

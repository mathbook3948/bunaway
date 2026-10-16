import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DesktopContext,
  DesktopOptions,
  OpenRequest,
  QuitReason,
  ShutdownReason,
} from "@bunaway/core";
import {
  AUTOSTART_ARGUMENT,
  AUTOSTART_HIDDEN_ARGUMENT,
} from "@bunaway/protocol";
import type { WindowSpec } from "@bunaway/runtime-bun/window-config";
import type { LaunchArguments } from "./instance.ts";

/** Consume only the registration prefix; later and positional marker strings remain app input. */
export function desktopLaunch(argv: readonly string[]) {
  const hidden = argv[0] === AUTOSTART_HIDDEN_ARGUMENT;
  const autostart = hidden || argv[0] === AUTOSTART_ARGUMENT;
  return {
    launchReason: autostart ? ("autostart" as const) : ("manual" as const),
    hidden,
    argv: autostart ? argv.slice(1) : argv,
  };
}

/** Reject a windowless start without an explicit lifetime owner before starting native resources. */
export function validateDesktopStartup(
  windows: readonly WindowSpec[],
  options: DesktopOptions | undefined,
  hidden = false,
): void {
  if (hidden && !options?.tray) {
    throw new Error(
      "Hidden autostart requires desktop.tray in the app definition.",
    );
  }
  if (
    !windows.some((spec) => spec.startup !== false) &&
    !options?.tray &&
    options?.closeBehavior !== "keep-alive"
  ) {
    throw new Error(
      "app.windows has no startup window; configure desktop.tray or desktop.closeBehavior: keep-alive in the app definition.",
    );
  }
}

/**
 * Splits launch arguments into an immutable request.
 * In files-and-urls mode, relative files resolve against the launch directory
 * and arguments after -- are positional. Raw mode skips metadata derivation.
 */
export function openRequest(
  input: LaunchArguments,
  source: OpenRequest["source"],
  mode: NonNullable<DesktopOptions["openArguments"]> = "files-and-urls",
): OpenRequest {
  const urls: string[] = [];
  const files: string[] = [];
  const launch = desktopLaunch(input.argv);
  let positional = false;
  for (const arg of mode === "raw" ? [] : launch.argv) {
    if (!positional && arg === "--") {
      positional = true;
      continue;
    }
    if (!positional && arg.startsWith("-")) {
      continue;
    }
    // Drive paths are files, including drive-relative paths such as C:notes.txt.
    if (!/^[a-z]:/i.test(arg) && /^[a-z][a-z0-9+.-]*:/i.test(arg)) {
      const url = new URL(arg);
      if (url.protocol === "file:") {
        const path = fileURLToPath(url, {
          windows: true,
        });
        if (path.includes("\0")) {
          throw new Error("File URL must not contain NUL");
        }
        files.push(path);
      } else {
        urls.push(url.href);
      }
    } else {
      files.push(win32.resolve(input.cwd, arg));
    }
  }
  return Object.freeze({
    source,
    launchReason: launch.launchReason,
    argv: Object.freeze([
      ...launch.argv,
    ]),
    cwd: input.cwd,
    urls: Object.freeze(urls),
    files: Object.freeze(files),
  });
}

/** Longest wait for each of onWillQuit and onQuit before shutdown continues without it. */
export const WILL_QUIT_DEADLINE_MS = 3000;

/**
 * Serializes app callbacks (ready, open, all-windows-closed), runs the app's
 * before-quit shutdown gate, and delivers the shutdown notifications once.
 */
export class DesktopLifecycle {
  readonly context: DesktopContext;
  private quitting: Promise<boolean> | undefined;
  private stopped = false;
  private callbacks = Promise.resolve();
  private pending = 0;
  /** First committed shutdown cause; later causes never replace it. */
  private shutdownReason: ShutdownReason | undefined;
  private willQuitDone = false;
  private quitDone = false;
  /**
   * @param stop Asks the host to begin shutdown after a quit is approved.
   * @param report Receives callback failures and hook timeouts without ending the app.
   * @param hookDeadlineMs Wait limit for onWillQuit and onQuit; a parameter so tests need no real wait.
   */
  constructor(
    readonly options: DesktopOptions | undefined,
    control: (action: "show" | "hide") => Promise<void>,
    private readonly stop: () => void,
    private readonly report: (error: unknown) => void,
    private readonly hookDeadlineMs = WILL_QUIT_DEADLINE_MS,
  ) {
    if (
      options !== undefined &&
      (!options || typeof options !== "object" || Array.isArray(options))
    ) {
      throw new Error("desktop must be an options object");
    }
    if (options?.closeBehavior === "hide" && !options.tray) {
      throw new Error("desktop.closeBehavior hide requires a tray");
    }
    if (
      options?.closeBehavior !== undefined &&
      ![
        "quit",
        "hide",
        "keep-alive",
      ].includes(options.closeBehavior)
    ) {
      throw new Error("Invalid desktop.closeBehavior");
    }
    if (
      options?.openArguments !== undefined &&
      options.openArguments !== "files-and-urls" &&
      options.openArguments !== "raw"
    ) {
      throw new Error("Invalid desktop.openArguments");
    }
    if (
      options?.tray !== undefined &&
      (!options.tray ||
        typeof options.tray !== "object" ||
        Array.isArray(options.tray) ||
        typeof options.tray.tooltip !== "string" ||
        !options.tray.tooltip ||
        options.tray.tooltip.length > 127 ||
        /[\0\uD800-\uDFFF]/u.test(options.tray.tooltip))
    ) {
      throw new Error("Invalid desktop.tray.tooltip");
    }
    for (const name of [
      "onReady",
      "onOpen",
      "onAllWindowsClosed",
      "beforeQuit",
      "onWillQuit",
      "onQuit",
    ] as const) {
      if (
        options?.[name] !== undefined &&
        typeof options[name] !== "function"
      ) {
        throw new Error(`desktop.${name} must be a function`);
      }
    }
    this.context = Object.freeze({
      show: () => (this.ending ? Promise.resolve() : control("show")),
      hide: () => {
        if (!options?.tray) {
          return Promise.reject(new Error("Hiding requires a tray"));
        }
        return this.ending ? Promise.resolve() : control("hide");
      },
      quit: () => this.quit("api"),
    });
  }
  /**
   * Queues an open callback, showing the app first for second instances.
   * Reports callback errors and keeps processing later opens.
   * Throws if stopped or full.
   */
  open(input: LaunchArguments, source: OpenRequest["source"]): void {
    if (this.ending || this.pending >= 64) {
      throw new Error("Desktop open queue unavailable");
    }
    this.pending++;
    void this.enqueue(async () => {
      if (source === "second-instance" && !desktopLaunch(input.argv).hidden) {
        await this.context.show();
      }
      await this.options?.onOpen?.(
        openRequest(input, source, this.options?.openArguments),
        this.context,
      );
    }).finally(() => {
      this.pending--;
    });
  }
  /**
   * Queues onReady once the backend and UI Worker are up. Call it before the
   * initial open so that open callbacks start after onReady settles.
   */
  ready(): void {
    this.enqueue(async () => {
      await this.options?.onReady?.(this.context);
    });
  }
  /** Queues onAllWindowsClosed after the UI reports the last live window closed. */
  windowsEmpty(): void {
    this.enqueue(async () => {
      await this.options?.onAllWindowsClosed?.(this.context);
    });
  }
  /**
   * Records the shutdown cause for onWillQuit and onQuit. The first cause wins,
   * so a signal during a pending quit check or a UI close report cannot be
   * reported twice. It also stops queued callbacks and later quit requests.
   */
  commitShutdown(reason: ShutdownReason): void {
    this.shutdownReason ??= reason;
  }
  /**
   * Runs onWillQuit once for an orderly shutdown, before Core and windows stop.
   * Does nothing when no shutdown cause was committed (a host failure).
   */
  async willQuit(): Promise<void> {
    const reason = this.shutdownReason;
    if (reason === undefined || this.willQuitDone) {
      return;
    }
    this.willQuitDone = true;
    await this.runShutdownHook("onWillQuit", this.options?.onWillQuit, reason);
  }
  /** Runs onQuit once after Core and the Workers stopped; skipped without a committed cause. */
  async quitCompleted(): Promise<void> {
    const reason = this.shutdownReason;
    if (reason === undefined || this.quitDone) {
      return;
    }
    this.quitDone = true;
    await this.runShutdownHook("onQuit", this.options?.onQuit, reason);
  }
  private get ending(): boolean {
    return this.stopped || this.shutdownReason !== undefined;
  }
  /**
   * Appends a task to the callback queue. The task is skipped once shutdown
   * started. Failures are reported and never block later tasks. The returned
   * promise settles after the task and never rejects.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.callbacks = this.callbacks
      .then(async () => {
        if (this.ending) {
          return;
        }
        await task();
      })
      .catch(this.report);
    return this.callbacks;
  }
  /**
   * Awaits a shutdown hook up to the deadline. A failure or timeout is
   * reported and shutdown continues; a hook that finishes late is ignored.
   */
  private async runShutdownHook(
    name: "onWillQuit" | "onQuit",
    hook: ((reason: ShutdownReason) => void | Promise<void>) | undefined,
    reason: ShutdownReason,
  ): Promise<void> {
    if (!hook) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), this.hookDeadlineMs);
    });
    // Wrapping in an async function turns a synchronous throw into a rejection.
    const running = (async () => hook.call(this.options, reason))();
    try {
      if (
        (await Promise.race([
          running,
          expired,
        ])) === "expired"
      ) {
        // Observe the late outcome so a hook that fails after the deadline is not unhandled.
        running.catch(() => {});
        this.report(
          new Error(
            `desktop.${name} did not finish in ${this.hookDeadlineMs} ms`,
          ),
        );
      }
    } catch (error) {
      this.report(error);
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * Shares concurrent quit checks.
   * Returns false if before-quit vetoes or fails. A veto or failure that settles after a
   * non-cancellable shutdown was committed (for example a session end) is moot
   * and returns true, so the host never reports a cancelled quit for it. A failure is
   * still reported.
   */
  quit(reason: QuitReason): Promise<boolean> {
    if (this.ending) {
      return Promise.resolve(true);
    }
    if (this.quitting) {
      return this.quitting;
    }
    this.quitting = Promise.resolve()
      .then(async () => {
        try {
          const vetoed = (await this.options?.beforeQuit?.(reason)) === false;
          // A shutdown that cannot be cancelled (session end, window destruction, interrupt)
          // may commit while the app is still deciding; its veto no longer has any effect.
          if (this.ending) {
            return true;
          }
          if (vetoed) {
            return false;
          }
          this.commitShutdown(reason);
          this.stopped = true;
          this.stop();
          return true;
        } catch (error) {
          this.report(error);
          // A failure after a non-cancellable shutdown committed cannot cancel it.
          return this.ending;
        }
      })
      .finally(() => {
        this.quitting = undefined;
      });
    return this.quitting;
  }
  /** Prevents a pending before-quit check from initiating another shutdown. */
  dispose() {
    this.stopped = true;
  }
}

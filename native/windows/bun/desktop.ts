import { win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  DesktopContext,
  DesktopOptions,
  OpenRequest,
  QuitReason,
  ReopenEvent,
  ShutdownReason,
} from "@bunaway/core";
import {
  AUTOSTART_ARGUMENT,
  AUTOSTART_HIDDEN_ARGUMENT,
  BunawayError,
} from "@bunaway/protocol";
import type { WindowSpec } from "@bunaway/runtime-bun/window-config";
import {
  MAX_LAUNCH_ARGUMENT_BYTES,
  MAX_LAUNCH_ARGUMENTS,
  MAX_PROCESS_EXIT_CODE,
} from "@bunaway/runtime-bun/worker-channel";
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

/** Launch arguments split into the immutable open request and the ordered `onOpenUrls` list. */
export type ParsedLaunch = {
  readonly request: OpenRequest;
  readonly openUrls: readonly string[];
};

/** Converts a Windows path to its canonical file URL, including UNC paths. */
function windowsFileUrl(path: string): string {
  return pathToFileURL(path, {
    windows: true,
  }).href;
}

/**
 * Parses launch arguments in one pass into an immutable request and the ordered
 * absolute URL list for onOpenUrls (files as file URLs, other URLs normalized).
 * In files-and-urls mode, relative files resolve against the launch directory
 * and arguments after -- are positional. Raw mode skips metadata derivation
 * and yields no URLs. An invalid URL or a file URL containing NUL throws.
 */
export function parseLaunch(
  input: LaunchArguments,
  source: OpenRequest["source"],
  mode: NonNullable<DesktopOptions["openArguments"]> = "files-and-urls",
): ParsedLaunch {
  const urls: string[] = [];
  const files: string[] = [];
  const openUrls: string[] = [];
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
        openUrls.push(windowsFileUrl(path));
      } else {
        urls.push(url.href);
        openUrls.push(url.href);
      }
    } else {
      const path = win32.resolve(input.cwd, arg);
      files.push(path);
      openUrls.push(windowsFileUrl(path));
    }
  }
  return {
    request: Object.freeze({
      source,
      launchReason: launch.launchReason,
      argv: Object.freeze([
        ...launch.argv,
      ]),
      cwd: input.cwd,
      urls: Object.freeze(urls),
      files: Object.freeze(files),
    }),
    openUrls: Object.freeze(openUrls),
  };
}

/** Splits launch arguments into an immutable request; see {@link parseLaunch}. */
export function openRequest(
  input: LaunchArguments,
  source: OpenRequest["source"],
  mode: NonNullable<DesktopOptions["openArguments"]> = "files-and-urls",
): OpenRequest {
  return parseLaunch(input, source, mode).request;
}

/** Longest wait for each of onWillQuit and onQuit before shutdown continues without it. */
export const WILL_QUIT_DEADLINE_MS = 3000;

/** App-requested relaunch: `argv` is undefined when the initial launch arguments are reused. */
export type RelaunchRequest = {
  readonly argv: readonly string[] | undefined;
};

/** What an approved shutdown asks of the host besides stopping. */
export type ShutdownRequest = {
  readonly exitCode?: number;
  readonly relaunch?: RelaunchRequest;
};

/** A request with its defaults resolved, so overlapping requests can be compared. */
type ResolvedRequest = {
  readonly exitCode: number;
  readonly relaunch: boolean;
  readonly argv: readonly string[] | undefined;
};

function resolveRequest(request: ShutdownRequest): ResolvedRequest {
  return {
    exitCode: request.exitCode ?? 0,
    relaunch: request.relaunch !== undefined,
    argv: request.relaunch?.argv,
  };
}

function sameRequest(a: ResolvedRequest, b: ResolvedRequest): boolean {
  return (
    a.exitCode === b.exitCode &&
    a.relaunch === b.relaunch &&
    (a.argv === b.argv ||
      (a.argv !== undefined &&
        b.argv !== undefined &&
        a.argv.length === b.argv.length &&
        a.argv.every((arg, index) => arg === b.argv?.[index])))
  );
}

function invalidArgument(message: string): BunawayError {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/** Returns a valid exit code (0 when omitted) or throws `INVALID_ARGUMENT`. */
export function validateExitCode(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_PROCESS_EXIT_CODE
  ) {
    throw invalidArgument(
      `exitCode must be an integer from 0 to ${MAX_PROCESS_EXIT_CODE}`,
    );
  }
  return value;
}

/** Checks that options for quit() or relaunch() are absent or a plain object. */
function optionsObject(options: unknown): Record<string, unknown> {
  if (options === undefined) {
    return {};
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw invalidArgument("options must be an object");
  }
  return options as Record<string, unknown>;
}

/** Builds the shutdown request, setting `exitCode` only when the caller gave one. */
function shutdownRequest(
  options: Record<string, unknown>,
  relaunch?: RelaunchRequest,
): ShutdownRequest {
  return {
    ...(options.exitCode === undefined
      ? {}
      : {
          exitCode: validateExitCode(options.exitCode),
        }),
    ...(relaunch
      ? {
          relaunch,
        }
      : {}),
  };
}

/** Copies and checks relaunch arguments with the same limits as forwarded launches. */
function relaunchArguments(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_LAUNCH_ARGUMENTS) {
    throw invalidArgument("Invalid relaunch argv");
  }
  // Array.from turns holes of a sparse array into undefined, which the string check rejects.
  const copy: unknown[] = Array.from(value);
  if (
    !copy.every((arg) => typeof arg === "string" && !arg.includes("\0")) ||
    Buffer.byteLength(JSON.stringify(copy)) > MAX_LAUNCH_ARGUMENT_BYTES
  ) {
    throw invalidArgument("Invalid relaunch argv");
  }
  return Object.freeze(copy as string[]);
}

/** Most queued open requests, and most OS URL requests buffered before ready. */
const MAX_PENDING_OPENS = 64;

/**
 * Serializes app callbacks (ready, open, open URLs, reopen, all-windows-closed), runs the app's
 * before-quit shutdown gate, and delivers the shutdown notifications once.
 */
export class DesktopLifecycle {
  readonly context: DesktopContext;
  private quitting: Promise<boolean> | undefined;
  /** What the pending quit check asks for, to decide whether an overlapping request joins it. */
  private pendingRequest: ResolvedRequest | undefined;
  private stopped = false;
  private callbacks = Promise.resolve();
  private pending = 0;
  /** `starting` until ready() runs; OS URL requests are buffered and reopen events dropped meanwhile. */
  private phase: "starting" | "live" = "starting";
  private bufferedUrlRequests: (readonly string[])[] = [];
  /** The queued `onReopen` event that has not started yet; later reopens replace it. */
  private pendingReopen: ReopenEvent | undefined;
  /** First committed shutdown cause; later causes never replace it. */
  private shutdownReason: ShutdownReason | undefined;
  private willQuitDone = false;
  private quitDone = false;
  /** Exit code of the first committed shutdown; exit() replaces it once. */
  private committedExitCode: number | undefined;
  /** True after exit(): shutdown hooks are skipped and the code is final. */
  private forced = false;
  private relaunchRequested: RelaunchRequest | undefined;
  /**
   * @param stop Asks the host to begin shutdown after a quit is approved.
   * @param report Receives callback failures and hook timeouts without ending the app.
   * @param hookDeadlineMs Wait limit for onWillQuit and onQuit; a parameter so tests need no real wait.
   * @param relaunchSupported False on a host that cannot restart itself; `relaunch()` then rejects `UNSUPPORTED`.
   * @param checkRelaunch Throws `INVALID_ARGUMENT` when the process `relaunch()` would start cannot
   *   be created with these arguments (`undefined` means the initial launch arguments); it runs before
   *   anything is committed.
   */
  constructor(
    readonly options: DesktopOptions | undefined,
    control: (action: "show" | "hide") => Promise<void>,
    private readonly stop: () => void,
    private readonly report: (error: unknown) => void,
    private readonly hookDeadlineMs = WILL_QUIT_DEADLINE_MS,
    relaunchSupported = true,
    checkRelaunch?: (argv: readonly string[] | undefined) => void,
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
      "onOpenUrls",
      "onReopen",
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
    const context: DesktopContext = {
      show: () => (this.ending ? Promise.resolve() : control("show")),
      hide: () => {
        if (!options?.tray) {
          return Promise.reject(new Error("Hiding requires a tray"));
        }
        return this.ending ? Promise.resolve() : control("hide");
      },
      quit: (quitOptions) => {
        // Return the shared quit promise itself, so concurrent callers observe one decision.
        try {
          return this.quit("api", shutdownRequest(optionsObject(quitOptions)));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      exit: (exitCode) => this.exit(exitCode),
      relaunch: async (relaunchOptions) => {
        if (!relaunchSupported) {
          throw new BunawayError({
            code: "UNSUPPORTED",
            message: "relaunch is not supported on this platform.",
          });
        }
        const parsed = optionsObject(relaunchOptions);
        const argv = relaunchArguments(parsed.argv);
        const request = shutdownRequest(parsed, {
          argv,
        });
        // A request that cannot join the running shutdown resolves false without being applied,
        // so it must not fail on a command line that would never be used.
        if (!this.conflictsWithShutdown(resolveRequest(request))) {
          // Refuse before the shutdown commits: afterwards the caller can no longer be told.
          checkRelaunch?.(argv);
        }
        return this.quit("api", request);
      },
    };
    this.context = Object.freeze(context);
  }
  /**
   * Queues the open callbacks, showing the app first for second instances: onOpen,
   * then onOpenUrls when the arguments yield URLs. Each failure is reported and
   * does not stop the other callback or later opens. A parse failure is reported
   * and neither callback runs. Throws if stopped or full.
   */
  open(input: LaunchArguments, source: OpenRequest["source"]): void {
    this.enqueueCounted(async () => {
      if (source === "second-instance" && !desktopLaunch(input.argv).hidden) {
        await this.context.show();
      }
      const { request, openUrls } = parseLaunch(
        input,
        source,
        this.options?.openArguments,
      );
      try {
        await this.options?.onOpen?.(request, this.context);
      } catch (error) {
        this.report(error);
      }
      if (openUrls.length > 0) {
        await this.options?.onOpenUrls?.(openUrls, this.context);
      }
    });
  }
  /**
   * Queues an open request for already-normalized absolute URLs from the operating
   * system. Before ready() it is buffered without showing the app, and delivered
   * after onReady and the initial open. Afterwards the app is shown first, like a
   * second instance, but unlike open() a failed show is only reported and onOpenUrls still
   * runs, because the operating system delivers these URLs once and they must not be lost to a
   * display failure. An empty list is ignored. Throws if stopped or full.
   */
  openUrls(urls: readonly string[]): void {
    if (this.ending) {
      throw new Error("Desktop open queue unavailable");
    }
    if (urls.length === 0) {
      return;
    }
    const frozen = Object.freeze([
      ...urls,
    ]);
    if (this.phase === "starting") {
      if (this.bufferedUrlRequests.length >= MAX_PENDING_OPENS) {
        throw new Error("Desktop open queue unavailable");
      }
      this.bufferedUrlRequests.push(frozen);
      return;
    }
    this.enqueueCounted(async () => {
      try {
        await this.context.show();
      } catch (error) {
        this.report(error);
      }
      await this.options?.onOpenUrls?.(frozen, this.context);
    });
  }
  /**
   * Queues onReopen with the macOS reopen event. Events before ready() are dropped,
   * because the startup windows are already opening. The host decides what to do
   * when onReopen is not registered.
   *
   * Reopens that arrive while an earlier one is still waiting to start collapse into that queued
   * run, which receives the latest event. A reopen that arrives while onReopen is running queues
   * one more run, so the app always sees the newest state without a backlog building up.
   */
  reopen(event: ReopenEvent): void {
    if (this.phase !== "live") {
      return;
    }
    if (this.pendingReopen) {
      this.pendingReopen = event;
      return;
    }
    this.pendingReopen = event;
    this.enqueue(async () => {
      const latest = this.pendingReopen;
      this.pendingReopen = undefined;
      if (latest) {
        await this.options?.onReopen?.(latest, this.context);
      }
    });
  }
  /**
   * Starts callback delivery once the backend and UI Worker are up. In order it
   * queues onReady, the initial open (when launch arguments are given), and the
   * URL requests buffered by openUrls(), then accepts later requests directly.
   * Open callbacks therefore start after onReady settles. Throws like open() for
   * the initial launch arguments.
   */
  ready(initial?: LaunchArguments): void {
    this.enqueue(async () => {
      await this.options?.onReady?.(this.context);
    });
    if (initial) {
      this.open(initial, "initial");
    }
    const buffered = this.bufferedUrlRequests;
    this.bufferedUrlRequests = [];
    this.phase = "live";
    // The buffer is already bounded, so these bypass the pending limit and cannot throw.
    for (const urls of buffered) {
      this.enqueue(async () => {
        await this.options?.onOpenUrls?.(urls, this.context);
      });
    }
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
   * The exit code and relaunch request of the committing call apply only if it is the first.
   */
  commitShutdown(reason: ShutdownReason, request: ShutdownRequest = {}): void {
    if (reason === "session-end" || reason === "interrupted") {
      // The operating system or the user (Ctrl+C, SIGTERM) is ending the process, even if a
      // relaunch was committed first: a new host must not start against that intent.
      this.relaunchRequested = undefined;
    }
    if (this.shutdownReason !== undefined) {
      return;
    }
    this.shutdownReason = reason;
    this.committedExitCode = request.exitCode;
    this.relaunchRequested = request.relaunch;
  }
  /** Exit code the host reports once cleanup finishes. */
  get exitCode(): number {
    return this.committedExitCode ?? 0;
  }
  /** Relaunch the host performs after `onQuit`; undefined for an ordinary or forced exit. */
  get relaunch(): RelaunchRequest | undefined {
    return this.forced ? undefined : this.relaunchRequested;
  }
  /**
   * Commits an immediate exit: the shutdown hooks are skipped, a pending quit check is moot and
   * the code replaces one chosen by an earlier quit. Cleanup of Core and native resources
   * continues. A repeated exit keeps the first forced code.
   */
  async exit(exitCode?: number): Promise<void> {
    const code = validateExitCode(exitCode);
    if (this.forced) {
      return;
    }
    this.forced = true;
    this.committedExitCode = code;
    this.relaunchRequested = undefined;
    const alreadyStopping = this.stopped;
    this.shutdownReason ??= "api";
    this.stopped = true;
    if (!alreadyStopping) {
      this.stop();
    }
  }
  /**
   * Runs onWillQuit once for an orderly shutdown, before Core and windows stop.
   * Does nothing when no shutdown cause was committed (a host failure).
   */
  async willQuit(): Promise<void> {
    const reason = this.shutdownReason;
    if (reason === undefined || this.willQuitDone || this.forced) {
      return;
    }
    this.willQuitDone = true;
    await this.runShutdownHook("onWillQuit", this.options?.onWillQuit, reason);
  }
  /** Runs onQuit once after Core and the Workers stopped; skipped without a committed cause. */
  async quitCompleted(): Promise<void> {
    const reason = this.shutdownReason;
    if (reason === undefined || this.quitDone || this.forced) {
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
  /** Queues an open task that counts against the pending limit; throws if stopped or full. */
  private enqueueCounted(task: () => Promise<void>): void {
    if (this.ending || this.pending >= MAX_PENDING_OPENS) {
      throw new Error("Desktop open queue unavailable");
    }
    this.pending++;
    void this.enqueue(task).finally(() => {
      this.pending--;
    });
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
   * Returns false if before-quit vetoes or fails, or if an app request overlaps a pending or
   * committed shutdown that asked for a different exit code or relaunch (it is not applied). A veto or failure that settles after a
   * non-cancellable shutdown was committed (for example a session end) is moot
   * and returns true, so the host never reports a cancelled quit for it. A failure is
   * still reported.
   */
  quit(reason: QuitReason, request: ShutdownRequest = {}): Promise<boolean> {
    const wanted = resolveRequest(request);
    // The first shutdown wins, pending or committed. A host-initiated quit (tray, last window)
    // joins it whatever it asked for; an app `api` request joins only if it asks for the same
    // exit code and relaunch. Otherwise it is not applied and resolves false.
    const joins = (current: ResolvedRequest) =>
      reason !== "api" || (!this.forced && sameRequest(wanted, current));
    if (this.ending) {
      return Promise.resolve(joins(this.committedRequest()));
    }
    if (this.quitting && this.pendingRequest) {
      return joins(this.pendingRequest)
        ? this.quitting
        : Promise.resolve(false);
    }
    this.pendingRequest = wanted;
    this.quitting = Promise.resolve()
      .then(async () => {
        try {
          const vetoed = (await this.options?.beforeQuit?.(reason)) === false;
          // A shutdown that cannot be cancelled (session end, window destruction, interrupt)
          // may commit while the app is still deciding; its veto no longer has any effect.
          if (this.ending) {
            return joins(this.committedRequest());
          }
          if (vetoed) {
            return false;
          }
          this.commitShutdown(reason, request);
          this.stopped = true;
          this.stop();
          return true;
        } catch (error) {
          this.report(error);
          // A failure after a non-cancellable shutdown committed cannot cancel it.
          return this.ending && joins(this.committedRequest());
        }
      })
      .finally(() => {
        this.quitting = undefined;
        this.pendingRequest = undefined;
      });
    return this.quitting;
  }
  /**
   * True when an app request could not join the shutdown that is pending or committed. After
   * `exit()` nothing joins, because the hooks the request relies on never run.
   */
  private conflictsWithShutdown(wanted: ResolvedRequest): boolean {
    if (this.forced) {
      return true;
    }
    const current = this.activeRequest();
    return current !== undefined && !sameRequest(wanted, current);
  }
  /** The request the shutdown in progress follows, or undefined while no shutdown runs. */
  private activeRequest(): ResolvedRequest | undefined {
    if (this.ending) {
      return this.committedRequest();
    }
    return this.quitting ? this.pendingRequest : undefined;
  }
  /** The request of the committed shutdown; a shutdown without one asked for the defaults. */
  private committedRequest(): ResolvedRequest {
    return resolveRequest({
      ...(this.committedExitCode === undefined
        ? {}
        : {
            exitCode: this.committedExitCode,
          }),
      ...(this.relaunchRequested
        ? {
            relaunch: this.relaunchRequested,
          }
        : {}),
    });
  }
  /** Prevents a pending before-quit check from initiating another shutdown. */
  dispose() {
    this.stopped = true;
  }
}

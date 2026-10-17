/**
 * `last-window` follows a window close, `tray` follows the tray's Quit action,
 * and `api` follows a call to `DesktopContext.quit()`. `quit-command` is the
 * macOS Quit command: the app menu's Quit item or Cmd+Q, the Dock's Quit, or a
 * quit Apple event that is not a logout, restart or shutdown. Windows never
 * produces it.
 */
export type QuitReason = "last-window" | "tray" | "api" | "quit-command";

/**
 * Why an orderly shutdown was committed. Quit requests keep their `QuitReason`
 * after `beforeQuit` approves them. `window-destroyed` follows a trusted
 * destruction of the last window or an automatic close once no window can
 * remain. `interrupted` follows the development CLI's quit request or a
 * SIGINT/SIGTERM delivered to the host. `session-end` follows the operating
 * system ending the session (shutdown, restart or logoff) and cannot be
 * cancelled: `beforeQuit` is not consulted, no dialog is shown and the host
 * never blocks the session. On Windows it follows WM_ENDSESSION (including a
 * Restart Manager close); on macOS it follows
 * a quit Apple event whose quit reason is logout, restart or shutdown (an
 * NSWorkspaceWillPowerOffNotification may signal it earlier, but is not relied
 * on). `onWillQuit` and the plugin stop hooks must
 * finish within the roughly 4 second wait the host holds the operating
 * system's request open; `onQuit` is not guaranteed because the OS may end the
 * process after that.
 */
export type ShutdownReason =
  | QuitReason
  | "window-destroyed"
  | "session-end"
  | "interrupted";

/** Immutable launch arguments with optional derived URLs and resolved file paths. */
export type OpenRequest = {
  /** `initial` for the first launch, `second-instance` when an existing app is opened again. */
  readonly source: "initial" | "second-instance";
  /** Autostart registration marker or ordinary launch. This is not authenticated OS origin. */
  readonly launchReason: "manual" | "autostart";
  /** App arguments after the executable, development switches and autostart prefix are removed. */
  readonly argv: readonly string[];
  /** Working directory used to resolve relative file arguments. */
  readonly cwd: string;
  /** Non-file URL arguments, normalized to absolute URLs. Empty in raw argument mode. */
  readonly urls: readonly string[];
  /** File arguments and file URLs converted to paths. Empty in raw argument mode. */
  readonly files: readonly string[];
};

/** Describes a macOS reopen request, such as a Dock icon click. */
export type ReopenEvent = {
  /** Whether the app had a visible window when the operating system asked to reopen it. */
  readonly hasVisibleWindows: boolean;
};

/** Options for {@link DesktopContext.quit}. */
export type QuitOptions = {
  /**
   * Process exit code, an integer from 0 to 255 (default 0). It is used only if the quit is
   * approved and no earlier shutdown cause already chose a code; a `beforeQuit` veto discards it.
   * Any other value rejects with `INVALID_ARGUMENT`.
   */
  readonly exitCode?: number;
};

/** Options for {@link DesktopContext.relaunch}. */
export type RelaunchOptions = QuitOptions & {
  /**
   * Arguments for the new process, after the executable. They replace the arguments of the
   * initial launch (without the development switches and autostart prefix), which are the default.
   * At most 256 strings without NUL, 64 KiB of JSON in total. The executable, environment and
   * working directory cannot be changed: the new process starts in the directory the app had at
   * boot.
   */
  readonly argv?: readonly string[];
};

/** Lifecycle controls exposed only to trusted app callbacks. */
export interface DesktopContext {
  /**
   * Requests display and focus of open windows, or creation of the first declared window.
   * An empty catalog is a no-op. Resolves on UI acceptance, before document or SDK readiness.
   */
  show(): Promise<void>;
  /** Hides the app window; rejects when no tray is configured. */
  hide(): Promise<void>;
  /**
   * Requests shutdown and resolves to `false` if a quit hook vetoes it or fails. Runs `beforeQuit`,
   * `onWillQuit`, Core and plugin stop hooks and `onQuit` in order. `true` means the shutdown is
   * committed; when one was already committed, its exit code stays and `options.exitCode` is
   * ignored. Rejects with `INVALID_ARGUMENT` for an exit code outside 0 to 255.
   */
  quit(options?: QuitOptions): Promise<boolean>;
  /**
   * Ends the app without asking: `beforeQuit`, the window close confirmation, `onWillQuit` and
   * `onQuit` are skipped, like Electron's `app.exit`. Core, plugin stop hooks, Workers and child
   * processes are still cleaned up within the host's shutdown limit. The exit code (default 0)
   * replaces one chosen by an earlier quit. Resolves once the exit is committed, before cleanup
   * finishes. Rejects with `INVALID_ARGUMENT` for an exit code outside 0 to 255.
   */
  exit(exitCode?: number): Promise<void>;
  /**
   * Quits like {@link DesktopContext.quit} and then starts a new process of the same app with
   * `options.argv`. Resolves to `false` if a quit hook vetoes it or fails, and then nothing is
   * relaunched. The new process starts after `onQuit` and waits for this one to exit before it
   * takes the single-instance lock. A shutdown already committed by another cause wins, including
   * a plain quit that does not relaunch. The relaunch is skipped when the operating system ends
   * the session or the host fails. Windows only; macOS rejects with `UNSUPPORTED`. Under
   * `bunaway dev` the CLI restarts the host.
   */
  relaunch(options?: RelaunchOptions): Promise<boolean>;
}

/** Optional window-close, tray, open-request, and quit behavior for the desktop app. */
export type DesktopOptions = {
  /**
   * With `quit`, closing the last open window requests app shutdown; closing
   * another window closes only that window. `hide` hides the target window and
   * requires a tray. `keep-alive` closes the window without quitting the app.
   * Closing a window with `keep-alive` does not invoke beforeQuit.
   * A windowless start requires `keep-alive` or a tray. The default is `quit`.
   */
  readonly closeBehavior?: "quit" | "hide" | "keep-alive";
  /** Creates a system tray entry that keeps a windowless app running and offers Open and Quit. */
  readonly tray?: {
    /** Text shown by the operating system for the tray icon. */
    readonly tooltip: string;
  };
  /**
   * `files-and-urls` derives and validates open metadata before onOpen (the default).
   * `raw` delivers app argv with empty files/urls, for app-owned CLI parsing.
   * Framework autostart prefix handling and launchReason still apply in either mode.
   */
  readonly openArguments?: "files-and-urls" | "raw";
  /**
   * Handles initial launches and requests to open another file or URL in the running app.
   * Desktop hooks run outside any Host API scope, so Host API calls made directly in them fail
   * with `INVALID_ARGUMENT`. Call them from a command or a plugin `setup`, or use `context`.
   */
  onOpen?(request: OpenRequest, context: DesktopContext): void | Promise<void>;
  /**
   * Receives the absolute URLs the app was asked to open, in request order. Files arrive as
   * `file:` URLs (the absolute path normalized to a file URL); every other entry is a normalized
   * absolute URL (`new URL(x).href`). It is never called with an empty list, and the array is frozen.
   *
   * On Windows the URLs come from the launch arguments of the initial launch and of each second
   * instance, only in `openArguments: "files-and-urls"` mode; in `raw` mode argv is not interpreted
   * and `onOpenUrls` is not called from argv. On macOS they come from the operating system open
   * requests (Finder, `open`, URL schemes) delivered through AppKit.
   *
   * It runs on the same serialized queue as `onReady` and `onOpen`. Requests that arrive before the
   * app is ready are buffered and delivered after `onReady` and the initial `onOpen`. A thrown or
   * rejected callback is reported and the app keeps running. Desktop hooks run outside any Host API
   * scope, so Host API calls made directly in them fail with `INVALID_ARGUMENT`. Call them from a
   * command or a plugin `setup`, or use `context`.
   */
  onOpenUrls?(
    urls: readonly string[],
    context: DesktopContext,
  ): void | Promise<void>;
  /**
   * macOS only: called when the operating system asks to reopen the running app, such as a Dock icon
   * click (`applicationShouldHandleReopen:hasVisibleWindows:`). Windows never calls it.
   *
   * When registered, the host shows no window itself and the app decides, for example with
   * `context.show()`. When not registered, the host keeps its default: if no window is visible it
   * behaves like `context.show()`. Reopen events that arrive before the app is ready are dropped
   * when `onReopen` is registered, because the startup windows are already opening.
   *
   * It runs on the same serialized queue as `onOpen`. A thrown or rejected callback is reported and
   * the app keeps running. Desktop hooks run outside any Host API scope, so Host API calls made
   * directly in them fail with `INVALID_ARGUMENT`. Call them from a command or a plugin `setup`, or
   * use `context`.
   */
  onReopen?(event: ReopenEvent, context: DesktopContext): void | Promise<void>;
  /**
   * Called once after Core has started, the backend is ready and the UI
   * reported that native creation of the startup windows has begun. This does
   * not mean any document or the SDK is ready. It runs on the same serialized
   * queue as `onOpen` and before the initial `onOpen`, which starts after it
   * settles. A thrown or rejected callback is reported and the app keeps
   * running. It is not called when startup fails or shutdown has begun.
   */
  onReady?(context: DesktopContext): void | Promise<void>;
  /**
   * Called each time the number of open app windows drops to zero while the app
   * keeps running, such as with `closeBehavior: "keep-alive"` or a tray app
   * whose windows were closed without quitting. It is not called when the last
   * close becomes a quit, during shutdown, or for a windowless start that never
   * opened a window. A thrown or rejected callback is reported and the app
   * keeps running.
   */
  onAllWindowsClosed?(context: DesktopContext): void | Promise<void>;
  /** Returning `false` vetoes shutdown; a thrown or rejected callback also cancels it. */
  // biome-ignore lint/suspicious/noConfusingVoidType: async callbacks may allow quitting without an explicit return.
  beforeQuit?(reason: QuitReason): boolean | void | Promise<boolean | void>;
  /**
   * Called once when shutdown is committed: after `beforeQuit` approves, or
   * immediately when the shutdown cannot be cancelled. It runs before Core stops
   * its backend and plugin stop hooks, and before window teardown. The result is
   * ignored and the shutdown cannot be cancelled. The host waits up to 3 seconds,
   * then reports a diagnostic and continues. It runs outside any Host API scope, so
   * a Host API call made directly here fails with `INVALID_ARGUMENT`; work started
   * earlier by a command or plugin setup fails with `CANCELLED` because the
   * host already stopped accepting host calls when the shutdown was committed. Keep it to app-internal cleanup. It is not called when the host fails
   * (for example a startup failure or a UI Worker crash).
   */
  onWillQuit?(reason: ShutdownReason): void | Promise<void>;
  /**
   * Called once after Core and the native Workers have stopped, just before the
   * host returns. It uses the same 3 second limit as `onWillQuit`. It is not
   * guaranteed when the operating system ends the session.
   */
  onQuit?(reason: ShutdownReason): void | Promise<void>;
};

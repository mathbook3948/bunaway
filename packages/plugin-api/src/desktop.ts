/**
 * `last-window` follows a window close, `tray` follows the tray's Quit action,
 * and `api` follows a call to `DesktopContext.quit()`.
 */
export type QuitReason = "last-window" | "tray" | "api";

/**
 * Why an orderly shutdown was committed. Quit requests keep their `QuitReason`
 * after `beforeQuit` approves them. `window-destroyed` follows a trusted
 * destruction of the last window or an automatic close once no window can
 * remain. `interrupted` follows the development CLI's quit request or a
 * SIGINT/SIGTERM delivered to the host. `session-end` follows the Windows
 * WM_ENDSESSION notification (shutdown, restart, logoff or Restart Manager
 * close) and cannot be cancelled: `beforeQuit` is not consulted, no dialog is
 * shown and the host never blocks the session. `onWillQuit` and the plugin
 * stop hooks must finish within the roughly 4 second wait the host holds the
 * window procedure open; `onQuit` is not guaranteed because the OS may end
 * the process after that. macOS has no session-end implementation.
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

/** Lifecycle controls exposed only to trusted app callbacks. */
export interface DesktopContext {
  /**
   * Requests display and focus of open windows, or creation of the first declared window.
   * An empty catalog is a no-op. Resolves on UI acceptance, before document or SDK readiness.
   */
  show(): Promise<void>;
  /** Hides the app window; rejects when no tray is configured. */
  hide(): Promise<void>;
  /** Requests shutdown and resolves to `false` if a quit hook vetoes it or fails. */
  quit(): Promise<boolean>;
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
  /** Handles initial launches and requests to open another file or URL in the running app. */
  onOpen?(request: OpenRequest, context: DesktopContext): void | Promise<void>;
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
   * then reports a diagnostic and continues. It is not called when the host fails
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

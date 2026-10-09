/**
 * `last-window` follows a window close, `tray` follows the tray's Quit action,
 * and `api` follows a call to `DesktopContext.quit()`.
 */
export type QuitReason = "last-window" | "tray" | "api";

/** Immutable launch arguments split into URLs and resolved file paths. */
export type OpenRequest = {
  /** `initial` for the first launch, `second-instance` when an existing app is opened again. */
  readonly source: "initial" | "second-instance";
  /** App arguments after the executable and Bunaway development switches are removed. */
  readonly argv: readonly string[];
  /** Working directory used to resolve relative file arguments. */
  readonly cwd: string;
  /** Non-file URL arguments, normalized to absolute URLs. */
  readonly urls: readonly string[];
  /** File arguments and file URLs converted to paths. */
  readonly files: readonly string[];
};

/** Lifecycle controls exposed only to trusted app callbacks. */
export interface DesktopContext {
  /** Shows and focuses the app's open windows. */
  show(): Promise<void>;
  /** Hides the app window; rejects when no tray is configured. */
  hide(): Promise<void>;
  /** Requests shutdown and resolves to `false` if a quit hook vetoes it or fails. */
  quit(): Promise<boolean>;
}

/** Optional window-close, tray, open-request, and quit behavior for the desktop app. */
export type DesktopOptions = {
  /**
   * Closing a window quits the app or hides it in the tray. `hide` requires a
   * tray and the default is `quit`.
   */
  readonly closeBehavior?: "quit" | "hide";
  /** Creates a system tray entry used to reopen or quit a hidden app. */
  readonly tray?: {
    /** Text shown by the operating system for the tray icon. */
    readonly tooltip: string;
  };
  /** Handles initial launches and requests to open another file or URL in the running app. */
  onOpen?(request: OpenRequest, context: DesktopContext): void | Promise<void>;
  /** Returning `false` vetoes shutdown; a thrown or rejected callback also cancels it. */
  // biome-ignore lint/suspicious/noConfusingVoidType: async callbacks may allow quitting without an explicit return.
  beforeQuit?(reason: QuitReason): boolean | void | Promise<boolean | void>;
};

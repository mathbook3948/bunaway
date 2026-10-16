/** Desktop options the AppKit side needs; the backend reports them in the `desktop-config` packet. */
export type MacosDesktopConfig = {
  closeBehavior: "quit" | "keep-alive";
};

/** Reasons the main thread asks the backend to run `beforeQuit` for. */
export type MacosQuitRequestReason = "last-window" | "quit-command";

/**
 * Main-thread state of the app decisions that depend on the backend's `desktop` options: whether a
 * quit request is awaiting `beforeQuit`, and requests that arrived before the options did.
 *
 * AppKit starts before the backend reports its options, so a user can close the last window or press
 * Cmd+Q first. Those requests wait here and run once the options arrive. Signals and session end
 * never use this class because they must not wait for the app.
 */
export class DesktopRequests {
  private config: MacosDesktopConfig | undefined;
  private readonly configuration = Promise.withResolvers<
    MacosDesktopConfig | undefined
  >();
  private readonly deferred = new Set<string>();
  /** Settles when the pending quit request was cancelled or the host began shutting down. */
  private pendingQuit:
    | ReturnType<typeof Promise.withResolvers<void>>
    | undefined;

  constructor(
    private readonly hooks: {
      stopping(): boolean;
      /** Sends one `quit-request` packet to the backend. */
      sendQuitRequest(reason: MacosQuitRequestReason): void;
    },
  ) {}

  /** The reported close behavior, or `undefined` while the backend has not reported yet. */
  get closeBehavior(): MacosDesktopConfig["closeBehavior"] | undefined {
    return this.config?.closeBehavior;
  }

  /** True while a quit request waits for the app's `beforeQuit` answer. */
  get quitPending(): boolean {
    return this.pendingQuit !== undefined;
  }

  /**
   * Resolves with the options once reported, or with `undefined` when the host starts shutting down
   * first. Callers recheck their own state after waiting, because the host may have changed meanwhile.
   */
  configured(): Promise<MacosDesktopConfig | undefined> {
    return this.configuration.promise;
  }

  /** Records the backend's options and releases everything that waited for them. */
  configure(config: MacosDesktopConfig): void {
    if (this.config) {
      return;
    }
    this.config = config;
    this.configuration.resolve(config);
  }

  /**
   * Runs `request` now when the options are known, otherwise once they arrive. Repeated requests
   * with the same key while waiting collapse into one run, so a user pressing a key repeatedly
   * does not queue several actions.
   */
  defer(key: string, request: () => void): void {
    if (this.config) {
      request();
      return;
    }
    if (this.deferred.has(key)) {
      return;
    }
    this.deferred.add(key);
    void this.configuration.promise.then((config) => {
      this.deferred.delete(key);
      if (config && !this.hooks.stopping()) {
        request();
      }
    });
  }

  /**
   * Asks the backend to run `beforeQuit` for `reason`. While a request is pending any further
   * request joins it instead of sending another. The returned promise settles when the app
   * vetoed (see `quitCancelled`) or the host started shutting down (see `abandon`).
   */
  requestQuit(reason: MacosQuitRequestReason): Promise<void> {
    if (this.hooks.stopping()) {
      return Promise.resolve();
    }
    if (!this.pendingQuit) {
      this.pendingQuit = Promise.withResolvers<void>();
      this.hooks.sendQuitRequest(reason);
    }
    return this.pendingQuit.promise;
  }

  /** The app vetoed the pending quit request; the next close or Quit command asks again. */
  quitCancelled(): void {
    this.settleQuit();
  }

  /** Shutdown began: nothing waits for options or an app decision any more. Safe to repeat. */
  abandon(): void {
    this.configuration.resolve(undefined);
    this.settleQuit();
  }

  private settleQuit(): void {
    const pending = this.pendingQuit;
    this.pendingQuit = undefined;
    pending?.resolve();
  }
}

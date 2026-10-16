/** Desktop options the AppKit side needs; the backend reports them in the `desktop-config` packet. */
export type MacosDesktopConfig = {
  closeBehavior: "quit" | "keep-alive";
  /**
   * Whether the app registered `onReopen`. If so a reopen is forwarded to the app, which decides
   * what to show; otherwise the host shows the windows itself.
   */
  reopenHandler: boolean;
};

/**
 * Most open requests that may wait to be handed to the backend, either for its options or behind
 * an earlier request still being acknowledged. Further requests are dropped with a diagnostic.
 */
const MAX_PENDING_OPEN_REQUESTS = 16;

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
  /** Open requests in arrival order that the backend has not accepted yet. */
  private readonly openRequests: (readonly string[])[] = [];
  private draining = false;
  /** Settles when the pending quit request was cancelled or the host began shutting down. */
  private pendingQuit:
    | ReturnType<typeof Promise.withResolvers<void>>
    | undefined;

  constructor(
    private readonly hooks: {
      stopping(): boolean;
      /** Sends one `quit-request` packet to the backend. */
      sendQuitRequest(reason: MacosQuitRequestReason): void;
      /** Delivers one normalized open request to the backend; settles when it accepted it. */
      sendOpenUrls(urls: readonly string[]): Promise<void>;
      /** Records a host diagnostic. */
      diagnostic(event: string, fields: object): void;
    },
  ) {}

  /** The reported close behavior, or `undefined` while the backend has not reported yet. */
  get closeBehavior(): MacosDesktopConfig["closeBehavior"] | undefined {
    return this.config?.closeBehavior;
  }

  /** Whether the app handles reopens itself, or `undefined` while the backend has not reported yet. */
  get reopenHandler(): boolean | undefined {
    return this.config?.reopenHandler;
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
   * Queues an open request for the backend. Unlike `defer`, requests never collapse: each one
   * reaches the backend in arrival order, after the options and one at a time, so the burst a
   * user can cause never exceeds the Worker channel's capacity. At most
   * `MAX_PENDING_OPEN_REQUESTS` wait; later ones are dropped with a diagnostic. `abandon` discards
   * the queue.
   */
  openUrls(urls: readonly string[]): void {
    if (this.hooks.stopping()) {
      return;
    }
    if (this.openRequests.length >= MAX_PENDING_OPEN_REQUESTS) {
      this.hooks.diagnostic("open-urls-dropped", {
        reason: "queue-full",
        count: urls.length,
      });
      return;
    }
    this.openRequests.push(urls);
    void this.drainOpenRequests();
  }

  /** Sends queued open requests one by one once the options are known; a single drain runs at a time. */
  private async drainOpenRequests(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      if (!(await this.configuration.promise)) {
        return;
      }
      for (
        let urls = this.openRequests.shift();
        urls && !this.hooks.stopping();
        urls = this.openRequests.shift()
      ) {
        try {
          await this.hooks.sendOpenUrls(urls);
        } catch (error) {
          // The backend or channel is going away or failed on its own; the host handles that
          // failure elsewhere, so only the lost request is reported.
          this.hooks.diagnostic("open-urls-dropped", {
            reason: "send-failed",
            count: urls.length,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.draining = false;
    }
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

  /** Shutdown began: nothing waits for options, an app decision or the backend any more. Safe to repeat. */
  abandon(): void {
    this.openRequests.length = 0;
    this.configuration.resolve(undefined);
    this.settleQuit();
  }

  private settleQuit(): void {
    const pending = this.pendingQuit;
    this.pendingQuit = undefined;
    pending?.resolve();
  }
}

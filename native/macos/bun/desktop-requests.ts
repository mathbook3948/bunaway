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
 * Most open-urls requests that may wait to be handed to the backend, either for its options or
 * behind an earlier request still being acknowledged. Further open-urls requests are dropped with a
 * diagnostic. Reopen requests do not count: adjacent ones merge, so the queue holds at most one
 * reopen between and around the open requests, `2 * MAX_PENDING_OPEN_REQUESTS + 1` entries in all.
 */
const MAX_PENDING_OPEN_REQUESTS = 16;

/** One request for the backend that arrived from the OS, kept in arrival order until it is sent. */
type DesktopRequest =
  | {
      kind: "open-urls";
      urls: readonly string[];
    }
  | {
      kind: "reopen";
      hasVisibleWindows: boolean;
    };

/** Reasons the main thread asks the backend to run `beforeQuit` for. */
export type MacosQuitRequestReason = "last-window" | "quit-command";

/**
 * Main-thread state of the app decisions that depend on the backend's `desktop` options: whether a
 * quit request is awaiting `beforeQuit`, and open-urls and reopen requests that arrived before the
 * options did or are still being handed to the backend.
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
  /** Open-urls and reopen requests in arrival order that have not been sent to the backend yet. */
  private readonly requests: DesktopRequest[] = [];
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
      /**
       * Delivers one reopen, to the app or to the host's own window handling; settles when the
       * backend accepted it.
       */
      deliverReopen(hasVisibleWindows: boolean): Promise<void>;
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
   * `MAX_PENDING_OPEN_REQUESTS` open requests wait; later ones are dropped with a diagnostic.
   * `abandon` discards the queue.
   */
  openUrls(urls: readonly string[]): void {
    if (this.hooks.stopping()) {
      return;
    }
    const waiting = this.requests.filter(
      (request) => request.kind === "open-urls",
    ).length;
    if (waiting >= MAX_PENDING_OPEN_REQUESTS) {
      this.hooks.diagnostic("open-urls-dropped", {
        reason: "queue-full",
        count: urls.length,
      });
      return;
    }
    this.requests.push({
      kind: "open-urls",
      urls,
    });
    void this.drainRequests();
  }

  /**
   * Queues a reopen in the same arrival order as open requests, so it never overtakes one. It is
   * never dropped, but a reopen directly behind another unsent reopen replaces its
   * `hasVisibleWindows` instead of adding an entry, because only the latest state matters.
   * Unsent reopens are therefore separated by at least one open request, so with at most
   * `MAX_PENDING_OPEN_REQUESTS` open requests the queue holds at most
   * `2 * MAX_PENDING_OPEN_REQUESTS + 1` entries. A reopen already being sent is not merged; the next one waits
   * behind it as a new entry. Before the options arrive the entry waits, so the latest value is used.
   */
  reopen(hasVisibleWindows: boolean): void {
    if (this.hooks.stopping()) {
      return;
    }
    const last = this.requests.at(-1);
    if (last?.kind === "reopen") {
      last.hasVisibleWindows = hasVisibleWindows;
      return;
    }
    this.requests.push({
      kind: "reopen",
      hasVisibleWindows,
    });
    void this.drainRequests();
  }

  /** Sends queued requests one by one once the options are known; a single drain runs at a time. */
  private async drainRequests(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      if (!(await this.configuration.promise)) {
        return;
      }
      for (
        let request = this.requests.shift();
        request && !this.hooks.stopping();
        request = this.requests.shift()
      ) {
        try {
          await this.send(request);
        } catch (error) {
          // The backend or channel is going away or failed on its own; the host handles that
          // failure elsewhere, so only the lost request is reported.
          const message =
            error instanceof Error ? error.message : String(error);
          if (request.kind === "open-urls") {
            this.hooks.diagnostic("open-urls-dropped", {
              reason: "send-failed",
              count: request.urls.length,
              message,
            });
          } else {
            this.hooks.diagnostic("reopen-dropped", {
              reason: "send-failed",
              message,
            });
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private send(request: DesktopRequest): Promise<void> {
    return request.kind === "open-urls"
      ? this.hooks.sendOpenUrls(request.urls)
      : this.hooks.deliverReopen(request.hasVisibleWindows);
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
    this.requests.length = 0;
    this.configuration.resolve(undefined);
    this.settleQuit();
  }

  private settleQuit(): void {
    const pending = this.pendingQuit;
    this.pendingQuit = undefined;
    pending?.resolve();
  }
}

import {
  DOWNLOAD_APPROVAL_TIMEOUT_MS,
  isDownloadSnapshotWithinLimits,
  MAX_WEBVIEW_DOWNLOADS,
  type NativeDownloads,
  type WebViewDownload,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

/** One native operation and optional start deferral. The controller owns final disposal. */
export type DownloadResource = {
  read(): Omit<WebViewDownload, "id" | "paused">;
  decide(allow: boolean): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  /** A failed browser cannot accept deferral completion or cancellation; release references only. */
  dispose(browserGone?: boolean): void;
};

type DownloadEntry = {
  resource?: DownloadResource;
  snapshot: WebViewDownload;
  pending: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

// COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_PAUSED, pinned SDK 1.0.4129.50.
const USER_PAUSED = 28;

/** Bounded, default-denied approval queue and ownership for a single WebView lifetime. */
export class Downloads implements NativeDownloads {
  private enabled = false;
  private closed = false;
  private readonly entries = new Map<string, DownloadEntry>();

  constructor(
    private readonly allowed: (url: string, source: string) => boolean,
    private readonly approvalTimeoutMs = DOWNLOAD_APPROVAL_TIMEOUT_MS,
    private readonly onFailure: (error: unknown) => void = (error) => {
      throw error;
    },
    private readonly onDenied: (url: string) => void = () => {},
  ) {}

  /** Adopt an allowed request, or reject and release it without exposing an approval handle. */
  offer(resource: DownloadResource, source: string): string | null {
    let adopted = false;
    try {
      const state = resource.read();
      if (
        this.closed ||
        !this.enabled ||
        this.entries.size >= MAX_WEBVIEW_DOWNLOADS ||
        !this.allowed(state.url, source)
      ) {
        resource.decide(false);
        this.onDenied(state.url);
        return null;
      }
      const id = crypto.randomUUID();
      const entry: DownloadEntry = {
        resource,
        snapshot: {
          ...state,
          id,
          state: "pending",
          paused: false,
        },
        pending: true,
      };
      if (!this.fits(entry.snapshot)) {
        resource.decide(false);
        this.onDenied(state.url);
        return null;
      }
      this.entries.set(id, entry);
      adopted = true;
      entry.timer = setTimeout(() => {
        // No pending deferral can outlive the bounded approval deadline.
        try {
          this.cancel(id);
        } catch (error) {
          this.onFailure(error);
        }
      }, this.approvalTimeoutMs);
      return id;
    } finally {
      if (!adopted) {
        resource.dispose();
      }
    }
  }

  setRequestsEnabled(enabled: boolean): void {
    this.requireOpen();
    this.enabled = enabled;
    if (!enabled) {
      this.revokePending();
    }
  }

  /** Navigation discards undecided requests; backend-approved operations retain their window owner. */
  revokePending(): void {
    const errors: unknown[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.pending) {
        try {
          this.cancel(id);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Download approval cleanup failed.");
    }
  }

  list(): WebViewDownload[] {
    this.requireOpen();
    return [
      ...this.entries.values(),
    ].map((entry) => {
      this.refresh(entry);
      return {
        ...entry.snapshot,
      };
    });
  }

  approve(id: string): void {
    const entry = this.requireEntry(id);
    if (!entry.pending || !entry.resource) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Download is no longer pending approval.",
      });
    }
    this.clearTimer(entry);
    try {
      entry.resource.decide(true);
      entry.pending = false;
      this.refresh(entry);
    } catch (error) {
      // A failed commit cannot be approved again; preserve ownership if cancellation also fails.
      entry.pending = false;
      const errors: unknown[] = [
        error,
      ];
      try {
        this.cancel(id);
      } catch (cancelError) {
        errors.push(cancelError);
      }
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Download approval failed during cleanup.",
        );
      }
      throw error;
    }
  }

  cancel(id: string): void {
    const entry = this.requireEntry(id);
    this.clearTimer(entry);
    if (!entry.resource) {
      return;
    }
    if (entry.pending) {
      // Disarm approval even if the deferral decision fails. A later cancellation can retry.
      entry.pending = false;
      entry.resource.decide(false);
    } else {
      // Cancellation authority must not depend on a successful metadata read.
      // A failed native Cancel retains the operation and its ID for retry or close cleanup.
      entry.resource.cancel();
      try {
        this.refresh(entry);
      } catch {
        // Native Cancel succeeded. Final metadata is optional; keep the last bounded snapshot.
      }
    }
    if (entry.resource) {
      this.retire(entry, "cancelled");
    }
  }

  pause(id: string): void {
    const entry = this.requireEntry(id);
    this.refresh(entry);
    if (entry.snapshot.paused) {
      return;
    }
    if (
      entry.pending ||
      entry.snapshot.state !== "inProgress" ||
      !entry.resource
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Download is not in progress.",
      });
    }
    entry.resource.pause();
    this.refresh(entry);
  }

  resume(id: string): void {
    const entry = this.requireEntry(id);
    this.refresh(entry);
    if (entry.pending || !entry.snapshot.canResume || !entry.resource) {
      throw new BunawayError({
        code: "BUSY",
        message: "Download cannot be resumed.",
      });
    }
    entry.resource.resume();
    this.refresh(entry);
  }

  forget(id: string): void {
    const entry = this.requireEntry(id);
    this.refresh(entry);
    if (entry.resource) {
      throw new BunawayError({
        code: "BUSY",
        message: "Cancel an unfinished download before forgetting it.",
      });
    }
    this.retire(entry);
    this.entries.delete(id);
  }

  /** Try every cancellation; retain failed resources for retry or observed broker-exit cleanup. */
  dispose(browserGone = false): void {
    if (this.closed) {
      return;
    }
    const errors: unknown[] = [];
    for (const [id, entry] of this.entries) {
      try {
        if (browserGone) {
          entry.pending = false;
          this.retire(entry, "cancelled", true);
        } else {
          this.cancel(id);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      // Keep failed operations owned. The caller may retry, or release after observed broker exit.
      throw new AggregateError(errors, "Download cleanup failed.");
    }
    this.closed = true;
    this.entries.clear();
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "WebView downloads are closed.",
      });
    }
  }

  private requireEntry(id: string): DownloadEntry {
    this.requireOpen();
    const entry = this.entries.get(id);
    if (!entry) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Download does not belong to this WebView lifetime.",
      });
    }
    return entry;
  }

  private refresh(entry: DownloadEntry): void {
    if (!entry.resource || entry.pending) {
      return;
    }
    const state = entry.resource.read();
    const snapshot: WebViewDownload = {
      ...state,
      id: entry.snapshot.id,
      paused:
        state.state === "interrupted" && state.interruptReason === USER_PAUSED,
    };
    const metadataChanged =
      snapshot.url !== entry.snapshot.url ||
      snapshot.mimeType !== entry.snapshot.mimeType ||
      snapshot.contentDisposition !== entry.snapshot.contentDisposition ||
      snapshot.path !== entry.snapshot.path;
    // Scalar progress/state updates already have reserved space; remeasure only changed metadata.
    if (metadataChanged && !this.fits(snapshot, entry)) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Download metadata exceeds the snapshot budget.",
      });
    }
    entry.snapshot = snapshot;
    // WebView2 can automatically retry interruptions. Keep authority until completion or cancel.
    if (entry.snapshot.state === "completed") {
      this.retire(entry);
    }
  }

  private fits(snapshot: WebViewDownload, replacing?: DownloadEntry): boolean {
    return isDownloadSnapshotWithinLimits([
      ...[
        ...this.entries.values(),
      ]
        .filter((entry) => entry !== replacing)
        .map((entry) => entry.snapshot),
      snapshot,
    ]);
  }

  private clearTimer(entry: DownloadEntry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    delete entry.timer;
  }

  private retire(
    entry: DownloadEntry,
    state?: "cancelled",
    browserGone = false,
  ): void {
    this.clearTimer(entry);
    const resource = entry.resource;
    delete entry.resource;
    if (state) {
      entry.snapshot = {
        ...entry.snapshot,
        state,
        canResume: false,
        paused: false,
      };
    }
    resource?.dispose(browserGone);
  }
}

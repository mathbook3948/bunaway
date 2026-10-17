import { NativeEventWaiters } from "@bunaway/plugin";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import { type ClipboardChange, MAX_CHANGE_WAITERS } from "#clipboard/contract";

/** Native listener ownership boundary, shared by the runtime and focused tests. */
export type ChangeDriver = {
  /** Deliver the clipboard sequence number each time Windows reports an update. */
  listen(receive: (sequence: number) => void): void;
  /** Remove the listener and destroy its window. Safe to repeat; may throw after cleanup. */
  dispose(): void;
};

/**
 * Publishes content-free change notifications to the host event stream and to
 * `waitForChange` callers. A missing driver means the host offers no listener
 * window or Windows rejected the registration; waits then fail instead of hanging.
 */
export class ClipboardChanges {
  private readonly waiters = new NativeEventWaiters<ClipboardChange>(
    MAX_CHANGE_WAITERS,
  );
  private lastSequence: number | undefined;
  private disposed = false;

  constructor(
    private readonly driver: ChangeDriver | undefined,
    private readonly emit: (event: string, payload: JsonValue) => void,
    private readonly now: () => number = Date.now,
  ) {
    driver?.listen((sequence) => this.receive(sequence));
  }

  private receive(sequence: number) {
    // Updates queued before dispatch share the latest sequence number; report that state once.
    if (this.disposed || sequence === this.lastSequence) {
      return;
    }
    this.lastSequence = sequence;
    const change = {
      sequence,
      changedAt: this.now(),
    };
    this.waiters.publish(change);
    this.emit("clipboard.changed", change);
  }

  /** Resolve with the next change; earlier changes are not replayed. */
  wait(signal?: AbortSignal): Promise<ClipboardChange> {
    if (!this.driver) {
      return Promise.reject(
        new BunawayError({
          code: "INTERNAL",
          message: "Clipboard change notification is unavailable.",
        }),
      );
    }
    return this.waiters.wait(signal);
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.waiters.dispose();
    this.driver?.dispose();
  }
}

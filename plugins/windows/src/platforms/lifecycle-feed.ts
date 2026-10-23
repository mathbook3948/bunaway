import { NativeEventWaiters } from "@bunaway/plugin";
import type { WindowLifecycleEvent } from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

/** Concurrent `windows.waitForLifecycle` calls accepted per adapter. */
export const MAX_LIFECYCLE_WAITERS = 16;
/** Most recent phases kept so a waiter that re-subscribes with its last `sequence` misses none. */
const LIFECYCLE_HISTORY_LIMIT = 32;

/** A window phase with its position in the order the host published them. */
export type SequencedLifecycleEvent = WindowLifecycleEvent & {
  sequence: number;
};

/**
 * Feeds the backend's `windows.waitForLifecycle` callers with the phases the host publishes to
 * documents. Nothing is sent once the host reports that shutdown has begun.
 */
export class LifecycleFeed {
  private readonly waiters = new NativeEventWaiters<SequencedLifecycleEvent>(
    MAX_LIFECYCLE_WAITERS,
  );
  private readonly history: SequencedLifecycleEvent[] = [];
  private sequence = 0;
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    subscribe:
      | ((listener: (event: WindowLifecycleEvent) => void) => () => void)
      | undefined,
  ) {
    this.unsubscribe = subscribe?.((event) => this.publish(event));
  }

  private publish(event: WindowLifecycleEvent): void {
    const sequenced = {
      sequence: ++this.sequence,
      ...event,
    };
    this.history.push(sequenced);
    if (this.history.length > LIFECYCLE_HISTORY_LIMIT) {
      this.history.shift();
    }
    this.waiters.publish(sequenced);
  }

  /** The first retained phase after `after`, or the next phase published. */
  wait(after: number | undefined, signal?: AbortSignal) {
    if (!this.unsubscribe) {
      return Promise.reject(
        new BunawayError({
          code: "UNSUPPORTED",
          message: "Window lifecycle notification is not available.",
        }),
      );
    }
    const retained =
      after === undefined
        ? undefined
        : this.history.find((event) => event.sequence > after);
    return retained
      ? Promise.resolve(structuredClone(retained))
      : this.waiters.wait(signal);
  }

  dispose(): void {
    this.waiters.dispose();
    this.unsubscribe?.();
  }
}

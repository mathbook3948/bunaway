import { NativeEventWaiters } from "@bunaway/plugin";
import type {
  WindowLifecycleEvent,
  WindowProcessFailureEvent,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

/** Concurrent `windows.waitForLifecycle` calls accepted per adapter (and the same for process failures). */
export const MAX_LIFECYCLE_WAITERS = 16;
/** Most recent events kept so a waiter that re-subscribes with its last `sequence` misses none. */
const LIFECYCLE_HISTORY_LIMIT = 32;

/** A host event with its position in the order the host published them. */
export type Sequenced<Event> = Event & {
  sequence: number;
};

/**
 * Feeds the backend's `windows.waitFor*` callers with the events the host publishes. Nothing is
 * sent once the host reports that shutdown has begun.
 */
export class HostEventFeed<Event extends object> {
  private readonly waiters = new NativeEventWaiters<Sequenced<Event>>(
    MAX_LIFECYCLE_WAITERS,
  );
  private readonly history: Sequenced<Event>[] = [];
  private sequence = 0;
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    subscribe: ((listener: (event: Event) => void) => () => void) | undefined,
    private readonly unavailable: string,
  ) {
    this.unsubscribe = subscribe?.((event) => this.publish(event));
  }

  private publish(event: Event): void {
    const sequenced: Sequenced<Event> = {
      ...event,
      sequence: ++this.sequence,
    };
    this.history.push(sequenced);
    if (this.history.length > LIFECYCLE_HISTORY_LIMIT) {
      this.history.shift();
    }
    this.waiters.publish(sequenced);
  }

  /** The first retained event after `after`, or the next event published. */
  wait(after: number | undefined, signal?: AbortSignal) {
    if (!this.unsubscribe) {
      return Promise.reject(
        new BunawayError({
          code: "UNSUPPORTED",
          message: this.unavailable,
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

/** Window phases for `windows.waitForLifecycle`. */
export class LifecycleFeed extends HostEventFeed<WindowLifecycleEvent> {
  constructor(
    subscribe:
      | ((listener: (event: WindowLifecycleEvent) => void) => () => void)
      | undefined,
  ) {
    super(subscribe, "Window lifecycle notification is not available.");
  }
}

/** WebView process failures for `windows.waitForProcessFailure`. */
export class ProcessFailureFeed extends HostEventFeed<WindowProcessFailureEvent> {
  constructor(
    subscribe:
      | ((listener: (event: WindowProcessFailureEvent) => void) => () => void)
      | undefined,
  ) {
    super(subscribe, "WebView process failure notification is not available.");
  }
}

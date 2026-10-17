import type {
  NativeSystemEvents,
  NativeSystemSignal,
} from "@bunaway/plugin-api/native";
import type { powerEvents } from "#power/contract";

type LifecycleEvent = Exclude<keyof typeof powerEvents, "power.statusChanged">;
type LifecycleSignals = Partial<Record<NativeSystemSignal, LifecycleEvent>>;
type LifecycleSystemEvents = Pick<NativeSystemEvents, "subscribe" | "publish">;

/** Power broadcasts, which need no session notification registration. */
const POWER_SIGNAL_EVENTS: LifecycleSignals = {
  suspend: "power.suspended",
  resume: "power.resumed",
};

/** WTS session notifications, which need an opt-in registration that can fail. */
const SESSION_SIGNAL_EVENTS: LifecycleSignals = {
  sessionLocked: "power.sessionLocked",
  sessionUnlocked: "power.sessionUnlocked",
};

/** Lifecycle events share the status read grant, so no extra permission concept exists. */
const LIFECYCLE_REQUIRED_OPERATION = "power.getStatus";

/** Retry cadence for a session registration that failed, such as right after logon. */
const SESSION_RETRY_INTERVAL_MS = 5_000;
const SESSION_RETRY_WINDOW_MS = 120_000;

/** Timer functions, injectable so retries can be tested without waiting. */
export type LifecycleTimers = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

const defaultTimers: LifecycleTimers = {
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    // A pending retry must not keep the process alive.
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Subscribe to the mapped signals and publish each as its payload-free event. */
function subscribeSignals(
  systemEvents: LifecycleSystemEvents,
  mapping: LifecycleSignals,
  options?: Parameters<NativeSystemEvents["subscribe"]>[1],
): () => void {
  let released = false;
  let unsubscribe: (() => void) | undefined = systemEvents.subscribe(
    (signal) => {
      const event = mapping[signal];
      if (released || !event) {
        return;
      }
      systemEvents.publish(event, {}, LIFECYCLE_REQUIRED_OPERATION);
    },
    options,
  );
  return () => {
    released = true;
    // Keep the subscription when removal fails so a retry can release it.
    unsubscribe?.();
    unsubscribe = undefined;
  };
}

/**
 * Publish `power.suspended`, `power.resumed`, `power.sessionLocked` and `power.sessionUnlocked`.
 *
 * Signals are forwarded in the order the system event service delivers them, with an empty
 * payload. Suspend and resume use one subscription, and failure to create it throws. Lock and
 * unlock come from WTS notifications for the host process's session and use a separate
 * subscription that opts in to session notifications. Registration can fail, for example right
 * after logon before Terminal Services is ready. That failure is logged and registration is
 * retried every few seconds for a bounded period, stopping on success or release. If it never
 * succeeds, only the lock events are lost, so queries, blockers and suspend/resume events keep
 * working, and a second diagnostic is logged.
 * Returns a release function that can be called repeatedly, or undefined when the host has no
 * system event service.
 */
export function watchPowerLifecycle(
  systemEvents?: LifecycleSystemEvents,
  timers: LifecycleTimers = defaultTimers,
): (() => void) | undefined {
  if (!systemEvents) {
    return undefined;
  }
  const releasePower = subscribeSignals(systemEvents, POWER_SIGNAL_EVENTS);
  let releaseSession: (() => void) | undefined;
  let retryTimer: unknown;
  let released = false;
  let retryBudgetMs = SESSION_RETRY_WINDOW_MS;

  const subscribeSession = () => {
    releaseSession = subscribeSignals(systemEvents, SESSION_SIGNAL_EVENTS, {
      sessionNotifications: true,
    });
  };
  const scheduleRetry = () => {
    retryTimer = timers.setTimeout(retrySession, SESSION_RETRY_INTERVAL_MS);
  };
  const retrySession = () => {
    retryTimer = undefined;
    if (released) {
      return;
    }
    retryBudgetMs -= SESSION_RETRY_INTERVAL_MS;
    try {
      subscribeSession();
    } catch (error) {
      if (retryBudgetMs > 0) {
        scheduleRetry();
        return;
      }
      console.error(
        "Session lock and unlock events stay unavailable: session notification registration kept failing.",
        error,
      );
    }
  };

  try {
    subscribeSession();
  } catch (error) {
    console.error(
      "Session lock and unlock events are unavailable: session notification registration failed, retrying.",
      error,
    );
    scheduleRetry();
  }
  return () => {
    released = true;
    if (retryTimer !== undefined) {
      timers.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    const failures: unknown[] = [];
    for (const release of [
      releasePower,
      releaseSession,
    ]) {
      try {
        release?.();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Power lifecycle release failed.");
    }
  };
}

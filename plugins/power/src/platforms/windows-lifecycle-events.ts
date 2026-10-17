import type {
  NativeSystemEvents,
  NativeSystemSignal,
} from "@bunaway/plugin-api/native";
import type { powerEvents } from "#power/contract";

type LifecycleEvent = keyof typeof powerEvents;
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
 * after logon before Terminal Services is ready. That failure is logged and only the lock events
 * are lost, so queries, blockers and suspend/resume events keep working.
 * Returns a release function that can be called repeatedly, or undefined when the host has no
 * system event service.
 */
export function watchPowerLifecycle(
  systemEvents?: LifecycleSystemEvents,
): (() => void) | undefined {
  if (!systemEvents) {
    return undefined;
  }
  const releasePower = subscribeSignals(systemEvents, POWER_SIGNAL_EVENTS);
  let releaseSession: (() => void) | undefined;
  try {
    releaseSession = subscribeSignals(systemEvents, SESSION_SIGNAL_EVENTS, {
      sessionNotifications: true,
    });
  } catch (error) {
    console.error(
      "Session lock and unlock events are unavailable: session notification registration failed.",
      error,
    );
  }
  return () => {
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

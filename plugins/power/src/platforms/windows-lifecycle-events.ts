import type {
  NativeSystemEvents,
  NativeSystemSignal,
} from "@bunaway/plugin-api/native";

/** System signals that map one-to-one to payload-free `power.*` lifecycle events. */
const LIFECYCLE_EVENTS: Partial<Record<NativeSystemSignal, string>> = {
  suspend: "power.suspended",
  resume: "power.resumed",
  sessionLocked: "power.sessionLocked",
  sessionUnlocked: "power.sessionUnlocked",
};

/** Lifecycle events share the status read grant, so no extra permission concept exists. */
const LIFECYCLE_REQUIRED_OPERATION = "power.getStatus";

/**
 * Publish `power.suspended`, `power.resumed`, `power.sessionLocked` and `power.sessionUnlocked`.
 *
 * Signals are forwarded in the order the system event service delivers them, with an empty
 * payload. Lock signals come from WTS notifications for the host process's session, so the
 * subscription opts in to session notifications; registration failure throws. Returns a release
 * function that can be called repeatedly, or undefined when the host has no system event service.
 */
export function watchPowerLifecycle(
  systemEvents?: Pick<NativeSystemEvents, "subscribe" | "publish">,
): (() => void) | undefined {
  if (!systemEvents) {
    return undefined;
  }
  let released = false;
  let unsubscribe: (() => void) | undefined = systemEvents.subscribe(
    (signal) => {
      const event = LIFECYCLE_EVENTS[signal];
      if (released || !event) {
        return;
      }
      systemEvents.publish(event, {}, LIFECYCLE_REQUIRED_OPERATION);
    },
    {
      sessionNotifications: true,
    },
  );
  return () => {
    released = true;
    // Keep the subscription when removal fails so a retry can release it.
    unsubscribe?.();
    unsubscribe = undefined;
  };
}

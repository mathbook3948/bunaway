import type { NativeSystemEvents } from "@bunaway/plugin-api/native";
import type { PowerStatus } from "#power/contract";

/**
 * Publish `power.statusChanged` when the power status differs from the last observed one.
 *
 * The status is read once as the baseline and again after each power status broadcast or resume.
 * Equal snapshots are skipped, so the event reports only differences visible to `power.getStatus`.
 * Changes that Windows does not broadcast (for example some remaining-time estimates) are not observed.
 * Returns a release function that can be called repeatedly, or undefined when the host has no
 * system event service. A failing re-read propagates to the system event dispatcher, keeps the
 * baseline and is retried on the next signal.
 */
export function watchPowerStatus(
  read: () => PowerStatus,
  systemEvents?: Pick<NativeSystemEvents, "subscribe" | "publish">,
): (() => void) | undefined {
  if (!systemEvents) {
    return undefined;
  }
  let lastPublished = JSON.stringify(read());
  let released = false;
  let unsubscribe: (() => void) | undefined = systemEvents.subscribe(
    (signal) => {
      // Status changes during sleep may not be broadcast, so resume reads again.
      if (
        released ||
        (signal !== "powerStatusChanged" && signal !== "resume")
      ) {
        return;
      }
      const next = read();
      const serialized = JSON.stringify(next);
      if (serialized === lastPublished) {
        return;
      }
      systemEvents.publish("power.statusChanged", next, "power.getStatus");
      lastPublished = serialized;
    },
  );
  return () => {
    released = true;
    // Keep the subscription when removal fails so a retry can release it.
    unsubscribe?.();
    unsubscribe = undefined;
  };
}

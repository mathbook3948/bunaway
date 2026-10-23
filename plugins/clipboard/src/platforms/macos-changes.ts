import type { ChangeDriver } from "#clipboard/platforms/changes";

/** NSPasteboard posts no change notification, so the counter is compared on a short interval. */
export const POLL_INTERVAL_MS = 100;

/**
 * Report each change of the pasteboard `changeCount` after the one seen when listening starts.
 *
 * The timer is unreferenced so it never keeps the process alive. A failing read (for example a
 * pasteboard that is going away) keeps the last counter and is retried on the next tick, so no
 * error escapes the timer. Changes that happen between two ticks are reported once.
 */
export function pollPasteboard(
  read: () => number,
  intervalMs: number = POLL_INTERVAL_MS,
): ChangeDriver {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    listen(receive) {
      let last: number | undefined;
      const tick = () => {
        let current: number;
        try {
          current = read();
        } catch {
          return;
        }
        if (last === undefined) {
          last = current;
        } else if (current !== last) {
          last = current;
          receive(current);
        }
      };
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    dispose() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

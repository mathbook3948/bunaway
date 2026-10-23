import type { ChangeDriver } from "#clipboard/platforms/changes";

/**
 * NSPasteboard posts no change notification, so the counter is compared on an interval. One
 * comparison is a single `changeCount` message to the general pasteboard inside an autorelease
 * pool, so ten per second stay far below any visible main-thread cost.
 */
export const POLL_INTERVAL_MS = 100;

/**
 * Report each change of the pasteboard `changeCount` after the one seen when listening starts.
 *
 * The first read happens inside `listen` and its failure propagates, so the baseline is always
 * the counter at start. Later reads that fail (only possible once the pasteboard binding is
 * gone) keep the last counter and are retried on the next tick until `dispose`, which is the
 * only thing that ends polling; no error escapes the timer. Changes between two ticks are
 * reported once. `flush` compares at once, so a caller that is about to wait does not receive a
 * change that was made before it started waiting. The timer is unreferenced so it never keeps
 * the process alive.
 */
export function pollPasteboard(
  read: () => number,
  intervalMs: number = POLL_INTERVAL_MS,
): ChangeDriver {
  let timer: ReturnType<typeof setInterval> | undefined;
  let compare: (() => void) | undefined;
  return {
    listen(receive) {
      let last = read();
      compare = () => {
        let current: number;
        try {
          current = read();
        } catch {
          // Retried on the next tick; the last counter stays the baseline.
          return;
        }
        if (current !== last) {
          last = current;
          receive(current);
        }
      };
      timer = setInterval(compare, intervalMs);
      timer.unref();
    },
    flush() {
      compare?.();
    },
    dispose() {
      compare = undefined;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

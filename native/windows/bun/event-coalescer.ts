/**
 * Keep at most one event in flight per view. A page decides how often it changes the value, so
 * values that arrive while a send is pending collapse to the latest one instead of filling the
 * native event queue, which would fail the view. `send` must call `settled` exactly once when the
 * event was delivered, dropped or refused.
 */
export function createLatestCoalescer<T>(
  send: (value: T, settled: () => void) => void,
): (value: T) => void {
  let sending = false;
  let waiting:
    | {
        value: T;
      }
    | undefined;
  const publish = (value: T): void => {
    sending = true;
    send(value, () => {
      sending = false;
      const next = waiting;
      waiting = undefined;
      if (next !== undefined) {
        publish(next.value);
      }
    });
  };
  return (value) => {
    if (sending) {
      waiting = {
        value,
      };
      return;
    }
    publish(value);
  };
}

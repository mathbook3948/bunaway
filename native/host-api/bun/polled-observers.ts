import type { Packet } from "@bunaway/runtime-bun/worker-channel";

/**
 * Combine several polled-packet observers into the single hook a Channel accepts.
 *
 * Every observer runs for every packet, in argument order, even when an earlier one throws. Each
 * observer only records cancellation intent or ends its own native modal loop, so one failure must
 * not leave another modal loop or a sticky shutdown flag unobserved. After all observers ran, a
 * single failure is rethrown as-is and several are wrapped in an `AggregateError`, so the Channel
 * keeps failing closed when its observer hook throws.
 */
export function composePolledObservers(
  ...observers: ((packet: Packet) => void)[]
): (packet: Packet) => void {
  return (packet) => {
    const errors: unknown[] = [];
    for (const observe of observers) {
      try {
        observe(packet);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Polled packet observers failed.");
    }
  };
}

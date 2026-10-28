import { BunawayError } from "@bunaway/protocol";
import type { Packet } from "@bunaway/runtime-bun/worker-channel";

type PluginEventPacket = Extract<
  Packet,
  {
    kind: "plugin-event";
  }
>;

/**
 * Forwards a plugin event from the I/O Worker to the UI Worker, which owns the view policy and
 * subscriptions that decide who receives it. Awaiting the send passes UI back-pressure on to the
 * I/O Worker.
 *
 * An event that cannot be forwarded is dropped and both Workers keep running: the UI lane being
 * full, or the host already stopping. Any other send failure is returned to the caller as a host
 * failure, because it means the channel itself is broken.
 *
 * @param stopping Whether shutdown began; events arriving then have no receiver left.
 * @param send Delivers the packet to the UI Worker and resolves when it accepted it.
 * @param recordDropped Records how many events the I/O Worker discarded before this one.
 */
export async function relayPluginEvent(
  packet: PluginEventPacket,
  stopping: () => boolean,
  send: (packet: PluginEventPacket) => Promise<void>,
  recordDropped: (dropped: number) => Promise<void>,
): Promise<void> {
  if (packet.dropped > 0) {
    await recordDropped(packet.dropped);
  }
  if (stopping()) {
    return;
  }
  try {
    await send(packet);
  } catch (error) {
    const full = error instanceof BunawayError && error.code === "BUSY";
    if (!full && !stopping()) {
      throw error;
    }
  }
}

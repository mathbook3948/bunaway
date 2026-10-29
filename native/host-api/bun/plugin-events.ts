import type { NativeEventServices } from "@bunaway/plugin";
import {
  BunawayError,
  type JsonValue,
  MAX_MESSAGE_BYTES,
  validateValue,
} from "@bunaway/protocol";
import type { Packet } from "@bunaway/runtime-bun/worker-channel";

type PluginEventPacket = Extract<
  Packet,
  {
    kind: "plugin-event";
  }
>;

/** Same shape the Worker packet validators accept for event and operation names. */
const NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function invalid(message: string): BunawayError {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/** What the I/O Worker needs from its channel to the main thread. */
export type PluginEventSink = {
  /** False before the channel exists and once shutdown has begun; events are then dropped silently. */
  open(): boolean;
  send(packet: PluginEventPacket): Promise<void>;
  /** Reports a failure that is not a full queue; the host treats it as fatal. */
  fail(error: unknown): void;
};

/**
 * Builds the `events` service of I/O Worker plugins. Every plugin may only emit names under its
 * own `<plugin>.` prefix, so one plugin cannot publish into another plugin's event namespace.
 * Core still rejects names the plugin did not declare, and the UI thread rechecks each view's
 * policy and subscription at delivery, exactly as for events raised on the UI thread.
 *
 * Delivery is best effort. `emit` never waits: when the channel lane is full the new event is
 * dropped and counted, and the count travels with the next event that is accepted.
 */
export function createPluginEvents(sink: PluginEventSink): {
  forPlugin(pluginName: string): NativeEventServices;
} {
  let dropped = 0;
  return {
    forPlugin(pluginName) {
      return {
        emit(event, payload: JsonValue, requiredOperation) {
          // Reject here, in the caller's stack: a packet the channel refuses later would be a host failure.
          if (
            !event.startsWith(`${pluginName}.`) ||
            !NAME_PATTERN.test(event)
          ) {
            throw invalid(
              `Plugin ${pluginName} may only emit events named ${pluginName}.*.`,
            );
          }
          if (
            requiredOperation !== undefined &&
            !NAME_PATTERN.test(requiredOperation)
          ) {
            throw invalid("Invalid required operation name.");
          }
          try {
            validateValue({}, payload);
          } catch {
            // The protocol error is not a public error code, so report the caller's mistake instead.
            throw invalid(
              "Plugin event payload must be JSON within the size limit.",
            );
          }
          if (Buffer.byteLength(JSON.stringify(payload)) > MAX_MESSAGE_BYTES) {
            throw invalid(
              "Plugin event payload must be JSON within the size limit.",
            );
          }
          if (!sink.open()) {
            return;
          }
          const carried = dropped;
          dropped = 0;
          sink
            .send({
              kind: "plugin-event",
              event,
              payload,
              requiredOperation: requiredOperation ?? null,
              dropped: carried,
            })
            .catch((error: unknown) => {
              if (!sink.open()) {
                return;
              }
              if (error instanceof BunawayError && error.code === "BUSY") {
                dropped += carried + 1;
                return;
              }
              sink.fail(error);
            });
        },
      };
    },
  };
}

import {
  type JsonValue,
  MAX_JSON_DEPTH,
  MAX_MESSAGE_BYTES,
  PROCESS_IPC_VERSION,
  PROTOCOL_VERSION,
  serializeMessage,
  serializeProcessFrame,
} from "@bunaway/protocol";
import { runBunApp } from "@bunaway/runtime-bun";

const emptyEvent = {
  kind: "event",
  protocol: PROTOCOL_VERSION,
  subscriptionId: "sub-1",
  source: "main",
  target: "main",
  event: "changed",
  sequence: 1,
  payload: "",
} as const;
// Measure the fixed outer frame once so byte-boundary cases target the actual transport limit.
const envelopeBytes = serializeProcessFrame({
  kind: "web",
  context: "view-main-long",
  ipc: PROCESS_IPC_VERSION,
  runtime: {
    id: "event-limits",
    generation: "1",
  },
  payload: emptyEvent,
}).length;

await runBunApp({
  events: {
    changed: {},
  },
  commands: {
    emit: {
      input: {
        enum: [
          "byte-boundary",
          "byte-overflow",
          "message-boundary",
          "depth-boundary",
          "depth-overflow",
          "valid",
        ],
      },
      output: {
        const: null,
      },
      async run(mode, context) {
        let payload: JsonValue;
        switch (mode) {
          case "byte-boundary":
            payload = "x".repeat(MAX_MESSAGE_BYTES - envelopeBytes);
            break;
          case "byte-overflow":
            payload = "x".repeat(MAX_MESSAGE_BYTES - envelopeBytes + 1);
            break;
          case "message-boundary":
            payload = "x".repeat(
              MAX_MESSAGE_BYTES - serializeMessage(emptyEvent).length,
            );
            break;
          case "depth-boundary":
          case "depth-overflow": {
            // The process envelope and event put the payload at depth two.
            const depth = MAX_JSON_DEPTH - (mode === "depth-boundary" ? 2 : 1);
            payload = null;
            for (let index = 0; index < depth; index++) {
              payload = [
                payload,
              ];
            }
            break;
          }
          // A valid follow-up verifies that a rejected payload leaves the runtime usable.
          default:
            payload = "after-rejection";
        }
        await context.events.emit("changed", payload, {
          kind: "broadcast",
        });
        return null;
      },
    },
    ping: {
      input: {
        const: null,
      },
      output: {
        const: null,
      },
      async run() {
        return null;
      },
    },
  },
});

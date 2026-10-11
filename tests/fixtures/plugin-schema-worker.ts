import { parentPort } from "node:worker_threads";
import {
  type JsonValue,
  type NativeRegistration,
  NativeRegistry,
} from "@bunaway/protocol";

if (!parentPort) {
  throw new Error("Expected a Worker message port.");
}
const port = parentPort;
port.on(
  "message",
  (data: { definition: NativeRegistration; values: JsonValue[] }) => {
    const registry = new NativeRegistry([
      data.definition,
    ]);
    port.postMessage(
      data.values.map((value) => {
        try {
          const call = registry.validateCall({
            operation: "worker.echo",
            payload: value,
          });
          return {
            input: call.payload,
            output: registry.validateOutput(call.operation, value),
          };
        } catch {
          return false;
        }
      }),
    );
  },
);

import { parentPort } from "node:worker_threads";
import {
  BunawayError,
  type JsonValue,
  NativeRegistry,
} from "@bunaway/protocol";
import { openerPlugin } from "../../plugins/opener/src/index.ts";
import createOperationsDefinition from "../../plugins/opener/src/index.ts";
import { nativeFactory as createOperationsFactory } from "./native-platform.ts";
const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "macos",
);

const registry = new NativeRegistry([
  openerPlugin,
]);
const adapter = createOperations({
  dataRoot: "/private/tmp",
  capabilities: [],
});
parentPort?.on(
  "message",
  async (packet: {
    id: number;
    operation: string;
    payload: JsonValue;
    permissions: string[];
    cancelled?: boolean;
  }) => {
    try {
      if (packet.operation === "dispose") {
        await adapter.dispose();
        await adapter.dispose();
        parentPort?.postMessage({
          id: packet.id,
          result: null,
        });
        parentPort?.close();
        return;
      }
      // Fixture dispatch mirrors the required host gate, without claiming that
      // the production macOS host already supplies its pending I/O integration.
      const call = registry.validateCall({
        operation: packet.operation,
        payload: packet.payload,
      });
      if (packet.cancelled) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Fixture request cancelled before dispatch.",
        });
      }
      if (
        !registry.allowed(
          {
            permissions: packet.permissions,
          },
          call,
        )
      ) {
        throw new BunawayError({
          code: "PERMISSION_DENIED",
          message: "Fixture operation permission required.",
        });
      }
      parentPort?.postMessage({
        id: packet.id,
        result: await adapter.execute(call.operation, call.payload, "backend"),
      });
    } catch (error) {
      parentPort?.postMessage({
        id: packet.id,
        error: error instanceof BunawayError ? error.code : String(error),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

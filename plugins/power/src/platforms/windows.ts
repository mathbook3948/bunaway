import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { PowerBlockers } from "../blockers.ts";
import { powerOperations } from "../contract.ts";
import { createPower } from "../win32.ts";

/** Own DLLs and power request handles in the host I/O worker. The host checks operation grants. */
export function createOperations(
  _environment: NativeEnvironment,
): NativeAdapter {
  const native = createPower();
  const blockers = new PowerBlockers(native);
  let disposed = false;
  return {
    execute(operation, input) {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Power adapter is disposed.",
        });
      }
      function parse<T>(schema: import("zod").z.ZodType<T>): T {
        const result = schema.safeParse(input);
        if (!result.success) {
          throw new BunawayError({
            code: "INVALID_ARGUMENT",
            message: "Invalid power plugin input.",
          });
        }
        return result.data;
      }
      switch (operation) {
        case "power.getStatus":
          parse(powerOperations.getStatus.input);
          return {
            ...native.status(),
          };
        case "power.getIdleTime":
          parse(powerOperations.getIdleTime.input);
          return native.idle();
        case "power.getIdleState": {
          const payload = parse(powerOperations.getIdleState.input);
          return native.idle() >= payload.thresholdSeconds ? "idle" : "active";
        }
        case "power.startBlocker": {
          const payload = parse(powerOperations.startBlocker.input);
          return {
            ...blockers.start(payload.type, payload.reason),
          };
        }
        case "power.listBlockers":
          parse(powerOperations.listBlockers.input);
          return blockers.list();
        case "power.isBlockerActive":
          return blockers.active(
            parse(powerOperations.isBlockerActive.input).id,
          );
        case "power.stopBlocker":
          return blockers.stop(parse(powerOperations.stopBlocker.input).id);
        default:
          throw new BunawayError({
            code: "UNSUPPORTED",
            message: "Host operation is not registered.",
          });
      }
    },
    dispose() {
      disposed = true;
      // Retain live DLL bindings after failure so the host can retry releasing handles.
      blockers.dispose();
      native.dispose();
    },
  };
}

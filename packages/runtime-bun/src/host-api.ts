import type { CoreServices } from "@bunaway/core";
import {
  BunawayError,
  type CancellationSignal,
  type HostAPI,
  type HostCall,
  type HostContext,
  type HostResponse,
  hostCallSchema,
  hostResponseSchema,
  validateHostOutput,
  validateValue,
} from "@bunaway/protocol";

export function bindHostAPI(
  context: HostContext,
  signal: CancellationSignal,
  callHost: CoreServices["callHost"],
): HostAPI {
  function checkCancelled() {
    if (signal.aborted)
      throw new BunawayError({ code: "CANCELLED", message: "Host operation cancelled." });
  }
  return {
    async call(operation, payload) {
      checkCancelled();
      let call: HostCall;
      try {
        call = validateValue(hostCallSchema, { operation, payload }) as HostCall;
      } catch {
        throw new BunawayError({ code: "INVALID_ARGUMENT", message: "Invalid host request." });
      }
      let response: HostResponse;
      let onAbort = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(new BunawayError({ code: "CANCELLED", message: "Host operation cancelled." }));
        signal.addEventListener("abort", onAbort);
      });
      try {
        response = validateValue(
          hostResponseSchema,
          await Promise.race([
            Promise.resolve().then(() => {
              checkCancelled();
              return callHost(context, call, signal);
            }),
            aborted,
          ]),
        );
      } catch (cause) {
        checkCancelled();
        if (cause instanceof BunawayError) throw cause;
        throw new BunawayError({ code: "INTERNAL", message: "Host operation failed." });
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      checkCancelled();
      if (response.kind === "error") throw new BunawayError(response.error);
      try {
        return validateHostOutput(operation, response.payload);
      } catch {
        throw new BunawayError({ code: "INTERNAL", message: "Invalid host response." });
      }
    },
  };
}

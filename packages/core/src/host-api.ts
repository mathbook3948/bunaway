import {
  BunawayError,
  type CancellationSignal,
  type HostAPI,
  type HostCall,
  type HostContext,
  type HostResponse,
  hostCallSchema,
  hostResponseSchema,
  type Infer,
  type NativeRegistry,
  validateValue,
} from "@bunaway/protocol";
import type { CoreServices } from "./index.ts";

export function bindHostAPI(
  context: HostContext,
  signal: CancellationSignal,
  callHost: CoreServices["callHost"],
  registry: NativeRegistry,
): HostAPI {
  const checkCancelled = () => {
    if (signal.aborted)
      throw new BunawayError({ code: "CANCELLED", message: "Host operation cancelled." });
  };
  return {
    async call(contract, payload) {
      checkCancelled();
      if (!contract || typeof contract.name !== "string")
        throw new BunawayError({ code: "INVALID_ARGUMENT", message: "Invalid host contract." });
      const operation = registry.operation(contract.name);
      let call: HostCall;
      try {
        call = validateValue(
          hostCallSchema,
          registry.validateCall({
            operation: operation.name,
            payload: payload as HostCall["payload"],
          }),
        );
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
        return registry.validateOutput(operation.name, response.payload) as Infer<
          typeof contract.output
        >;
      } catch {
        throw new BunawayError({ code: "INTERNAL", message: "Invalid host response." });
      }
    },
  };
}

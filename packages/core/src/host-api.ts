import {
  BunawayError,
  type CancellationSignal,
  type HostAPI,
  type HostCall,
  type HostContext,
  type HostOperationContract,
  type HostResponse,
  hostCallSchema,
  hostResponseSchema,
  type JsonValue,
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
    if (signal.aborted) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Host operation cancelled.",
      });
    }
  };

  async function call(
    operationOrContract: HostOperationContract,
    payload: unknown,
  ): Promise<JsonValue> {
    checkCancelled();
    if (!operationOrContract || typeof operationOrContract.name !== "string") {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Invalid host contract.",
      });
    }
    const registeredOperation = registry.operation(operationOrContract.name);
    const operationName = registeredOperation.name;
    let call: HostCall;
    try {
      call = validateValue(
        hostCallSchema,
        registry.validateCall({
          operation: operationName,
          payload: payload as HostCall["payload"],
        }),
      );
    } catch {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Invalid host request.",
      });
    }

    let response: HostResponse;
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(
          new BunawayError({
            code: "CANCELLED",
            message: "Host operation cancelled.",
          }),
        );
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
      if (cause instanceof BunawayError) {
        throw cause;
      }
      throw new BunawayError({
        code: "INTERNAL",
        message: "Host operation failed.",
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    checkCancelled();
    if (response.kind === "error") {
      throw new BunawayError(response.error);
    }
    try {
      return registry.validateOutput(operationName, response.payload);
    } catch {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Invalid host response.",
      });
    }
  }

  return {
    // The selected registry validates the JSON result before exposing schema-derived types.
    call: call as HostAPI["call"],
  };
}

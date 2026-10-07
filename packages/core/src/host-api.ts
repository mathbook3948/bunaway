import {
  BunawayError,
  type CancellationSignal,
  type HostAPI,
  type HostCall,
  type HostContext,
  type HostInput,
  type HostOperation,
  type HostOperationContract,
  type HostOutput,
  type HostResponse,
  hostCallSchema,
  hostResponseSchema,
  type Infer,
  isWindowOperation,
  type NativeRegistry,
  type Schema,
  validateHostOutput,
  validateValue,
  validateWindowCall,
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

  function call<K extends HostOperation>(
    operation: K,
    input: HostInput<K>,
  ): Promise<HostOutput<K>>;
  function call<I extends Schema, O extends Schema>(
    contract: HostOperationContract<I, O>,
    input: Infer<I>,
  ): Promise<Infer<O>>;
  async function call(
    operationOrContract: HostOperation | HostOperationContract,
    payload: unknown,
  ): Promise<unknown> {
    checkCancelled();
    const windowCall = typeof operationOrContract === "string";
    let operationName: string;
    let call: HostCall;
    let registeredOperation: HostOperationContract | undefined;
    if (windowCall) {
      try {
        if (!isWindowOperation(operationOrContract)) {
          throw new Error("Unknown window operation.");
        }
        operationName = operationOrContract;
        call = validateWindowCall({
          operation: operationName,
          payload: payload as HostCall["payload"],
        });
      } catch {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Invalid host request.",
        });
      }
    } else {
      if (
        !operationOrContract ||
        typeof operationOrContract.name !== "string"
      ) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Invalid host contract.",
        });
      }
      // Preserve UNSUPPORTED for operations absent from the installed registry.
      registeredOperation = registry.operation(operationOrContract.name);
      operationName = registeredOperation.name;
      try {
        call = validateValue(
          hostCallSchema,
          registry.validateCall({
            operation: registeredOperation.name,
            payload: payload as HostCall["payload"],
          }),
        );
      } catch {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Invalid host request.",
        });
      }
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
      return windowCall
        ? validateHostOutput(operationName as HostOperation, response.payload)
        : registry.validateOutput(operationName, response.payload);
    } catch {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Invalid host response.",
      });
    }
  }

  return {
    call,
  };
}

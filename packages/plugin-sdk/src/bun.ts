import { currentHost } from "@bunaway/plugin-api/host";
import {
  BunawayError,
  type HostOperationContract,
  type JsonValue,
} from "@bunaway/protocol";

export type NativeInvokeOptions = never;

/**
 * Invoke a native operation from the active backend host context. Cancellation
 * and deadlines come from that context and cannot be overridden here.
 */
export async function call(
  operation: HostOperationContract,
  input: JsonValue,
  options?: NativeInvokeOptions,
): Promise<JsonValue> {
  if (options !== undefined) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Backend calls inherit command cancellation and deadline.",
    });
  }
  return currentHost().call(operation, input);
}

import { host } from "@bunaway/backend";
import {
  BunawayError,
  type HostOperationContract,
  type Infer,
  type Schema,
} from "@bunaway/protocol";

export type NativeInvokeOptions = never;
export async function call<I extends Schema, O extends Schema>(
  operation: HostOperationContract<I, O>,
  input: Infer<I>,
  options?: NativeInvokeOptions,
): Promise<Infer<O>> {
  if (options !== undefined)
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Backend calls inherit command cancellation and deadline.",
    });
  return host.call(operation, input);
}

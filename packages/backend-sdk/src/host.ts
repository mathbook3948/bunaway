import type {
  HostAPI,
  HostInput,
  HostOperation,
  HostOperationContract,
  HostOutput,
  Infer,
  Schema,
} from "@bunaway/protocol";
import { currentHost } from "./host-context.ts";

function call<K extends HostOperation>(
  operation: K,
  input: HostInput<K>,
): Promise<HostOutput<K>>;
function call<I extends Schema, O extends Schema>(
  contract: HostOperationContract<I, O>,
  input: Infer<I>,
): Promise<Infer<O>>;
async function call(
  operation: HostOperation | HostOperationContract,
  input: unknown,
): Promise<unknown> {
  const current = currentHost();
  return typeof operation === "string"
    ? current.call(operation, input as HostInput<HostOperation>)
    : current.call(
        operation as HostOperationContract<Schema, Schema>,
        input as Infer<Schema>,
      );
}

export const host = Object.freeze<HostAPI>({
  call,
});

export const windows = Object.freeze({
  list(): Promise<HostOutput<"windows.list">> {
    return call("windows.list", null);
  },
  create(
    input: HostInput<"windows.create">,
  ): Promise<HostOutput<"windows.create">> {
    return call("windows.create", input);
  },
  recreate(
    input: HostInput<"windows.recreate">,
  ): Promise<HostOutput<"windows.recreate">> {
    return call("windows.recreate", input);
  },
  show(input: HostInput<"windows.show">): Promise<HostOutput<"windows.show">> {
    return call("windows.show", input);
  },
  hide(input: HostInput<"windows.hide">): Promise<HostOutput<"windows.hide">> {
    return call("windows.hide", input);
  },
  focus(
    input: HostInput<"windows.focus">,
  ): Promise<HostOutput<"windows.focus">> {
    return call("windows.focus", input);
  },
  close(
    input: HostInput<"windows.close">,
  ): Promise<HostOutput<"windows.close">> {
    return call("windows.close", input);
  },
  setSize(
    input: HostInput<"windows.setSize">,
  ): Promise<HostOutput<"windows.setSize">> {
    return call("windows.setSize", input);
  },
  setPosition(
    input: HostInput<"windows.setPosition">,
  ): Promise<HostOutput<"windows.setPosition">> {
    return call("windows.setPosition", input);
  },
  setFullscreen(
    input: HostInput<"windows.setFullscreen">,
  ): Promise<HostOutput<"windows.setFullscreen">> {
    return call("windows.setFullscreen", input);
  },
  setCloseConfirmation(
    input: HostInput<"windows.setCloseConfirmation">,
  ): Promise<HostOutput<"windows.setCloseConfirmation">> {
    return call("windows.setCloseConfirmation", input);
  },
});

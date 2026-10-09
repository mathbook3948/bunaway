import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";

/** Expose the capability snapshot chosen by the host environment. */
export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  return {
    execute: () => environment.capabilities,
    dispose() {},
  };
}

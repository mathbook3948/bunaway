import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";

export function createOperations(environment: NativeEnvironment): NativeAdapter {
  return {
    execute: () => environment.capabilities,
    dispose() {},
  };
}

import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";

export function createOperations(environment: NativeEnvironment): NativeAdapter {
  return {
    execute: () =>
      environment.capabilities.map((feature) => ({
        ...feature,
        permission: /^(storage|log|capabilities)\./.test(feature.name)
          ? ("not-required" as const)
          : feature.permission,
      })),
    dispose() {},
  };
}

import assert from "node:assert/strict";
import type { NativeEnvironment, NativePluginAdapter } from "@bunaway/plugin";
import type { Platform } from "@bunaway/plugin-api";
import { BunawayError } from "@bunaway/protocol";

/** Select the same SDK-validated factory used by packaged hosts, without loading an instance yet. */
export function nativeFactory(
  definition: {
    nativePlatforms: Partial<
      Record<
        Platform,
        {
          operations?: readonly string[];
          create(environment: NativeEnvironment): NativePluginAdapter;
        }
      >
    >;
  },
  platform: Platform,
) {
  const target = definition.nativePlatforms[platform];
  assert(target, `Missing ${platform} test platform`);
  return (environment: NativeEnvironment): NativePluginAdapter => {
    const adapter = target.create(environment);
    return {
      ...adapter,
      // Direct fixture calls stand in for the host, which owns operation grants.
      async executeUI(operation, input, source, context) {
        if (
          target.operations?.includes(
            operation.slice(operation.indexOf(".") + 1),
          ) &&
          !context.permissions.permissions.includes(operation)
        ) {
          throw new BunawayError({
            code: "PERMISSION_DENIED",
            message: "Host context or policy denied.",
          });
        }
        assert(adapter.executeUI);
        return adapter.executeUI(operation, input, source, context);
      },
    };
  };
}

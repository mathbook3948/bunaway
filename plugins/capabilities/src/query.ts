import { BunawayError, type NativeInvokeOptions } from "@bunaway/plugin";
import type { Capabilities } from "./index.ts";

/**
 * Create the public query and enforce unique names in the host response.
 * Duplicate names reject with an `INTERNAL` error.
 */
export function createCapabilities(
  get: (input: null, options?: NativeInvokeOptions) => Promise<Capabilities>,
) {
  return async (options?: NativeInvokeOptions): Promise<Capabilities> => {
    const result = await get(null, options);
    if (new Set(result.map((feature) => feature.name)).size !== result.length) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Duplicate capability name.",
      });
    }
    return result;
  };
}

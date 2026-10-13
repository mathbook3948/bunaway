import {
  BunawayError,
  type NativeAdapter,
  type NativeEnvironment,
} from "@bunaway/plugin";

/** Return the host's executable support snapshot, independently of permission grants. */
export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  let disposed = false;
  return {
    execute() {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Capabilities adapter is disposed.",
        });
      }
      return environment.capabilities;
    },
    dispose() {
      disposed = true;
    },
  };
}

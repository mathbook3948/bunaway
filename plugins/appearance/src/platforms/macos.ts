import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { appearanceOperations } from "../contract.ts";
import { createAppearance } from "../macos.ts";

/** Own the read-only AppKit bindings on the host's main UI thread. */
export function createOperations(
  _environment: NativeEnvironment,
): NativeAdapter {
  const native = createAppearance();
  let disposed = false;
  return {
    execute(operation, input) {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Appearance adapter is disposed.",
        });
      }
      if (operation !== "appearance.getPreferences") {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Host operation is not registered.",
        });
      }
      if (!appearanceOperations.getPreferences.input.safeParse(input).success) {
        throw new BunawayError({
          code: "INVALID_ARGUMENT",
          message: "Appearance query requires null input.",
        });
      }
      return native.read();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      native.dispose();
    },
  };
}

import {
  BunawayError,
  type NativeAdapter,
  type NativeEnvironment,
} from "@bunaway/plugin";
import { MacosKeychain } from "../macos-keychain.ts";
import { macosOperations } from "../macos-operations.ts";

/** Host-selected app.id is a stable Keychain namespace; OS access belongs to the actual executable. */
export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  const appId = environment.app?.id;
  return macosOperations(appId ?? "", () => {
    if (
      !appId ||
      Buffer.byteLength(appId, "utf8") > 1024 ||
      appId.includes("\0")
    ) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "macOS safe storage requires a stable host app identity.",
      });
    }
    return new MacosKeychain(appId);
  });
}

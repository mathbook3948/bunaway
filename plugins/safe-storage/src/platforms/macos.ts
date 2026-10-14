import { BunawayError, type NativeEnvironment } from "@bunaway/plugin";
import type { MacosKeyStore } from "../macos-key-store.ts";
import { MacosKeychain } from "../macos-keychain.ts";
import { MacosSafeStorage } from "../macos-operations.ts";

/**
 * Host-selected app.id is a stable Keychain namespace; OS access belongs to the actual executable.
 * The internal provider argument lets native fixtures use a disposable Keychain without changing
 * the public API, default Keychain, access settings or host-owned identity resolution.
 */
function provider(
  environment: NativeEnvironment,
  open: (appId: string) => MacosKeyStore,
) {
  const appId = environment.app?.id;
  return {
    appId: appId ?? "",
    open: () => {
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
      return open(appId);
    },
  };
}

export function initialize(
  environment: NativeEnvironment,
  open: (appId: string) => MacosKeyStore = (appId) => new MacosKeychain(appId),
): MacosSafeStorage {
  const source = provider(environment, open);
  return new MacosSafeStorage(source.appId, source.open);
}

export function dispose(instance: MacosSafeStorage): void {
  instance.dispose();
}

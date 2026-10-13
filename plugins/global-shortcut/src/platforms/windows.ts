import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { createShortcutOperations } from "../shortcut-adapter.ts";
import { Win32Shortcuts } from "../win32.ts";

/** Create UI-thread registrations only when the plugin is installed and registered. */
export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  const services = environment.shortcuts;
  if (!services) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Native global shortcut services are unavailable.",
    });
  }
  return createShortcutOperations(
    new Win32Shortcuts(services),
    (event, payload) => services.emit(event, payload),
  );
}

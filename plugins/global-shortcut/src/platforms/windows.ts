import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { initializeShortcutOperations } from "../shortcut-adapter.ts";
import { Win32Shortcuts } from "../win32.ts";

export function initialize(environment: NativeEnvironment) {
  const services = environment.shortcuts;
  if (!services) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Native global shortcut services are unavailable.",
    });
  }
  return initializeShortcutOperations(
    new Win32Shortcuts(services),
    (event, payload) => services.emit(event, payload),
  );
}

export function dispose(instance: ReturnType<typeof initialize>): void {
  instance.dispose();
}

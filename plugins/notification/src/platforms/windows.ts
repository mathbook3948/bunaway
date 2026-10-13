import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { validateNotificationInput } from "../contract.ts";
import { createNotifications } from "../winrt.ts";

/** Own native libraries on the I/O worker; authorization precedes the synchronous native request. */
export function createOperations(
  environment: NativeEnvironment,
): NativeAdapter {
  const app = environment.app;
  if (!app) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Notification status requires a host-selected app identity.",
    });
  }
  const native = createNotifications(app.id);
  return {
    execute(operation, input) {
      validateNotificationInput(operation, input);
      return operation === "notification.getStatus"
        ? native.getStatus()
        : native.openSettings();
    },
    dispose: () => native.dispose(),
  };
}

import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { createNotifications } from "../winrt.ts";

/** Resolve the trusted app identity before binding Windows notification APIs. */
export function initialize(environment: NativeEnvironment) {
  const app = environment.app;
  if (!app) {
    throw new BunawayError({
      code: "UNSUPPORTED",
      message: "Notification status requires a host-selected app identity.",
    });
  }
  return createNotifications(app.id);
}

export function dispose(instance: ReturnType<typeof initialize>) {
  instance.dispose();
}

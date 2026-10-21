import { defineNativePlugin } from "@bunaway/plugin";
import { notificationEvents } from "#notification/contract";
import { notificationOperations } from "#notification/operations";
import { dispose, initialize } from "#notification/platforms/windows";
/**
 * Show app-owned transient toasts and receive live native callbacks.
 * Schedule one-shot toasts that Windows delivers at `deliverAt`, even after the app has exited, and list or cancel them.
 * An installed app also receives clicks made while it was not running: takeActivations returns those that
 * arrived before the app subscribed, and later ones are published as the same events.
 * Query the host-selected app's Windows notification setting or open its fixed Settings page.
 * getStatus takes no input and does not register an identity. openSettings only requests OS navigation;
 * successful navigation does not grant permission or change the setting. Both use the caller's policy.
 */
export default defineNativePlugin(
  {
    name: "notification",
    events: notificationEvents,
    platforms: {
      windows: {
        thread: "ui",
        initialize,
        dispose,
        operations: notificationOperations,
      },
    },
  },
  (api) => ({
    ...api,
    takeActivations: (
      options?: import("@bunaway/plugin").NativeInvokeOptions,
    ) => api.takeActivations(null, options),
    getStatus: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
      api.getStatus(null, options),
    openSettings: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
      api.openSettings(null, options),
  }),
);

export type {
  NotificationIdentity,
  NotificationOptions,
  NotificationResult,
  NotificationSetting,
  NotificationStatus,
  ScheduledNotification,
  ScheduleOptions,
} from "#notification/contract";

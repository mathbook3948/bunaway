import { defineNativePlugin } from "@bunaway/plugin";
import { notificationOperations } from "#notification/operations";
import { dispose, initialize } from "#notification/platforms/windows";
/**
 * Query the host-selected app's Windows notification setting or open the fixed notification Settings page.
 * getStatus takes no input and does not register an identity. openSettings only requests OS navigation;
 * successful navigation does not grant permission or change the setting. Both use the caller's policy.
 */
export default defineNativePlugin(
  {
    name: "notification",
    platforms: {
      windows: {
        initialize,
        dispose,
        operations: notificationOperations,
      },
    },
  },
  (api) => ({
    getStatus: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
      api.getStatus(null, options),
    openSettings: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
      api.openSettings(null, options),
  }),
);

export type {
  NotificationSetting,
  NotificationStatus,
} from "#notification/contract";

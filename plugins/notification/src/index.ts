import { defineNativePlugin } from "@bunaway/plugin";
import { notificationOperations } from "./operations.ts";
import { dispose, initialize } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "notification",
  platforms: {
    windows: {
      initialize,
      dispose,
      operations: notificationOperations,
    },
  },
});

/** Optional Windows notification status and Settings access. Registration does not enable notifications. */
export const notificationPlugin = plugin.definition;
export default notificationPlugin;
export type { NotificationSetting, NotificationStatus } from "./contract.ts";

/**
 * Query the host-selected app's Windows notification setting or open the fixed notification Settings page.
 * getStatus takes no input and does not register an identity. openSettings only requests OS navigation;
 * successful navigation does not grant permission or change the setting. Both use the caller's policy.
 */
export const notification = {
  getStatus: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
    plugin.api.getStatus(null, options),
  openSettings: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
    plugin.api.openSettings(null, options),
};

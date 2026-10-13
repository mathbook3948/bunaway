import { defineNativePlugin } from "@bunaway/plugin";
import { createWindows } from "./calls.ts";
import { windowDefinitions, windowEvents } from "./contract.ts";
import { createOperations as createMacosOperations } from "./platforms/macos.ts";
import { createOperations as createWindowsOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "windows",
  platforms: {
    windows: {
      execution: "ui",
      create: createWindowsOperations,
    },
    macos: {
      execution: "ui",
      create: createMacosOperations,
      // macOS supplies basic window and WebView services; geometry, identity and readiness remain unsupported.
      operations: [
        "list",
        "create",
        "recreate",
        "show",
        "hide",
        "focus",
        "close",
        "isVisible",
        "isFocused",
        "isDestroyed",
        "getWebViewState",
        "navigateWebView",
        "reloadWebView",
        "stopWebView",
        "goBack",
        "goForward",
        "setZoomFactor",
      ],
    },
  },
  operations: windowDefinitions,
});
/** Individually granted window operations for the app's declared windows. */
export const windowsPlugin = Object.freeze({
  ...plugin.definition,
  events: windowEvents,
});
export default windowsPlugin;
/** Typed helpers for invoking the registered window operations. */
export const windows = createWindows(plugin.api);
export type {
  WindowCall,
  WindowEvents,
  WindowInput,
  WindowOperation,
  WindowOutput,
} from "./contract.ts";
export {
  isWindowOperation,
  parseWindowCall,
  validateWindowCall,
  validateWindowOutput,
  windowEvents,
  windowOperations,
  windowReadinessSchema,
  windowSnapshotSchema,
} from "./contract.ts";

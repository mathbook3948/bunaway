import { defineNativePlugin, s } from "@bunaway/plugin";
import manifest from "../package.json";
import {
  WINDOW_VIEW_NAME_PATTERN,
  windowEvents,
  windowOperations,
} from "./contract.ts";
import { matches } from "./scope.ts";

const definitions = Object.fromEntries(
  Object.entries(windowOperations).map(([name, operation]) => [
    name.slice("windows.".length),
    {
      ...operation,
      permission:
        name === "windows.list" ||
        name === "windows.getById" ||
        name === "windows.getCurrent" ||
        name === "windows.getFocused" ||
        name === "windows.getLastActive"
          ? "list"
          : "control",
      osPermission: "not-required" as const,
    },
  ]),
);
const plugin = defineNativePlugin({
  name: "windows",
  version: manifest.version,
  operations: definitions,
  scopes: {
    control: s.object({
      view: s.string({
        pattern: WINDOW_VIEW_NAME_PATTERN,
      }),
    }),
  },
  matches,
});
/** Window operations with separate listing and view-scoped control permissions. */
export const windowsPlugin = Object.freeze({
  ...plugin.definition,
  events: windowEvents,
});
export default windowsPlugin;
type WindowAPI = {
  readonly [K in keyof typeof windowOperations as K extends `windows.${infer Name}`
    ? Name
    : never]: (
    input: import("@bunaway/protocol").Infer<
      (typeof windowOperations)[K]["input"]
    >,
    options?: import("@bunaway/plugin").NativeInvokeOptions,
  ) => Promise<
    import("@bunaway/protocol").Infer<(typeof windowOperations)[K]["output"]>
  >;
};
const api = plugin.api as WindowAPI;
/** Typed helpers for invoking the registered window operations. */
export const windows = Object.freeze({
  ...api,
  list: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
    api.list(null, options),
  getCurrent: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
    api.getCurrent(null, options),
  getFocused: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
    api.getFocused(null, options),
  getLastActive: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
    api.getLastActive(null, options),
});
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
  windowSnapshotSchema,
} from "./contract.ts";

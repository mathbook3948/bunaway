import { defineNativePlugin, s } from "@bunaway/plugin";
import manifest from "../package.json";
import { WINDOW_VIEW_NAME_PATTERN, windowOperations } from "./contract.ts";
import { matches } from "./scope.ts";

const definitions = Object.fromEntries(
  Object.entries(windowOperations).map(([name, operation]) => [
    name.slice("windows.".length),
    {
      ...operation,
      permission: name === "windows.list" ? "list" : "control",
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
export const windowsPlugin = plugin.definition;
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
export const windows = Object.freeze({
  ...api,
  list: (options?: import("@bunaway/plugin").NativeInvokeOptions) =>
    api.list(null, options),
});
export type {
  WindowCall,
  WindowInput,
  WindowOperation,
  WindowOutput,
} from "./contract.ts";
export {
  isWindowOperation,
  parseWindowCall,
  validateWindowCall,
  validateWindowOutput,
  windowOperations,
} from "./contract.ts";

import { defineNativePlugin, s } from "@bunaway/plugin";
import manifest from "../package.json";
import { createLog } from "./logger.ts";

const plugin = defineNativePlugin({
  name: "log",
  version: manifest.version,
  operations: {
    write: {
      input: s.object({
        level: s.enum(["debug", "info", "warn", "error"]),
        message: s.string({ maxLength: 1024 }),
        details: s.optional(s.json()),
      }),
      output: s.null(),
      permission: "write",
      osPermission: "not-required",
    },
  },
});
export const logPlugin = plugin.definition;
export default logPlugin;
export type LogInput = Parameters<typeof plugin.api.write>[0];

export const log = createLog(plugin.api.write);

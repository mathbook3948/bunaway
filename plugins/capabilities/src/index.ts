import { defineNativePlugin, s } from "@bunaway/plugin";
import manifest from "../package.json";
import { createCapabilities } from "./query.ts";

const plugin = defineNativePlugin({
  name: "capabilities",
  version: manifest.version,
  operations: {
    get: {
      input: s.null(),
      output: s.array(
        s.object({
          name: s.string({
            pattern: "^[A-Za-z0-9_.:-]+$(?![\\s\\S])",
            maxLength: 128,
          }),
          support: s.enum([
            "supported",
            "experimental",
            "unsupported",
          ]),
          permission: s.enum([
            "granted",
            "denied",
            "prompt",
            "not-required",
            "unknown",
          ]),
          reason: s.optional(
            s.string({
              maxLength: 1024,
            }),
          ),
        }),
      ),
      permission: "get",
      osPermission: "not-required",
    },
  },
});
/** Plugin contract for reading the host's registered capability states. */
export const capabilitiesPlugin = plugin.definition;
export default capabilitiesPlugin;

/** Result shape returned by `capabilities()`. */
export type Capabilities = Awaited<ReturnType<typeof plugin.api.get>>;

/** Read registered capabilities and reject duplicate names in the host response. */
export const capabilities = createCapabilities(plugin.api.get);

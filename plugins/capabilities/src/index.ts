import { defineNativePlugin } from "@bunaway/plugin";
import { capabilitiesOperations } from "./contract.ts";
import { createOperations as createMacosOperations } from "./platforms/macos.ts";
import { createOperations as createWindowsOperations } from "./platforms/windows.ts";
import { createCapabilities } from "./query.ts";

const plugin = defineNativePlugin({
  name: "capabilities",
  platforms: {
    macos: {
      execution: "io",
      create: createMacosOperations,
    },
    windows: {
      execution: "io",
      create: createWindowsOperations,
    },
  },
  operations: capabilitiesOperations,
});
/** Plugin contract for reading the host's registered capability states. */
export const capabilitiesPlugin = plugin.definition;
export default capabilitiesPlugin;

/** Read registered capabilities and reject duplicate names in the host response. */
export const capabilities = createCapabilities(plugin.api.get);
export type { Capabilities } from "./contract.ts";

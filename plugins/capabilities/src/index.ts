import { defineNativePlugin, type NativeEnvironment } from "@bunaway/plugin";
import { capabilitiesOperations } from "./operations.ts";
import { createCapabilities } from "./query.ts";

const snapshot = (environment: NativeEnvironment) => environment.capabilities;

const plugin = defineNativePlugin({
  name: "capabilities",
  platforms: {
    macos: {
      initialize: snapshot,
      operations: capabilitiesOperations,
    },
    windows: {
      initialize: snapshot,
      operations: capabilitiesOperations,
    },
  },
});
/** Plugin contract for reading the host's registered capability states. */
export const capabilitiesPlugin = plugin.definition;
export default capabilitiesPlugin;

/** Read registered capabilities and reject duplicate names in the host response. */
export const capabilities = createCapabilities(plugin.api.get);
export type { Capabilities } from "./contract.ts";

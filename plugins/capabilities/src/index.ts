import { defineNativePlugin, type NativeEnvironment } from "@bunaway/plugin";
import { capabilitiesOperations } from "#capabilities/operations";
import { createCapabilities } from "#capabilities/query";

const snapshot = (environment: NativeEnvironment) => environment.capabilities;

/** Read registered capabilities and reject duplicate names in the host response. */
export default defineNativePlugin(
  {
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
  },
  (api) => createCapabilities(api.get),
);

export type { Capabilities } from "#capabilities/contract";

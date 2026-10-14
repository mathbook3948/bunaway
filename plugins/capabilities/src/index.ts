import { defineNativePlugin, type NativeEnvironment } from "@bunaway/plugin";
import { capabilitiesOperations } from "./operations.ts";
import { createCapabilities } from "./query.ts";

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

export type { Capabilities } from "./contract.ts";

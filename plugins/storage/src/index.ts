import { defineNativePlugin } from "@bunaway/plugin";
import { storageOperations } from "./contract.ts";
import { createOperations as createWindowsOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "storage",
  platforms: {
    windows: {
      execution: "io",
      create: createWindowsOperations,
    },
  },
  operations: storageOperations,
});
/** Plugin contract for text, bytes and metadata access at application-selected paths. */
export const storagePlugin = plugin.definition;
export default storagePlugin;

/** Typed storage operations; the application chooses paths and access rules. */
export const storage = plugin.api;

export type {
  StorageBytesWrite,
  StorageLocation,
  StorageMetadata,
  StorageTransfer,
  StorageWrite,
} from "./contract.ts";

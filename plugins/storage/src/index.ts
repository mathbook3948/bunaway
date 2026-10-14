import { defineNativePlugin } from "@bunaway/plugin";
import type { Storage } from "./contract.ts";
import { storageOperations } from "./operations.ts";
import {
  createStorage as createMacosStorage,
  disposeStorage as disposeMacosStorage,
} from "./platforms/macos.ts";
import { createStorage, disposeStorage } from "./platforms/windows.ts";
import { windowsOperations } from "./platforms/windows-operations.ts";

const plugin = defineNativePlugin({
  name: "storage",
  platforms: {
    windows: {
      initialize: createStorage,
      dispose: disposeStorage,
      operations: windowsOperations,
    },
    macos: {
      initialize: createMacosStorage,
      dispose: disposeMacosStorage,
      // Darwin rename/delete cannot preserve the checked object's identity.
      operations: storageOperations,
    },
  },
});
/** Plugin contract for text, bytes, metadata and directory access at application-selected paths. */
export const storagePlugin = plugin.definition;
export default storagePlugin;

/** Typed storage operations; the application chooses paths and access rules. */
export const storage: Storage = plugin.api;

export type {
  Storage,
  StorageBytesWrite,
  StorageDirectoryCreate,
  StorageLocation,
  StorageMetadata,
  StorageTransfer,
  StorageWrite,
} from "./contract.ts";

export type { StorageDirectoryEntry } from "./directory-entries.ts";

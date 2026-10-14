import { defineNativePlugin } from "@bunaway/plugin";
import { storageOperations } from "./operations.ts";
import {
  createStorage as createMacosStorage,
  disposeStorage as disposeMacosStorage,
} from "./platforms/macos.ts";
import { createStorage, disposeStorage } from "./platforms/windows.ts";
import { windowsOperations } from "./platforms/windows-operations.ts";

/** Typed storage operations; the application chooses paths and access rules. */
export default defineNativePlugin({
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

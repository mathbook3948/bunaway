import { defineNativePlugin } from "@bunaway/plugin";
import { storageOperations } from "#storage/operations";
import {
  createStorage as createMacosStorage,
  disposeStorage as disposeMacosStorage,
} from "#storage/platforms/macos";
import { createStorage, disposeStorage } from "#storage/platforms/windows";
/** Typed storage operations; the application chooses paths and access rules. */
export default defineNativePlugin({
  name: "storage",
  platforms: {
    windows: {
      initialize: createStorage,
      dispose: disposeStorage,
      operations: storageOperations,
    },
    macos: {
      initialize: createMacosStorage,
      dispose: disposeMacosStorage,
      operations: storageOperations,
    },
  },
});

export type {
  Storage,
  StorageBytesRead,
  StorageBytesWrite,
  StorageDirectoryCreate,
  StorageDirectoryEntry,
  StorageDirectorySize,
  StorageLocation,
  StorageMetadata,
  StorageTransfer,
  StorageWrite,
} from "#storage/contract";

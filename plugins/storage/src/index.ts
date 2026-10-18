import { defineNativePlugin } from "@bunaway/plugin";
import { storageOperations } from "#storage/operations";
import {
  createStorage as createMacosStorage,
  disposeStorage as disposeMacosStorage,
} from "#storage/platforms/macos";
import { createStorage, disposeStorage } from "#storage/platforms/windows";
import { windowsOperations } from "#storage/platforms/windows-operations";
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
      // Darwin rename/delete cannot preserve the checked object's identity, and
      // directorySize is implemented only as the Windows handle-pinned walk.
      operations: storageOperations,
    },
  },
});

export type {
  Storage,
  StorageBytesWrite,
  StorageDirectoryCreate,
  StorageDirectoryEntry,
  StorageDirectorySize,
  StorageLocation,
  StorageMetadata,
  StorageTransfer,
  StorageWrite,
} from "#storage/contract";

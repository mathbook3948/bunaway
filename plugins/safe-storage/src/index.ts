import { defineNativePlugin } from "@bunaway/plugin";
import { safeStorageOperations } from "./operations.ts";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "./platforms/macos.ts";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "safe-storage",
  platforms: {
    macos: {
      initialize: initializeMacos,
      dispose: disposeMacos,
      operations: safeStorageOperations,
    },
    windows: {
      initialize: initializeWindows,
      dispose: disposeWindows,
      operations: safeStorageOperations,
    },
  },
});

/** Optional Windows DPAPI and macOS Keychain protection. Registration does not grant access. */
export const safeStoragePlugin = plugin.definition;
export default safeStoragePlugin;

/** Promise-based encryption/decryption on the I/O Worker; never falls back to plaintext. */
export const safeStorage = plugin.api;

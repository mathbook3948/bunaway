import { defineNativePlugin } from "@bunaway/plugin";
import { safeStorageOperations } from "#safe-storage/operations";
import {
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#safe-storage/platforms/macos";
import {
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "#safe-storage/platforms/windows";
/** Promise-based encryption/decryption on the I/O Worker; never falls back to plaintext. */
export default defineNativePlugin({
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

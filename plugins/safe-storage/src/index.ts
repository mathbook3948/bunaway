import { defineNativePlugin } from "@bunaway/plugin";
import { safeStorageOperations } from "./contract.ts";
import { createOperations as createMacosOperations } from "./platforms/macos.ts";
import { createOperations } from "./platforms/windows.ts";

const plugin = defineNativePlugin({
  name: "safe-storage",
  platforms: {
    macos: {
      execution: "io",
      create: createMacosOperations,
    },
    windows: {
      execution: "io",
      create: createOperations,
    },
  },
  operations: safeStorageOperations,
});

/** Optional Windows DPAPI and macOS Keychain protection. Registration does not grant access. */
export const safeStoragePlugin = plugin.definition;
export default safeStoragePlugin;

/** Promise-based encryption/decryption on the I/O Worker; never falls back to plaintext. */
export const safeStorage = plugin.api;

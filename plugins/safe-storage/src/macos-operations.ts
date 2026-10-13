import { BunawayError, type NativeAdapter } from "@bunaway/plugin";
import { type SafeStorageInput, safeStorageLimits } from "./contract.ts";
import {
  transformMacosEnvelope,
  validateMacosEnvelope,
} from "./macos-envelope.ts";
import { type MacosKeyStore, protectionKey } from "./macos-key-store.ts";

/** Own a lazy Keychain provider on the I/O Worker. No native resource is acquired at import or registration. */
export function macosOperations(
  appId: string,
  open: () => MacosKeyStore,
): NativeAdapter {
  let store: MacosKeyStore | undefined;
  let disposed = false;
  const provider = () => {
    store ??= open();
    return store;
  };
  return {
    execute(name, input) {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Data protection adapter is disposed.",
        });
      }
      if (name === "safe-storage.isAvailable") {
        try {
          return provider().available();
        } catch {
          return false;
        }
      }
      // Operation-specific input has been validated on this worker by the plugin SDK.
      const parsed = input as SafeStorageInput;
      const decrypt =
        name === "safe-storage.decryptString" ||
        name === "safe-storage.decryptBytes";
      let bytes: Buffer;
      if (name === "safe-storage.encryptString" && parsed && "text" in parsed) {
        bytes = Buffer.from(parsed.text, "utf8");
      } else if (
        name === "safe-storage.encryptBytes" &&
        parsed &&
        "bytes" in parsed
      ) {
        bytes = Buffer.from(parsed.bytes, "base64");
      } else if (decrypt && parsed && "ciphertext" in parsed) {
        bytes = Buffer.from(parsed.ciphertext, "base64");
      } else {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Unknown data protection operation.",
        });
      }
      let key: Buffer | undefined;
      let result: Buffer | undefined;
      try {
        if (decrypt) {
          validateMacosEnvelope(bytes);
        }
        key = protectionKey(provider(), !decrypt);
        result = transformMacosEnvelope(bytes, key, appId, decrypt);
        if (name !== "safe-storage.decryptString") {
          return result.toString("base64");
        }
        const text = new TextDecoder("utf8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(result);
        if (text.length > safeStorageLimits.textCharacters) {
          throw new BunawayError({
            code: "INTERNAL",
            message: "Decrypted text exceeds its contract.",
          });
        }
        return text;
      } finally {
        bytes.fill(0);
        key?.fill(0);
        result?.fill(0);
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      store?.dispose();
      store = undefined;
    },
  };
}

import { BunawayError, type NativeAdapter } from "@bunaway/plugin";
import { type SafeStorageInput, safeStorageLimits } from "../contract.ts";
import { WindowsDataProtection } from "../dpapi.ts";

/** Lazily bind DPAPI on the I/O Worker so an unavailable provider can be queried safely. */
export function createOperations(): NativeAdapter {
  let native: WindowsDataProtection | undefined;
  let disposed = false;
  const provider = () => {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Data protection adapter is disposed.",
      });
    }
    native ??= new WindowsDataProtection();
    return native;
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
        let protectedData: Buffer | undefined;
        let restored: Buffer | undefined;
        try {
          const probe = Buffer.from("bunaway-dpapi-probe");
          protectedData = provider().transform(probe, false);
          restored = provider().transform(protectedData, true);
          return restored.equals(probe);
        } catch {
          // This is a fresh capability probe, never a promise that later operations will succeed.
          return false;
        } finally {
          protectedData?.fill(0);
          restored?.fill(0);
        }
      }
      // The SDK has validated the operation-specific input on this worker.
      const parsed = input as SafeStorageInput;
      const decrypt =
        name === "safe-storage.decryptString" ||
        name === "safe-storage.decryptBytes";
      const stringResult = name === "safe-storage.decryptString";
      let bytes: Buffer;
      if (parsed && "text" in parsed && name === "safe-storage.encryptString") {
        bytes = Buffer.from(parsed.text, "utf8");
      } else if (
        parsed &&
        "bytes" in parsed &&
        name === "safe-storage.encryptBytes"
      ) {
        bytes = Buffer.from(parsed.bytes, "base64");
      } else if (parsed && "ciphertext" in parsed && decrypt) {
        bytes = Buffer.from(parsed.ciphertext, "base64");
      } else {
        throw new BunawayError({
          code: "UNSUPPORTED",
          message: "Unknown data protection operation.",
        });
      }
      let result: Buffer | undefined;
      try {
        result = provider().transform(bytes, decrypt);
        if (!stringResult) {
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
        result?.fill(0);
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      native?.dispose();
      native = undefined;
    },
  };
}

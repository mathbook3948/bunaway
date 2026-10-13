import { win32 } from "node:path";
import { BunawayError, type NativeAdapter } from "@bunaway/plugin";
import type { PathInput } from "../contract.ts";
import { WindowsKnownFolders } from "../known-folders.ts";

/** Windows path semantics never inherit the I/O Worker's current working directory. */
export function createOperations(): NativeAdapter {
  let folders: WindowsKnownFolders | undefined;
  let disposed = false;
  return {
    execute(name, input) {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Path adapter is disposed.",
        });
      }
      // The SDK validates the operation-specific shape before dispatching to this adapter.
      const parsed = input as PathInput;
      if (name === "path.getDirectory" && "directory" in parsed) {
        folders ??= new WindowsKnownFolders();
        return folders.get(parsed.directory);
      }
      if ("paths" in parsed) {
        if (name === "path.join") {
          return win32.join(...parsed.paths);
        }
        if (name === "path.resolve" && "base" in parsed) {
          return win32.resolve(parsed.base, ...parsed.paths);
        }
      }
      if ("path" in parsed) {
        switch (name) {
          case "path.normalize":
            return win32.normalize(parsed.path);
          case "path.basename":
            return win32.basename(
              parsed.path,
              "suffix" in parsed ? parsed.suffix : undefined,
            );
          case "path.dirname":
            return win32.dirname(parsed.path);
          case "path.extname":
            return win32.extname(parsed.path);
          case "path.isAbsolute":
            return win32.isAbsolute(parsed.path);
        }
      }
      throw new BunawayError({
        code: "UNSUPPORTED",
        message: "Unknown path operation.",
      });
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      folders?.dispose();
      folders = undefined;
    },
  };
}

import { dlopen } from "bun:ffi";
import type { NativeAdapter, NativeEnvironment } from "@bunaway/plugin";
import { BunawayError, NativeRegistry, validateValue } from "@bunaway/protocol";
import { openerPlugin } from "./index.ts";
import { fileInput, normalizeFilePath } from "./path.ts";
import { createShell } from "./shell.ts";
import { normalizeUrl, urlInput } from "./url.ts";
import { createFiles } from "./windows-file.ts";

const COINIT_APARTMENTTHREADED = 0x2;

/** Own one balanced COM initialization on the adapter's I/O thread. */
function createApartment() {
  const ole = dlopen("ole32.dll", {
    CoInitializeEx: {
      args: [
        "ptr",
        "u32",
      ],
      returns: "i32",
    },
    CoUninitialize: {
      args: [],
      returns: "void",
    },
  });
  if (ole.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED) < 0) {
    ole.close();
    throw new BunawayError({
      code: "INTERNAL",
      message: "Opener could not initialize its COM apartment.",
    });
  }
  return {
    dispose() {
      ole.symbols.CoUninitialize();
      ole.close();
    },
  };
}

/** Prepare the I/O adapter, including the STA used for Explorer requests. */
export function createOperations(
  _environment: NativeEnvironment,
): NativeAdapter {
  const registry = new NativeRegistry([
    openerPlugin,
  ]);
  const apartment = createApartment();
  const shell = (() => {
    try {
      return createShell();
    } catch (error) {
      apartment.dispose();
      throw error;
    }
  })();
  const files = (() => {
    try {
      return createFiles();
    } catch (error) {
      try {
        shell.dispose();
      } finally {
        apartment.dispose();
      }
      throw error;
    }
  })();
  let disposed = false;
  return {
    execute(name, input) {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Opener has been disposed.",
        });
      }
      // The host authorizes the current context and exact scope immediately before
      // dispatch to this I/O worker. There is no async gap before pinning the path.
      registry.operation(name);
      const payload =
        name === "opener.openUrl"
          ? validateValue(urlInput, input)
          : validateValue(fileInput, input);
      if ("url" in payload) {
        shell.open(normalizeUrl(payload.url));
      } else {
        const path = normalizeFilePath(payload.path);
        files.withFile(path, () => {
          if (name === "opener.openFile") {
            shell.open(path);
          } else {
            shell.reveal(path);
          }
        });
      }
      return null;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      // Keep COM initialized until the last shell reference has been released.
      try {
        files.dispose();
      } finally {
        try {
          shell.dispose();
        } finally {
          apartment.dispose();
        }
      }
    },
  };
}

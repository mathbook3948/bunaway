import { dlopen, ptr } from "bun:ffi";
import { BunawayError } from "@bunaway/protocol";

const SHARD_PATHW = 0x3;

/**
 * Bind `SHAddToRecentDocs` for the life of the opener. The Shell can keep working in the
 * background after the call returns, so the library stays loaded until dispose instead
 * of being unloaded after each request.
 *
 * Requests run on the caller's thread, as Electron does. The Shell may leave a
 * multithreaded apartment alive in the process afterwards, which makes threads without
 * COM initialization implicit MTA members. Isolating the call on a dedicated STA thread
 * was tried and did not prevent that, so the opener supports the state instead: it
 * initializes its own STA explicitly and releases only that.
 */
export function createRecentDocuments() {
  const shell = dlopen("shell32.dll", {
    SHAddToRecentDocs: {
      args: [
        "u32",
        "ptr",
      ],
      returns: "void",
    },
  });
  let disposed = false;
  return {
    /**
     * Add a validated path to the user's Shell Recent Items, or clear the whole list
     * when `path` is null. The function has no result, so returning means only that the
     * request was issued. Calls after disposal throw a `CANCELLED` error.
     */
    request(path: string | null): void {
      if (disposed) {
        throw new BunawayError({
          code: "CANCELLED",
          message: "Opener has been disposed.",
        });
      }
      // Keep the UTF-16 buffer referenced until the call returns.
      const wide = path === null ? null : Buffer.from(`${path}\0`, "utf16le");
      shell.symbols.SHAddToRecentDocs(SHARD_PATHW, wide ? ptr(wide) : null);
    },
    /** Unload shell32 after the opener's last request. Repeated calls are safe. */
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      shell.close();
    },
  };
}

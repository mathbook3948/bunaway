import { dlopen, ptr } from "bun:ffi";

const SHARD_PATHW = 0x3;

/**
 * Call `SHAddToRecentDocs` on the caller's thread, as Electron does. Pass a validated
 * path to add it to the user's Shell Recent Items, or null to clear the whole list.
 * The function has no result, so returning means only that the request was issued.
 *
 * The Shell may leave a multithreaded apartment alive in the process afterwards, which
 * makes threads without COM initialization implicit MTA members. Isolating the call on
 * a dedicated STA thread was tried and did not prevent that, so the opener supports
 * the state instead: it initializes its own STA explicitly and releases only that.
 */
export function requestRecentDocuments(path: string | null): void {
  const shell = dlopen("shell32.dll", {
    SHAddToRecentDocs: {
      args: [
        "u32",
        "ptr",
      ],
      returns: "void",
    },
  });
  try {
    // Keep the UTF-16 buffer referenced until the call returns.
    const wide = path === null ? null : Buffer.from(`${path}\0`, "utf16le");
    shell.symbols.SHAddToRecentDocs(SHARD_PATHW, wide ? ptr(wide) : null);
  } finally {
    shell.close();
  }
}

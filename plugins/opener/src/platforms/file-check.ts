import {
  closeSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { BunawayError } from "@bunaway/protocol";

const DEVICE_PREFIX = "\\\\?\\";
const UNC_PREFIX = "\\\\?\\UNC\\";

/** Turns a resolved path with a Win32 device or UNC prefix back into the caller's path form. */
export function stripDevicePrefix(resolved: string): string {
  if (resolved.startsWith(UNC_PREFIX)) {
    return `\\\\${resolved.slice(UNC_PREFIX.length)}`;
  }
  if (resolved.startsWith(DEVICE_PREFIX)) {
    return resolved.slice(DEVICE_PREFIX.length);
  }
  return resolved;
}

/** Maps a filesystem error to the opener's public error contract; `FILE_NOT_FOUND` is a stable reason. */
function fileError(error: unknown): BunawayError {
  if (error instanceof BunawayError) {
    return error;
  }
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Opener file not found.",
      details: {
        reason: "FILE_NOT_FOUND",
      },
    });
  }
  if (code === "EACCES" || code === "EPERM" || code === "EBUSY") {
    return new BunawayError({
      code: "PERMISSION_DENIED",
      message: "Opener file access denied.",
    });
  }
  return new BunawayError({
    code: "INTERNAL",
    message: "Opener file check failed.",
  });
}

/**
 * Resolve `path` through any links to the file it names and confirm that the file is readable.
 * Callers use the returned path for extension checks and for the OS request, so the name of a link
 * cannot stand in for its target. Which files an app may open is decided by the app command
 * (ADR 0024); this only reports a missing, unreadable or non-regular target with the opener's
 * error contract: `INVALID_ARGUMENT` (reason `FILE_NOT_FOUND` when absent, or not a regular file)
 * and `PERMISSION_DENIED`. A path swapped after this returns is not detected.
 */
export function resolveReadableFile(path: string): string {
  try {
    const resolved = stripDevicePrefix(realpathSync.native(path));
    // Only a regular file is opened below, so a FIFO or device cannot block the caller.
    if (!statSync(resolved).isFile()) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Opener requires a regular file.",
      });
    }
    closeSync(openSync(resolved, "r"));
    return resolved;
  } catch (error) {
    throw fileError(error);
  }
}

/**
 * Confirm that `path` names an existing entry that is not a directory, without following a final
 * link, so moving a link to the Recycle Bin moves the link itself. Reports a missing path as
 * `FILE_NOT_FOUND` and a directory as `INVALID_ARGUMENT`.
 */
export function assertExistingFile(path: string): void {
  // A final link is not followed, so a link to a directory is still moved as the link it is.
  try {
    if (lstatSync(path).isDirectory()) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Opener requires a file, not a directory.",
      });
    }
  } catch (error) {
    throw fileError(error);
  }
}

/** Confirm that the folder a new file will be written into exists, reporting a missing one as `FILE_NOT_FOUND`. */
export function assertParentDirectory(path: string): void {
  try {
    if (!statSync(dirname(path)).isDirectory()) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message: "Opener requires an existing folder.",
      });
    }
  } catch (error) {
    throw fileError(error);
  }
}

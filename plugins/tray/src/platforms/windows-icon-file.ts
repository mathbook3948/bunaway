import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import {
  MAX_NATIVE_ICO_BYTES,
  parseNativeIco,
} from "@bunaway/plugin-api/native";
import { BunawayError, isWindowsFileName } from "@bunaway/protocol";

const MAX_TRAY_ICON_PATH_UNITS = 260;

function invalid(message: string, cause?: unknown): never {
  const error = new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
  if (cause !== undefined) {
    error.cause = cause;
  }
  throw error;
}

/**
 * Check a declared tray icon path without touching the file system. Only a relative path made of
 * valid Windows file names is accepted: no drive, UNC or device prefix, no URL scheme, no `..` or
 * `.` segment, no stream, reserved device name or trailing dot or space.
 */
export function validateTrayIconPath(icon: unknown): string {
  if (typeof icon !== "string" || icon.length === 0) {
    return invalid("desktop.tray.icon must be a non-empty resource path.");
  }
  if (icon.length > MAX_TRAY_ICON_PATH_UNITS) {
    return invalid("desktop.tray.icon is too long.");
  }
  if (
    /[\uD800-\uDFFF]/u.test(
      icon.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ""),
    )
  ) {
    return invalid("desktop.tray.icon contains an invalid surrogate.");
  }
  if (isAbsolute(icon) || win32.isAbsolute(icon) || /^[\\/]/u.test(icon)) {
    return invalid(
      "desktop.tray.icon must be relative to the resources directory.",
    );
  }
  if (!icon.split(/[\\/]/u).every((segment) => isWindowsFileName(segment))) {
    return invalid(
      "desktop.tray.icon must be made of valid file names without . or .. segments.",
    );
  }
  return icon;
}

/**
 * Read the declared tray icon from the app resources directory and return it as the base64 ICO
 * the tray accepts. The canonical file must stay inside the canonical resources directory, so a
 * symlink or junction cannot lead outside it. File system failures are reported without the
 * absolute path; the original error stays as the cause. The read is synchronous because tray
 * creation is, and the file is bounded by the ICO limit.
 */
export function readTrayIconFile(
  resources: string | undefined,
  icon: unknown,
): string {
  const declared = validateTrayIconPath(icon);
  if (!resources) {
    return invalid("desktop.tray.icon needs an app resources directory.");
  }
  let root: string;
  let canonical: string;
  try {
    root = realpathSync(resolve(resources));
    canonical = realpathSync(resolve(root, declared));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return invalid(
      missing
        ? `desktop.tray.icon was not found: ${declared}`
        : `desktop.tray.icon could not be resolved: ${declared}`,
      error,
    );
  }
  const inside = relative(root, canonical);
  if (
    inside === "" ||
    isAbsolute(inside) ||
    inside.split(/[\\/]/u)[0] === ".."
  ) {
    return invalid(
      "desktop.tray.icon resolves outside the resources directory.",
    );
  }
  let bytes: Buffer;
  try {
    const descriptor = openSync(canonical, "r");
    try {
      // Check the type on the opened handle so a directory is rejected without being read.
      const info = fstatSync(descriptor);
      if (!info.isFile()) {
        return invalid("desktop.tray.icon must be a file.");
      }
      if (info.size > MAX_NATIVE_ICO_BYTES) {
        return invalid("desktop.tray.icon is larger than the ICO limit.");
      }
      // Read one byte past the limit so a file that grew after the size check is still bounded.
      const buffer = Buffer.alloc(MAX_NATIVE_ICO_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(
          descriptor,
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (read === 0) {
          break;
        }
        length += read;
      }
      bytes = buffer.subarray(0, length);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof BunawayError) {
      throw error;
    }
    return invalid(`desktop.tray.icon could not be read: ${declared}`, error);
  }
  if (bytes.length > MAX_NATIVE_ICO_BYTES) {
    return invalid("desktop.tray.icon is larger than the ICO limit.");
  }
  const base64 = bytes.toString("base64");
  if (!parseNativeIco(base64)) {
    return invalid("desktop.tray.icon is not a valid ICO file.");
  }
  return base64;
}

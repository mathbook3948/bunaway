import { dlopen, ptr } from "bun:ffi";
import { statSync } from "node:fs";
import { BunawayError } from "@bunaway/protocol";
import {
  MAX_TOAST_IMAGE_BYTES,
  type ResolvedNotification,
} from "#notification/contract";

// GetDriveTypeW results that are allowed to be read. Everything else is refused before any file I/O.
const DRIVE_REMOVABLE = 2;
const DRIVE_FIXED = 3;
const DRIVE_CDROM = 5;
const DRIVE_RAMDISK = 6;
const LOCAL_DRIVE_TYPES: ReadonlySet<number> = new Set([
  DRIVE_REMOVABLE,
  DRIVE_FIXED,
  DRIVE_CDROM,
  DRIVE_RAMDISK,
]);

/** Classify the root of a drive-absolute path with GetDriveTypeW. Loaded per call and always closed. */
export function windowsDriveType(path: string): number {
  const library = dlopen("kernel32.dll", {
    GetDriveTypeW: {
      args: [
        "ptr",
      ],
      returns: "u32",
    },
  });
  try {
    const root = Buffer.from(`${path.slice(0, 2)}\\\0`, "utf16le");
    return library.symbols.GetDriveTypeW(ptr(root));
  } finally {
    library.close();
  }
}

function invalidImage(message: string): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/**
 * Check that the icon and image paths name regular files on a local drive within the size limit.
 * The schema has already validated path shape and extension. The drive type is checked before any
 * stat so that a mapped network drive cannot block this thread on an SMB timeout. A subst drive
 * reports the type of its target, so a subst drive that points at a network share is not detected.
 * Errors do not echo the path. A file changed after this check is shown by Windows without the picture.
 *
 * @param driveTypeOf Resolves a path to a GetDriveTypeW value; injectable for tests.
 */
export function assertToastMediaFiles(
  input: ResolvedNotification,
  driveTypeOf: (path: string) => number = windowsDriveType,
): void {
  for (const path of [
    input.icon,
    input.image,
  ]) {
    if (path === null) {
      continue;
    }
    // Remote, unknown and missing-root drives are all refused, because their location cannot be trusted as local.
    if (!LOCAL_DRIVE_TYPES.has(driveTypeOf(path))) {
      invalidImage("Notification image must be on a local drive.");
    }
    let size: number | undefined;
    try {
      const stat = statSync(path);
      size = stat.isFile() ? stat.size : undefined;
    } catch {
      // Missing and unreadable files share the regular-file outcome below.
    }
    if (size === undefined) {
      invalidImage("Notification image is not a readable regular file.");
    }
    if (size > MAX_TOAST_IMAGE_BYTES) {
      invalidImage("Notification image file is too large.");
    }
  }
}

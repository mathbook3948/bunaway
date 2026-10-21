import { statSync } from "node:fs";
import { BunawayError } from "@bunaway/protocol";
import {
  MAX_TOAST_IMAGE_BYTES,
  type ResolvedNotification,
} from "#notification/contract";

// GetDriveTypeW results. Only fixed and RAM disks are read, matching the opener's recycle policy, so
// removable, optical, remote and unknown drives cannot stall the calling thread.
const DRIVE_FIXED = 3;
const DRIVE_RAMDISK = 6;
const READABLE_DRIVE_TYPES: ReadonlySet<number> = new Set([
  DRIVE_FIXED,
  DRIVE_RAMDISK,
]);
const INVALID_FILE_ATTRIBUTES = 0xffffffff;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
// Files whose content is not on the local disk; opening them would download or recall data.
const FILE_ATTRIBUTE_OFFLINE = 0x1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x40000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000;
const REMOTE_CONTENT_ATTRIBUTES =
  FILE_ATTRIBUTE_OFFLINE |
  FILE_ATTRIBUTE_RECALL_ON_OPEN |
  FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

/** Win32 path probes. Windows binds them to the adapter's kernel32 handle; tests supply stubs. */
export type ToastFilesystem = {
  /** GetDriveTypeW for a root such as `C:\`. */
  driveType(root: string): number;
  /** GetFileAttributesW for the path, which reports a final link's own attributes; INVALID_FILE_ATTRIBUTES when unreadable. */
  attributes(path: string): number;
};

function invalidImage(message: string): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/**
 * Check that the icon and image paths name regular, locally stored files on a fixed drive within the size limit.
 * The schema has already validated path shape and extension. Stages, each before the next can touch the target:
 * 1. The drive type is checked so a mapped network drive cannot block this thread on an SMB timeout.
 * 2. The path's attributes are read once. It must not be a directory, offline or recall-on-access,
 *    so a cloud file named directly is not downloaded. A final link reports its own attributes, so the
 *    target of a link is not checked this way.
 * 3. Only then is the file stat-ed for type and size.
 * Links are followed and not re-checked against the drive limit: which files an app may show is
 * decided by the app command. Errors do not echo the path. A `subst` drive reports its target's type,
 * so one that points at a network share is not detected, and a file changed after this check is not
 * re-validated.
 */
export function assertToastMediaFiles(
  input: Pick<ResolvedNotification, "icon" | "image">,
  filesystem: ToastFilesystem,
): void {
  for (const path of [
    input.icon,
    input.image,
  ]) {
    if (path === null) {
      continue;
    }
    const [drive = ""] = path.split(/[\\/]+/).filter(Boolean);
    if (!READABLE_DRIVE_TYPES.has(filesystem.driveType(`${drive}\\`))) {
      invalidImage("Notification image must be on a local fixed drive.");
    }
    const attributes = filesystem.attributes(path);
    if (attributes === INVALID_FILE_ATTRIBUTES) {
      invalidImage("Notification image is not a readable regular file.");
    }
    if (attributes & FILE_ATTRIBUTE_DIRECTORY) {
      invalidImage("Notification image is not a readable regular file.");
    }
    if (attributes & REMOTE_CONTENT_ATTRIBUTES) {
      invalidImage("Notification image must be stored locally.");
    }
    let size: number | undefined;
    try {
      const stat = statSync(path);
      size = stat.isFile() ? stat.size : undefined;
    } catch {
      // Unreadable files share the regular-file outcome below.
    }
    if (size === undefined) {
      invalidImage("Notification image is not a readable regular file.");
    }
    if (size > MAX_TOAST_IMAGE_BYTES) {
      invalidImage("Notification image file is too large.");
    }
  }
}

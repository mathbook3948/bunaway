import { statSync } from "node:fs";
import { BunawayError } from "@bunaway/protocol";
import {
  MAX_TOAST_IMAGE_BYTES,
  type ResolvedNotification,
} from "#notification/contract";

/**
 * Check that the icon and image paths name existing regular files within the size limit.
 * The schema has already validated path shape and extension. The check precedes native work, and
 * a file changed afterwards is shown by Windows without the picture.
 */
export function assertToastMediaFiles(input: ResolvedNotification): void {
  for (const path of [
    input.icon,
    input.image,
  ]) {
    if (path === null) {
      continue;
    }
    let size: number | undefined;
    try {
      const stat = statSync(path);
      size = stat.isFile() ? stat.size : undefined;
    } catch {
      // Missing and unreadable files share one public outcome that does not echo the path.
    }
    if (size === undefined || size > MAX_TOAST_IMAGE_BYTES) {
      throw new BunawayError({
        code: "INVALID_ARGUMENT",
        message:
          size === undefined
            ? "Notification image file was not found."
            : "Notification image file is too large.",
      });
    }
  }
}

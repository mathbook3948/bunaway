import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import {
  MAX_NATIVE_ICO_BYTES,
  parseNativeIco,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";

const MAX_TRAY_ICON_PATH_UNITS = 260;

function invalid(message: string): never {
  throw new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/**
 * Check a declared tray icon path without touching the file system. Only a relative path made of
 * plain segments is accepted: no drive, UNC or device prefix, no URL scheme, no `..` or `.` segment,
 * and no stream or reserved Windows characters.
 */
export function validateTrayIconPath(icon: unknown): string {
  if (typeof icon !== "string" || icon.length === 0) {
    return invalid("desktop.tray.icon must be a non-empty resource path.");
  }
  if (icon.length > MAX_TRAY_ICON_PATH_UNITS) {
    return invalid("desktop.tray.icon is too long.");
  }
  if (
    /[<>:"|?*\uD800-\uDFFF]/u.test(icon) ||
    [
      ...icon,
    ].some((character) => (character.codePointAt(0) ?? 0) < 0x20)
  ) {
    return invalid("desktop.tray.icon contains characters a path cannot hold.");
  }
  if (isAbsolute(icon) || win32.isAbsolute(icon) || /^[\\/]/u.test(icon)) {
    return invalid(
      "desktop.tray.icon must be relative to the resources directory.",
    );
  }
  const segments = icon.split(/[\\/]/u);
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return invalid(
      "desktop.tray.icon must not contain empty, . or .. segments.",
    );
  }
  if (segments.some((segment) => /[. ]$/u.test(segment))) {
    return invalid(
      "desktop.tray.icon segments must not end with a dot or space.",
    );
  }
  return icon;
}

/**
 * Read the declared tray icon from the app resources directory and return it as the base64 ICO
 * the tray accepts. The canonical file must stay inside the canonical resources directory, so a
 * symlink or junction cannot lead outside it.
 */
export async function readTrayIcon(
  resources: string | undefined,
  icon: unknown,
): Promise<string> {
  const declared = validateTrayIconPath(icon);
  if (!resources) {
    return invalid("desktop.tray.icon needs an app resources directory.");
  }
  const root = await realpath(resolve(resources));
  let canonical: string;
  try {
    canonical = await realpath(resolve(root, declared));
  } catch {
    return invalid(`desktop.tray.icon was not found: ${declared}`);
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
  const handle = await open(canonical, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      return invalid("desktop.tray.icon must be a file.");
    }
    if (info.size > MAX_NATIVE_ICO_BYTES) {
      return invalid("desktop.tray.icon is larger than the ICO limit.");
    }
    const base64 = (await handle.readFile()).toString("base64");
    if (!parseNativeIco(base64)) {
      return invalid("desktop.tray.icon is not a valid ICO file.");
    }
    return base64;
  } finally {
    await handle.close();
  }
}

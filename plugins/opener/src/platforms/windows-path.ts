import { BunawayError } from "@bunaway/plugin";
import { isWindowsFileName } from "@bunaway/protocol";
import {
  MAX_FILE_PATH_LENGTH,
  type ShortcutDetails,
  type ShortcutOperation,
  shortcutDetailsSchema,
} from "#opener/contract";

const MAX_FILE_NAME_LENGTH = 255;
/** A selected application is a native executable, not a shell command or shortcut. */
export function normalizeApplicationPath(input: unknown): string {
  const path = normalizeFilePath(input);
  if (!/\.exe$/i.test(path)) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Expected an absolute Windows .exe application path.",
    });
  }
  return path;
}
/** A shortcut file is a Windows `.lnk` file, so the Shell never treats another file as a link. */
export function normalizeShortcutPath(input: unknown): string {
  const path = normalizeFilePath(input);
  if (!/\.lnk$/i.test(path)) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Expected an absolute Windows .lnk shortcut path.",
    });
  }
  return path;
}

/**
 * Validate shortcut properties without filesystem access. Targets, working directories
 * and icon files are absolute paths that need not exist yet; `create` and `replace` start
 * from an empty link and so need a target.
 */
export function normalizeShortcutDetails(
  input: unknown,
  operation: ShortcutOperation,
): ShortcutDetails {
  const parsed = shortcutDetailsSchema.safeParse(input);
  if (!parsed.success) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Invalid shortcut properties.",
    });
  }
  const details = parsed.data;
  if (operation !== "update" && details.target === undefined) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "A shortcut target is required.",
    });
  }
  const normalized: ShortcutDetails = {
    ...details,
  };
  for (const key of [
    "target",
    "cwd",
    "icon",
  ] as const) {
    const value = details[key];
    // An empty working directory or icon file clears the property; the target cannot be cleared.
    if (value !== undefined && !(value === "" && key !== "target")) {
      normalized[key] = normalizeFilePath(value);
    }
  }
  return normalized;
}

/** Validate a fully qualified Windows file path without filesystem access. */
export function normalizeFilePath(input: unknown): string {
  const invalid = () =>
    new BunawayError({
      code: "INVALID_ARGUMENT",
      message:
        "Expected an absolute Windows file path of at most 259 UTF-16 code units.",
    });
  if (
    typeof input !== "string" ||
    input.length > MAX_FILE_PATH_LENGTH ||
    /[\p{Cc}\p{Cs}<>:"|?*]/u.test(input.slice(2))
  ) {
    throw invalid();
  }
  const path = input.replaceAll("/", "\\");
  const drivePath = /^[A-Za-z]:\\/.test(path);
  const parts = path.split("\\");
  const rootParts = drivePath ? 1 : 4;
  if (!drivePath && (!path.startsWith("\\\\") || !parts[2] || !parts[3])) {
    throw invalid();
  }
  const names = drivePath ? parts.slice(1) : parts.slice(2);
  if (
    parts.length <= rootParts ||
    names.some((part) => !isWindowsFileName(part, MAX_FILE_NAME_LENGTH))
  ) {
    throw invalid();
  }
  return drivePath ? `${path.charAt(0).toUpperCase()}${path.slice(1)}` : path;
}

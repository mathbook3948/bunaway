import { BunawayError, s } from "@bunaway/plugin";

// Explorer's file operations use ordinary Win32 paths, not extended device paths.
export const MAX_FILE_PATH_LENGTH = 259;
const MAX_FILE_NAME_LENGTH = 255;
export const fileInput = s.object({
  path: s.string({
    maxLength: MAX_FILE_PATH_LENGTH,
  }),
});

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
    names.some(
      (part) =>
        !part ||
        part.length > MAX_FILE_NAME_LENGTH ||
        part === "." ||
        part === ".." ||
        /[ .]$/.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part),
    )
  ) {
    throw invalid();
  }
  return drivePath ? `${path.charAt(0).toUpperCase()}${path.slice(1)}` : path;
}

// Characters Windows rejects in a single path component.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Windows file-name restrictions.
const INVALID_CHARACTERS = /[<>:"/\\|?*\x00-\x1f]/;
// Legacy device names are reserved with or without an extension; superscript digits count as well.
const RESERVED_DEVICE_NAME =
  /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const TRAILING_DOT_OR_SPACE = /[. ]$/;

/** NTFS limit for one path component, in UTF-16 code units. */
export const WINDOWS_MAX_FILE_NAME_LENGTH = 255;

export function isWindowsReservedDeviceName(name: string): boolean {
  return RESERVED_DEVICE_NAME.test(name);
}

/** Validates one path component: no separators or forbidden characters, no reserved device name, no trailing dot or space. */
export function isWindowsFileName(
  name: string,
  maxLength = WINDOWS_MAX_FILE_NAME_LENGTH,
): boolean {
  return (
    name.length > 0 &&
    name.length <= maxLength &&
    name !== "." &&
    name !== ".." &&
    !INVALID_CHARACTERS.test(name) &&
    !TRAILING_DOT_OR_SPACE.test(name) &&
    !isWindowsReservedDeviceName(name)
  );
}

/** Validates a `<stem>.exe` file name whose stem is at most `maxStemLength` code units. */
export function isWindowsExecutableName(
  name: string,
  maxStemLength = WINDOWS_MAX_FILE_NAME_LENGTH - ".exe".length,
): boolean {
  return (
    /\.exe$/i.test(name) &&
    isWindowsFileName(name.slice(0, -".exe".length), maxStemLength) &&
    isWindowsFileName(name)
  );
}

/** Replaces forbidden characters with `_` and trims trailing dots and spaces. */
export function sanitizeWindowsFileName(name: string): string {
  return name
    .replace(new RegExp(INVALID_CHARACTERS, "g"), "_")
    .replace(/[. ]+$/, "");
}

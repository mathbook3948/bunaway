import { win32 } from "node:path";
import { BunawayError, isWindowsFileName } from "@bunaway/protocol";

const DRIVE_OR_UNC_ROOT = /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)$/;
/** Device namespace and NT object prefixes name devices, not files. */
const DEVICE_PREFIXES = [
  "\\\\?\\",
  "\\\\.\\",
  "\\??\\",
  "\\\\??\\",
];

function invalidPath(): BunawayError {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message: "Invalid storage path.",
  });
}

/**
 * Check the syntax of an app-selected Windows path and return it with backslashes. The path must
 * start at a drive or a UNC share and contain only valid file names, so the path means the same
 * thing in every process and an app's own prefix checks cannot be bypassed with `.`, `..`, empty
 * parts, device names or trailing dots. No file system access happens here; which locations an app
 * may use is the app's decision.
 */
export function normalizeWindowsPath(input: string): string {
  const path = input.replaceAll("/", "\\");
  if (DEVICE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw invalidPath();
  }
  const root = win32.parse(path).root;
  if (!DRIVE_OR_UNC_ROOT.test(root)) {
    throw invalidPath();
  }
  const names = path.slice(root.length).split("\\");
  if (names.some((name) => !isWindowsFileName(name))) {
    throw invalidPath();
  }
  return path;
}

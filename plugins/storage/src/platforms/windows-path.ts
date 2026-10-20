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

const EXTENDED_PREFIX = "\\\\?\\";
const EXTENDED_UNC_PREFIX = "\\\\?\\UNC\\";

/**
 * The spelling used for file system calls: a path already checked by `normalizeWindowsPath`, with
 * the extended-length prefix. Without it Windows refuses a directory path of 248 characters or
 * more and a file path of 260 or more unless the process opted in to long paths. The prefix is
 * added to every path, not only long ones, because a folder walk starts at a short root and
 * builds longer child paths from it. Node adds it to every absolute path too. The checked path has
 * no `.`, `..` or empty parts, so the prefix, which turns off the system's own normalization,
 * changes nothing else. The prefix stays inside the plugin: results and mapped errors never carry
 * it.
 */
export function toFileSystemPath(path: string): string {
  return path.startsWith("\\\\")
    ? `${EXTENDED_UNC_PREFIX}${path.slice(2)}`
    : `${EXTENDED_PREFIX}${path}`;
}

/** Check an app-selected path and return the spelling used for file system calls. */
export function normalizeForFileSystem(input: string): string {
  return toFileSystemPath(normalizeWindowsPath(input));
}

/** Undo `toFileSystemPath`, so paths compare by the spelling the app used. */
export function fromFileSystemPath(path: string): string {
  if (path.startsWith(EXTENDED_UNC_PREFIX)) {
    return `\\\\${path.slice(EXTENDED_UNC_PREFIX.length)}`;
  }
  return path.startsWith(EXTENDED_PREFIX)
    ? path.slice(EXTENDED_PREFIX.length)
    : path;
}

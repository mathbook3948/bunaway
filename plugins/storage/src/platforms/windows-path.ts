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

/**
 * Paths of this many characters or more get the extended-length prefix before the file system
 * call. A directory cannot be created at 248 characters or more without it, and a file path of
 * 260 or more fails without it unless the process opted in to long paths. Node and Rust's std
 * add the prefix on their own for the same reason.
 */
const EXTENDED_LENGTH_THRESHOLD = 248;
const EXTENDED_PREFIX = "\\\\?\\";
const EXTENDED_UNC_PREFIX = "\\\\?\\UNC\\";

/**
 * The spelling used for file system calls: a path already checked by `normalizeWindowsPath`,
 * with the `\\?\` prefix added when it is long enough to need it. The path has no `.`, `..` or empty
 * parts, so the prefix, which turns off the system's own normalization, changes nothing else.
 * The prefix stays inside the plugin: results and errors never carry it.
 */
export function toFileSystemPath(path: string): string {
  if (path.length < EXTENDED_LENGTH_THRESHOLD) {
    return path;
  }
  return path.startsWith("\\\\")
    ? `${EXTENDED_UNC_PREFIX}${path.slice(2)}`
    : `${EXTENDED_PREFIX}${path}`;
}

/** Undo `toFileSystemPath`, so paths of different lengths compare by their own spelling. */
export function fromFileSystemPath(path: string): string {
  if (path.startsWith(EXTENDED_UNC_PREFIX)) {
    return `\\\\${path.slice(EXTENDED_UNC_PREFIX.length)}`;
  }
  return path.startsWith(EXTENDED_PREFIX)
    ? path.slice(EXTENDED_PREFIX.length)
    : path;
}

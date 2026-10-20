import { BunawayError } from "@bunaway/protocol";

/** The longest path the kernel accepts, counting the terminating NUL. */
const MAX_PATH_BYTES = 1024;
const MAX_NAME_BYTES = 255;

function invalidPath(): BunawayError {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message: "Invalid storage path.",
  });
}

/**
 * Check the syntax of an app-selected macOS path and return it unchanged. The path must be
 * absolute and made of plain names, so it means the same thing in every process and an app's
 * own prefix checks cannot be bypassed with `.`, `..` or empty parts. UTF-16 that cannot
 * round-trip through UTF-8 is refused because the kernel would see a different name. No file
 * system access happens here; which locations an app may use is the app's decision.
 */
export function normalizeMacosPath(path: string): string {
  if (
    !path.startsWith("/") ||
    Buffer.byteLength(path) >= MAX_PATH_BYTES ||
    Buffer.from(path).toString() !== path ||
    /[\0\r\n]/u.test(path)
  ) {
    throw invalidPath();
  }
  const names = path.slice(1).split("/");
  if (
    names.some(
      (name) =>
        !name ||
        name === "." ||
        name === ".." ||
        Buffer.byteLength(name) > MAX_NAME_BYTES,
    )
  ) {
    throw invalidPath();
  }
  return path;
}

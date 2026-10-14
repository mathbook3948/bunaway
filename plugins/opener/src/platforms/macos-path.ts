import { BunawayError } from "@bunaway/protocol";
import { MAX_FILE_PATH_LENGTH } from "#opener/contract";
/** Validate POSIX file input within the existing shared path budget, without I/O. */
export function normalizeMacosFilePath(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > MAX_FILE_PATH_LENGTH ||
    !input.startsWith("/") ||
    /[\p{Cc}\p{Cs}]/u.test(input) ||
    input
      .slice(1)
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          new TextEncoder().encode(part).byteLength > 255,
      )
  ) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message:
        "Expected an absolute POSIX file path within the opener path limit.",
    });
  }
  return input;
}

import { BunawayError } from "@bunaway/protocol";

/**
 * A letter followed by letters, digits, `+`, `.` or `-`, two to 32 characters. One-letter
 * schemes are excluded because `desktop.onOpen` reads them as Windows drive paths. This is
 * the rule the installer applies to its declared URL schemes.
 */
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}$/;

/**
 * Schemes an app may not take over. Writing them to the user's classes hive would shadow
 * handlers the system or the browser owns and that no UserChoice entry protects: web and
 * mail schemes, script-capable schemes, and schemes the Shell treats specially.
 */
const RESERVED_SCHEMES: ReadonlySet<string> = new Set([
  "http",
  "https",
  "file",
  "ftp",
  "mailto",
  "tel",
  "ws",
  "wss",
  "about",
  "javascript",
  "vbscript",
  "data",
  "blob",
  "view-source",
  "res",
  "shell",
  "search",
  "search-ms",
]);
/** Prefixes of Windows-owned scheme families such as `ms-settings` and `microsoft-edge`. */
const RESERVED_PREFIXES = [
  "ms-",
  "microsoft-",
  "microsoft.",
];

/** True when the scheme is well formed and not reserved; letter case is ignored. */
export function isRegistrableUrlScheme(scheme: string): boolean {
  const lower = scheme.toLowerCase();
  return (
    URL_SCHEME_PATTERN.test(lower) &&
    !RESERVED_SCHEMES.has(lower) &&
    !RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

/**
 * Validate an untrusted URL scheme for registration and return its lowercase form.
 * @throws {BunawayError} If it is malformed or reserved.
 */
export function normalizeUrlScheme(input: unknown): string {
  if (typeof input !== "string" || !isRegistrableUrlScheme(input)) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message:
        "Expected a URL scheme of 2 to 32 letters, digits, plus, dot or hyphen that the system does not reserve.",
    });
  }
  return input.toLowerCase();
}

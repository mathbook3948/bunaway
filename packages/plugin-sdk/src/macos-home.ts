import { BunawayError } from "@bunaway/protocol";

/** Where the host keeps an app's data, relative to the user's home. */
const DATA_ROOT_PARENT = "Library/Application Support/bunaway";

/** The documented UTF-16 code unit bound for a path string. */
const MAX_PATH_CODE_UNITS = 4096;

/**
 * The I/O worker's HOME and TMPDIR point at the host data root, so `os.homedir()` is not the
 * user's home. The home is the data root without its fixed
 * `<home>/Library/Application Support/bunaway/<appId>` layout. A data root that does not end in
 * that layout, or whose remainder is not a POSIX absolute path of at most 4096 UTF-16 code units
 * without NUL, CR or LF, is rejected with `INTERNAL`. Inside an App Sandbox container the data
 * root, and therefore this home, is the container's.
 */
export function macosUserHome(dataRoot: string, appId: string): string {
  const suffix = `/${DATA_ROOT_PARENT}/${appId}`;
  const home = dataRoot.endsWith(suffix)
    ? dataRoot.slice(0, -suffix.length)
    : undefined;
  if (
    home === undefined ||
    !home.startsWith("/") ||
    home.length > MAX_PATH_CODE_UNITS ||
    [
      "\0",
      "\r",
      "\n",
    ].some((char) => home.includes(char))
  ) {
    throw new BunawayError({
      code: "INTERNAL",
      message: "The host data root does not match the macOS app layout.",
    });
  }
  return home;
}

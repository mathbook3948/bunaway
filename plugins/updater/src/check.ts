import { BunawayError, isRecord } from "@bunaway/protocol";
import {
  MAX_DATE_LENGTH,
  MAX_MANIFEST_BYTES,
  MAX_NOTES_LENGTH,
  MAX_REDIRECTS,
  MAX_URL_LENGTH,
  UPDATER_CHECK_TIMEOUT_MS,
  type UpdaterCheckResult,
  type UpdaterFailureReason,
} from "#updater/contract";
import {
  type EndpointValues,
  expandEndpoint,
  isAllowedUrl,
} from "#updater/endpoint";
import { compareSemVer, parseSemVer } from "#updater/semver";

/** Everything a check needs; the adapter fills it from the host environment. */
export type CheckOptions = {
  template: string;
  channel: string;
  /** Update manifest target word, such as `windows` or `darwin`. */
  target: string;
  /** Update manifest architecture word, or null when this CPU has no update target. */
  arch: string | null;
  /** The app's own version, or null when the build recorded none. */
  appVersion: string | null;
  /** Development launches may use http on a loopback host. */
  development: boolean;
  fetch: typeof fetch;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
};

function fail(
  code: "UNSUPPORTED" | "INTERNAL",
  reason: UpdaterFailureReason,
  message: string,
  extra: Record<string, number> = {},
): BunawayError {
  return new BunawayError({
    code,
    message,
    details: {
      reason,
      ...extra,
    },
  });
}

/** A line break or tab is ordinary text; every other control character (C0, DEL, C1) is rejected. */
function hasControlCharacter(text: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check itself.
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text);
}

/** Stop reading a body that is not needed. */
async function discardBody(
  body:
    | {
        cancel(): Promise<void>;
      }
    | null
    | undefined,
): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // The body is discarded; a stream that already failed has nothing left to release.
  }
}

/** Read at most `MAX_MANIFEST_BYTES` of the (already decompressed) body. */
async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      bytes += result.value.byteLength;
      if (bytes > MAX_MANIFEST_BYTES) {
        throw fail("INTERNAL", "tooLarge", "Update manifest is too large.");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof BunawayError || signal.aborted) {
      throw error;
    }
    throw fail("INTERNAL", "network", "Update server connection failed.");
  } finally {
    // Cancelling an already-consumed reader is safe; aborting the request also stops a blocked read.
    await discardBody(reader);
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
    }).decode(joined);
  } catch {
    throw fail(
      "INTERNAL",
      "invalidJson",
      "Update manifest is not valid UTF-8.",
    );
  }
}

/** Follow up to `MAX_REDIRECTS` redirects by hand so every hop is checked against the URL rules. */
async function fetchManifest(
  start: URL,
  options: CheckOptions,
  signal: AbortSignal,
): Promise<Response> {
  let url = start;
  for (let redirects = 0; ; redirects++) {
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
        },
        redirect: "manual",
        credentials: "omit",
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw fail("INTERNAL", "network", "Update server could not be reached.");
    }
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    await discardBody(response.body);
    const location = response.headers.get("location");
    if (!location || response.status === 304) {
      throw fail(
        "INTERNAL",
        "httpStatus",
        "Update server answered without a usable redirect.",
        {
          status: response.status,
        },
      );
    }
    if (redirects >= MAX_REDIRECTS) {
      throw fail(
        "INTERNAL",
        "redirectLimit",
        "Update server redirected too often.",
      );
    }
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw fail(
        "INTERNAL",
        "redirectScheme",
        "Update server redirected to an invalid URL.",
      );
    }
    if (
      !isAllowedUrl(next, options.development) ||
      (url.protocol === "https:" && next.protocol !== "https:")
    ) {
      throw fail(
        "INTERNAL",
        "redirectScheme",
        "Update server redirected to a disallowed URL.",
      );
    }
    url = next;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Pick the download URL: the platform entry of a static manifest, else the top-level `url`. */
function downloadUrl(manifest: Record<string, unknown>, key: string): unknown {
  const platforms = manifest.platforms;
  if (platforms !== undefined) {
    if (!isRecord(platforms)) {
      throw fail(
        "INTERNAL",
        "invalidManifest",
        "Update manifest platforms is not an object.",
      );
    }
    const entry = platforms[key];
    if (entry !== undefined) {
      return isRecord(entry) ? entry.url : undefined;
    }
  }
  return manifest.url;
}

function exposedDownloadUrl(value: unknown, development: boolean): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    throw fail(
      "INTERNAL",
      "invalidManifest",
      "Update download URL is missing or too long.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw fail(
      "INTERNAL",
      "invalidManifest",
      "Update download URL is not a valid URL.",
    );
  }
  if (!isAllowedUrl(parsed, development)) {
    throw fail(
      "INTERNAL",
      "invalidManifest",
      "Update download URL must be https without credentials.",
    );
  }
  // Normalization can lengthen the address (percent-encoding), so the limit applies to what is returned.
  if (parsed.href.length > MAX_URL_LENGTH) {
    throw fail(
      "INTERNAL",
      "invalidManifest",
      "Update download URL is missing or too long.",
    );
  }
  return parsed.href;
}

function exposedNotes(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length > MAX_NOTES_LENGTH ||
    hasControlCharacter(value)
  ) {
    throw fail(
      "INTERNAL",
      "invalidManifest",
      "Update notes are too long or contain control characters.",
    );
  }
  return value;
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

/** Whether the calendar date exists, since `Date` would roll 02-31 over to March. */
function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Range-check every field: `Date` accepts 24:00 and rolls a nonexistent day over. */
function isValidTimestamp(match: RegExpExecArray): boolean {
  const field = (index: number) => Number(match[index] ?? 0);
  return (
    isCalendarDate(field(1), field(2), field(3)) &&
    field(4) <= 23 &&
    field(5) <= 59 &&
    field(6) <= 59 &&
    field(7) <= 23 &&
    field(8) <= 59
  );
}

function exposedDate(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const match =
    typeof value === "string" && value.length <= MAX_DATE_LENGTH
      ? RFC3339.exec(value)
      : null;
  const parsed =
    typeof value === "string" && match && isValidTimestamp(match)
      ? new Date(value)
      : undefined;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw fail(
      "INTERNAL",
      "invalidManifest",
      "Update publication date is not an RFC 3339 timestamp.",
    );
  }
  return parsed.toISOString();
}

/**
 * Ask the app's fixed endpoint whether a newer version exists. Nothing is downloaded or installed,
 * and the manifest signature is neither read nor checked here.
 */
export async function checkForUpdate(
  options: CheckOptions,
): Promise<UpdaterCheckResult> {
  if (options.appVersion === null) {
    throw fail(
      "UNSUPPORTED",
      "appVersionMissing",
      "The app build recorded no version.",
    );
  }
  const current = parseSemVer(options.appVersion);
  if (!current) {
    throw fail(
      "UNSUPPORTED",
      "appVersionInvalid",
      "The app version is not a SemVer 2.0.0 version.",
    );
  }
  if (options.arch === null) {
    throw fail(
      "UNSUPPORTED",
      "unsupportedArch",
      "This CPU architecture has no update target.",
    );
  }
  const values: EndpointValues = {
    target: options.target,
    arch: options.arch,
    channel: options.channel,
    current_version: options.appVersion,
  };
  const start = expandEndpoint(options.template, values);
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? UPDATER_CHECK_TIMEOUT_MS);
  const signal = AbortSignal.any([
    controller.signal,
    ...(options.signal
      ? [
          options.signal,
        ]
      : []),
  ]);
  try {
    const response = await fetchManifest(start, options, signal);
    const none: UpdaterCheckResult = {
      updateAvailable: false,
      currentVersion: options.appVersion,
      version: null,
      notes: null,
      publishedAt: null,
      downloadUrl: null,
    };
    if (response.status === 204) {
      await discardBody(response.body);
      return none;
    }
    if (response.status !== 200) {
      await discardBody(response.body);
      throw fail(
        "INTERNAL",
        "httpStatus",
        "Update server answered with an error status.",
        {
          status: response.status,
        },
      );
    }
    const body = await readBody(response, signal);
    let manifest: unknown;
    try {
      manifest = JSON.parse(body);
    } catch {
      throw fail(
        "INTERNAL",
        "invalidJson",
        "Update manifest is not valid JSON.",
      );
    }
    if (!isRecord(manifest)) {
      throw fail(
        "INTERNAL",
        "invalidManifest",
        "Update manifest is not an object.",
      );
    }
    const versionText = text(manifest.version);
    const remote = versionText === undefined ? null : parseSemVer(versionText);
    if (versionText === undefined || !remote) {
      throw fail(
        "INTERNAL",
        "invalidVersion",
        "Update manifest version is missing or not SemVer 2.0.0.",
      );
    }
    if (compareSemVer(remote, current) <= 0) {
      return none;
    }
    const key = `${options.target}-${options.arch}`;
    const url = downloadUrl(manifest, key);
    if (url === undefined) {
      throw fail(
        "INTERNAL",
        "platformMissing",
        "Update manifest has no entry for this platform.",
      );
    }
    return {
      updateAvailable: true,
      currentVersion: options.appVersion,
      version: versionText,
      notes: exposedNotes(manifest.notes),
      publishedAt: exposedDate(manifest.pub_date),
      downloadUrl: exposedDownloadUrl(url, options.development),
    };
  } catch (error) {
    if (timedOut) {
      throw new BunawayError({
        code: "TIMEOUT",
        message: "Update check timed out.",
      });
    }
    if (options.signal?.aborted) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Update check was cancelled.",
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

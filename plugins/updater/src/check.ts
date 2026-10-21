import { BunawayError, isRecord } from "@bunaway/protocol";
import {
  MAX_DATE_LENGTH,
  MAX_MANIFEST_BYTES,
  MAX_NOTES_LENGTH,
  MAX_URL_LENGTH,
  UPDATER_CHECK_TIMEOUT_MS,
  type UpdaterCheckResult,
  type UpdateTarget,
} from "#updater/contract";
import {
  type EndpointValues,
  expandEndpoint,
  isAllowedUrl,
} from "#updater/endpoint";
import { discardBody, fail, fetchFollowingRedirects } from "#updater/request";
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

/** A line break or tab is ordinary text; every other control character (C0, DEL, C1) is rejected. */
function hasControlCharacter(text: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check itself.
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text);
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
  // setUTCFullYear keeps years 0 to 99 as written; Date.UTC would map them to 1900 to 1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
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
  // The offset can carry the instant outside years 0000 to 9999, which ISO 8601 cannot print as four digits.
  if (parsed.getUTCFullYear() < 0 || parsed.getUTCFullYear() > 9999) {
    throw fail(
      "INTERNAL",
      "invalidManifest",
      "Update publication date is outside the supported years.",
    );
  }
  return parsed.toISOString();
}

/** The public result of a check; nothing is downloaded or installed. */
export async function checkForUpdate(
  options: CheckOptions,
): Promise<UpdaterCheckResult> {
  return (await checkForUpdateTarget(options)).result;
}

/** Read the package integrity fields next to the download URL: the platform entry, else the top level. */
function integrityFields(
  manifest: Record<string, unknown>,
  key: string,
): {
  sha256: unknown;
  size: unknown;
} {
  const platforms = manifest.platforms;
  const entry = isRecord(platforms) ? platforms[key] : undefined;
  const source = isRecord(entry) ? entry : manifest;
  return {
    sha256: source.sha256,
    size: source.size,
  };
}

/**
 * Ask the app's fixed endpoint whether a newer version exists, and keep what a later download needs.
 * The manifest signature is neither read nor checked here.
 */
export async function checkForUpdateTarget(options: CheckOptions): Promise<{
  result: UpdaterCheckResult;
  target: UpdateTarget | null;
}> {
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
    const response = await fetchFollowingRedirects(
      start,
      {
        ...options,
        accept: "application/json",
      },
      signal,
    );
    const none: UpdaterCheckResult = {
      updateAvailable: false,
      currentVersion: options.appVersion,
      version: null,
      notes: null,
      publishedAt: null,
      downloadUrl: null,
    };
    const nothing = {
      result: none,
      target: null,
    };
    if (response.status === 204) {
      await discardBody(response.body);
      return nothing;
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
      return nothing;
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
    const exposedUrl = exposedDownloadUrl(url, options.development);
    return {
      result: {
        updateAvailable: true,
        currentVersion: options.appVersion,
        version: versionText,
        notes: exposedNotes(manifest.notes),
        publishedAt: exposedDate(manifest.pub_date),
        downloadUrl: exposedUrl,
      },
      target: {
        version: versionText,
        url: exposedUrl,
        ...integrityFields(manifest, key),
      },
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

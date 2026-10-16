import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAX_OPEN_URLS,
  MAX_OPEN_URLS_BYTES,
} from "@bunaway/runtime-bun/worker-channel";

/** Why one entry of an open request was not forwarded to `onOpenUrls`. */
export type RejectedOpenUrl = {
  /** Position of the entry in the request AppKit delivered. */
  index: number;
  reason:
    | "invalid-url"
    | "file-host"
    | "encoded-separator"
    | "encoded-nul"
    | "invalid-file-path";
};

/** The result of normalizing one open request. */
export type NormalizedOpenUrls =
  | {
      /** The whole request exceeded the entry-count or total-size limit. */
      readonly rejectedAll: "too-many-urls" | "too-large";
      readonly urls: readonly [];
      readonly rejected: readonly [];
    }
  | {
      readonly rejectedAll?: undefined;
      /** Accepted URLs in arrival order. */
      readonly urls: readonly string[];
      readonly rejected: readonly RejectedOpenUrl[];
    };

/** Path escapes that would let one `file:` URL name a different path than its segments show. */
const ENCODED_SEPARATOR = /%2f/i;
const ENCODED_NUL = /%00/;

/**
 * Normalizes a `file:` URL to the canonical form of the path it names (POSIX). Returns the
 * rejection reason instead when the URL cannot name a local file unambiguously.
 */
function canonicalFileUrl(url: URL):
  | {
      href: string;
    }
  | {
      reason: RejectedOpenUrl["reason"];
    } {
  if (url.hostname !== "" && url.hostname !== "localhost") {
    return {
      reason: "file-host",
    };
  }
  if (ENCODED_SEPARATOR.test(url.pathname)) {
    return {
      reason: "encoded-separator",
    };
  }
  if (ENCODED_NUL.test(url.pathname)) {
    return {
      reason: "encoded-nul",
    };
  }
  try {
    return {
      // macOS paths are POSIX; the explicit option keeps the result the same on any test host.
      href: pathToFileURL(
        fileURLToPath(url, {
          windows: false,
        }),
        {
          windows: false,
        },
      ).href,
    };
  } catch {
    return {
      reason: "invalid-file-path",
    };
  }
}

/**
 * Turns the URL strings AppKit delivered (`NSURL.absoluteString` of an `application:openURLs:`
 * request, which covers both URL scheme and document opens) into the `onOpenUrls` list.
 *
 * The request is limited like launch arguments (ADR 0013): more than `MAX_OPEN_URLS` entries or
 * more than `MAX_OPEN_URLS_BYTES` UTF-8 bytes in total rejects all of it. Otherwise each entry is
 * judged alone: an invalid URL or an ambiguous `file:` URL (a remote host, an encoded `/` or NUL
 * in the path) is rejected, a `file:` URL becomes its canonical form, and any other URL becomes
 * `URL.href`. Never throws. Rejections carry only the entry index and a reason, because URLs may
 * hold secrets that must not reach diagnostics.
 *
 * @param receivedCount How many URLs AppKit delivered. It can exceed `rawUrls.length` because the
 * caller skips copying a request that is over the entry limit; such a request is rejected whole.
 */
export function normalizeOpenUrls(
  rawUrls: readonly string[],
  receivedCount = rawUrls.length,
): NormalizedOpenUrls {
  if (receivedCount > MAX_OPEN_URLS) {
    return {
      rejectedAll: "too-many-urls",
      urls: [],
      rejected: [],
    };
  }
  const totalBytes = rawUrls.reduce(
    (bytes, raw) => bytes + Buffer.byteLength(raw),
    0,
  );
  if (totalBytes > MAX_OPEN_URLS_BYTES) {
    return {
      rejectedAll: "too-large",
      urls: [],
      rejected: [],
    };
  }
  const urls: string[] = [];
  const rejected: RejectedOpenUrl[] = [];
  rawUrls.forEach((raw, index) => {
    const parsed = URL.parse(raw);
    if (!parsed) {
      rejected.push({
        index,
        reason: "invalid-url",
      });
      return;
    }
    if (parsed.protocol !== "file:") {
      urls.push(parsed.href);
      return;
    }
    const canonical = canonicalFileUrl(parsed);
    if ("href" in canonical) {
      urls.push(canonical.href);
    } else {
      rejected.push({
        index,
        reason: canonical.reason,
      });
    }
  });
  return {
    urls,
    rejected,
  };
}

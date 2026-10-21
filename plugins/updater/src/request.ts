import { BunawayError } from "@bunaway/protocol";
import { MAX_REDIRECTS, type UpdaterFailureReason } from "#updater/contract";
import { isAllowedUrl } from "#updater/endpoint";

/** What a request to the update server needs; the manifest check and the package download share it. */
export type RequestOptions = {
  fetch: typeof fetch;
  /** Development launches may use http on a loopback host. */
  development: boolean;
  accept: string;
};

export function fail(
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

/** Stop reading a body that is not needed. */
export async function discardBody(
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

/** Follow up to `MAX_REDIRECTS` redirects by hand so every hop is checked against the URL rules. */
export async function fetchFollowingRedirects(
  start: URL,
  options: RequestOptions,
  signal: AbortSignal,
): Promise<Response> {
  let url = start;
  for (let redirects = 0; ; redirects++) {
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: "GET",
        headers: {
          accept: options.accept,
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

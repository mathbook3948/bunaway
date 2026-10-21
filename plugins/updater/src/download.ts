import { BunawayError } from "@bunaway/protocol";
import {
  MAX_PACKAGE_BYTES,
  type PackageFiles,
  type PackageSink,
  UPDATER_DOWNLOAD_TIMEOUT_MS,
  type UpdaterDownloadResult,
  type UpdateTarget,
} from "#updater/contract";
import { discardBody, fail, fetchFollowingRedirects } from "#updater/request";

/** Everything a download needs; the adapter fills it from the last check and the host environment. */
export type DownloadOptions = {
  target: UpdateTarget;
  files: PackageFiles;
  /** Development launches may use http on a loopback host. */
  development: boolean;
  fetch: typeof fetch;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
};

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

/** Validate the manifest's integrity fields; a package is never fetched without both. */
function declaredIntegrity(target: UpdateTarget): {
  sha256: string;
  size: number;
} {
  if (target.sha256 === undefined || target.size === undefined) {
    throw fail(
      "UNSUPPORTED",
      "integrityMissing",
      "Update manifest declares no sha256 and size for the package.",
    );
  }
  if (typeof target.sha256 !== "string" || !SHA256_HEX.test(target.sha256)) {
    throw fail(
      "INTERNAL",
      "integrityInvalid",
      "Update manifest sha256 is not 64 hexadecimal characters.",
    );
  }
  if (
    typeof target.size !== "number" ||
    !Number.isSafeInteger(target.size) ||
    target.size < 1
  ) {
    throw fail(
      "INTERNAL",
      "integrityInvalid",
      "Update manifest size is not a positive integer.",
    );
  }
  if (target.size > MAX_PACKAGE_BYTES) {
    throw fail("INTERNAL", "tooLarge", "Update package is too large.");
  }
  return {
    sha256: target.sha256.toLowerCase(),
    size: target.size,
  };
}

/** Whether `content-length` describes the bytes the body will deliver (an encoded body may differ). */
function declaredLengthDiffers(response: Response, size: number): boolean {
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    return false;
  }
  const length = response.headers.get("content-length");
  return length !== null && /^\d+$/.test(length) && Number(length) !== size;
}

async function writeBody(
  response: Response,
  sink: PackageSink,
  size: number,
  signal: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  let received = 0;
  try {
    while (reader) {
      const result = await reader.read().catch((error: unknown) => {
        if (signal.aborted) {
          throw error;
        }
        throw fail("INTERNAL", "network", "Update server connection failed.");
      });
      if (result.done) {
        break;
      }
      received += result.value.byteLength;
      if (received > size) {
        throw fail(
          "INTERNAL",
          "sizeMismatch",
          "Update package is larger than the manifest declared.",
        );
      }
      await sink.write(result.value);
    }
  } finally {
    await discardBody(reader);
  }
  if (received !== size) {
    throw fail(
      "INTERNAL",
      "sizeMismatch",
      "Update package is smaller than the manifest declared.",
    );
  }
}

/** Leftovers from earlier downloads are removed on the next success, so a failure here changes nothing. */
async function pruneQuietly(
  files: PackageFiles,
  sha256: string,
): Promise<void> {
  try {
    await files.prune(sha256);
  } catch {
    // The verified package is in place; the leftovers stay until the next successful download.
  }
}

/**
 * Fetch the package the last check found into the app's update folder and keep it only when its
 * size and SHA-256 match the manifest. The file is written under a partial name and removed on any failure.
 */
export async function downloadPackage(
  options: DownloadOptions,
): Promise<UpdaterDownloadResult> {
  const { sha256, size } = declaredIntegrity(options.target);
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? UPDATER_DOWNLOAD_TIMEOUT_MS);
  const signal = AbortSignal.any([
    controller.signal,
    ...(options.signal
      ? [
          options.signal,
        ]
      : []),
  ]);
  const result = (path: string): UpdaterDownloadResult => ({
    path,
    version: options.target.version,
    size,
    sha256,
  });
  let sink: PackageSink | undefined;
  try {
    const existing = await options.files.reuse(sha256, size, signal);
    if (existing !== null) {
      signal.throwIfAborted();
      await pruneQuietly(options.files, sha256);
      return result(existing);
    }
    const response = await fetchFollowingRedirects(
      new URL(options.target.url),
      {
        fetch: options.fetch,
        development: options.development,
        accept: "application/octet-stream",
      },
      signal,
    );
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
    if (declaredLengthDiffers(response, size)) {
      await discardBody(response.body);
      throw fail(
        "INTERNAL",
        "sizeMismatch",
        "Update package length differs from the manifest.",
      );
    }
    sink = await options.files.create(sha256);
    await writeBody(response, sink, size, signal);
    if ((await sink.finish()) !== sha256) {
      throw fail(
        "INTERNAL",
        "integrityMismatch",
        "Update package does not match the manifest sha256.",
      );
    }
    const path = await sink.publish();
    sink = undefined;
    await pruneQuietly(options.files, sha256);
    return result(path);
  } catch (error) {
    try {
      await sink?.discard();
    } catch {
      // A partial file that cannot be removed now is removed by the next successful download; the original failure is the one to report.
    }
    if (timedOut) {
      throw new BunawayError({
        code: "TIMEOUT",
        message: "Update download timed out.",
      });
    }
    if (options.signal?.aborted) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Update download was cancelled.",
      });
    }
    if (error instanceof BunawayError) {
      throw error;
    }
    throw new BunawayError({
      code: "INTERNAL",
      message: "Update package could not be received or stored.",
      details: {
        reason: "storage",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

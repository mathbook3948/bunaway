import {
  type FileHandle,
  link,
  open,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { BunawayError, isWindowsFileName } from "@bunaway/protocol";
import type { z } from "zod";
import type { downloadInputSchema } from "#network/contract";
import { responseHeaders } from "#network/platforms/http";

type DownloadInput = z.output<typeof downloadInputSchema>;

/** Attempts to delete a temporary file that a scanner or indexer may hold open for a moment. */
const PART_DELETE_ATTEMPTS = 3;
const PART_DELETE_RETRY_MS = 50;
/** Hex digits of the download id that make the temporary name unique. */
const PART_SUFFIX_LENGTH = 8;
/** Error codes of a file system without hard links, where the final step falls back to rename. */
const LINK_UNSUPPORTED = new Set([
  "EPERM",
  "ENOTSUP",
  "ENOSYS",
  "EXDEV",
  "EINVAL",
]);

/** A download that has started, addressed by the caller's id and owned by the `source` that began it. */
export type DownloadEntry = {
  readonly source: string;
  readonly controller: AbortController;
  task: Promise<unknown>;
  receivedBytes: number;
  totalBytes: number | null;
};

function invalid(message: string) {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Accept an absolute path made of plain components. On Windows the components follow the file
 * name rules and the `\\?\` and `\\.\` namespaces are refused; elsewhere `.` and `..` are refused.
 */
export function checkDestination(
  path: string,
  windows = process.platform === "win32",
): void {
  if (path.includes("\0")) {
    throw invalid("Expected a path without NUL characters.");
  }
  if (!windows) {
    if (
      !path.startsWith("/") ||
      path.endsWith("/") ||
      path.split("/").some((part) => part === "." || part === "..")
    ) {
      throw invalid("Expected an absolute file path without . or .. parts.");
    }
    return;
  }
  const normalized = path.replaceAll("/", "\\");
  const drive = /^[A-Za-z]:\\/.test(normalized);
  const unc =
    normalized.startsWith("\\\\") &&
    !normalized.startsWith("\\\\?\\") &&
    !normalized.startsWith("\\\\.\\");
  const parts = normalized.split("\\");
  const names = drive ? parts.slice(1) : parts.slice(2);
  // A UNC path needs a server, a share and at least one name below them.
  if (
    (!drive && !unc) ||
    (unc && (!parts[2] || !parts[3] || names.length < 3)) ||
    names.length === 0 ||
    names.some((name) => !isWindowsFileName(name))
  ) {
    throw invalid("Expected an absolute Windows file path.");
  }
}

async function existingKind(path: string) {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "file";
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

/** Fail before any request when the folder is missing or the target may not be replaced. */
async function checkTarget(path: string, overwrite: boolean) {
  if (!isAbsolute(path)) {
    throw invalid("Expected an absolute file path.");
  }
  checkDestination(path);
  if ((await existingKind(dirname(path))) !== "directory") {
    throw invalid("The destination folder does not exist.");
  }
  const kind = await existingKind(path);
  if (kind === "directory" || (kind === "file" && !overwrite)) {
    throw invalid("The destination already exists.");
  }
}

async function removePart(path: string) {
  for (let attempt = 1; attempt <= PART_DELETE_ATTEMPTS; attempt++) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return;
      }
      if (attempt === PART_DELETE_ATTEMPTS) {
        console.error("Temporary download file could not be removed.", error);
        return;
      }
      await Bun.sleep(PART_DELETE_RETRY_MS);
    }
  }
}

/** Move the finished temporary file into place; without `overwrite` an existing target is never replaced. */
async function commit(part: string, path: string, overwrite: boolean) {
  if (overwrite) {
    await rename(part, path);
    return;
  }
  try {
    // link fails when the target exists, so the check and the placement are one step.
    await link(part, path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      throw invalid("The destination already exists.");
    }
    if (code === undefined || !LINK_UNSUPPORTED.has(code)) {
      throw error;
    }
    if ((await existingKind(path)) !== undefined) {
      throw invalid("The destination already exists.");
    }
    await rename(part, path);
  }
}

async function writeBody(
  response: Response,
  input: DownloadInput,
  file: FileHandle,
  signal: AbortSignal,
  entry: {
    receivedBytes: number;
  },
  touch: () => void,
) {
  const reader = response.body?.getReader();
  try {
    if (reader) {
      while (true) {
        signal.throwIfAborted();
        const result = await reader.read();
        if (result.done) {
          break;
        }
        if (entry.receivedBytes + result.value.byteLength > input.maxBytes) {
          throw new BunawayError({
            code: "INTERNAL",
            message: "Response body exceeds the limit.",
          });
        }
        await file.write(result.value);
        entry.receivedBytes += result.value.byteLength;
        touch();
      }
    }
  } finally {
    try {
      await reader?.cancel();
    } finally {
      reader?.releaseLock();
      await file.close();
    }
  }
}

/**
 * Stream a 2xx body into `path` through `<path>.<id>.part`, which replaces the target only after the
 * whole body arrived. Any failure, cancellation or deadline removes the temporary file. Redirects are
 * returned for the app to check again, as `network.request` does.
 */
export async function download(
  input: DownloadInput,
  signal: AbortSignal,
  entry: {
    receivedBytes: number;
    totalBytes: number | null;
  },
  touch: () => void,
) {
  await checkTarget(input.path, input.overwrite);
  signal.throwIfAborted();
  const response = await fetch(input.url, {
    method: "GET",
    // The body is stored as sent, so the announced length is the size the file will have.
    headers: [
      ...input.headers,
      [
        "accept-encoding",
        "identity",
      ],
    ],
    redirect: "manual",
    credentials: "omit",
    signal,
  });
  const headers = responseHeaders(response);
  touch();
  if (response.status < 200 || response.status > 299) {
    await response.body?.cancel();
    return {
      status: response.status,
      headers,
      saved: false,
      bytesWritten: 0,
    };
  }
  const length = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isSafeInteger(length) && length >= 0) {
    if (length > input.maxBytes) {
      await response.body?.cancel();
      throw new BunawayError({
        code: "INTERNAL",
        message: "Response body exceeds the limit.",
      });
    }
    entry.totalBytes = length;
  }
  const part = `${input.path}.${input.downloadId.slice(0, PART_SUFFIX_LENGTH)}.part`;
  // "wx" fails on a leftover of the same name, which this download then leaves alone.
  const file = await open(part, "wx");
  try {
    await writeBody(response, input, file, signal, entry, touch);
    signal.throwIfAborted();
    await commit(part, input.path, input.overwrite);
  } finally {
    // After a rename the name is gone already; after a hard link or a failure it is removed here.
    await removePart(part);
  }
  return {
    status: response.status,
    headers,
    saved: true,
    bytesWritten: entry.receivedBytes,
  };
}

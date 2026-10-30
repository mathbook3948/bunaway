import {
  type FileHandle,
  link,
  lstat,
  open,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { BunawayError, isWindowsFileName } from "@bunaway/protocol";
import type { z } from "zod";
import type { downloadInputSchema } from "#network/contract";
import { responseHeaders } from "#network/platforms/http";

type DownloadInput = z.output<typeof downloadInputSchema>;

/** Attempts (the first included) to delete or place a file that a scanner or indexer may hold open for a moment. */
const FILE_STEP_ATTEMPTS = 3;
const FILE_STEP_RETRY_MS = 50;
/** Error codes that a scanner holding the file can cause, so the step is tried again. */
const TRANSIENT_FILE_ERRORS = new Set([
  "EBUSY",
  "EPERM",
  "EACCES",
]);
/** Hex digits at the end of the download id that make the temporary name unique; the end is random in UUID versions 4 and 7. */
const PART_SUFFIX_LENGTH = 8;
/** Longest final name of a file on NTFS and common POSIX systems, which the temporary name must fit too. */
const MAX_FILE_NAME_LENGTH = 255;
/** Length of the `.`, the last characters of the id and `.part` that are appended to the final name. */
const PART_NAME_OVERHEAD = 1 + PART_SUFFIX_LENGTH + ".part".length;
/** Read size when a file is copied because hard links are unavailable. */
const COPY_CHUNK_BYTES = 1024 * 1024;

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

export function errorCode(error: unknown): string | undefined {
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

/**
 * What occupies a path, or undefined when nothing does. The target itself is read without following
 * a final link, so a dangling link counts as present and `overwrite` replaces the link, not what it names.
 */
async function existingKind(path: string, followLink = true) {
  try {
    const info = await (followLink ? stat(path) : lstat(path));
    return info.isDirectory() ? "directory" : "file";
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

/** NTFS limits a name in UTF-16 units; ext4 and APFS limit it in bytes. */
function nameLength(name: string, windows = process.platform === "win32") {
  return windows ? name.length : Buffer.byteLength(name);
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
  if (nameLength(basename(path)) + PART_NAME_OVERHEAD > MAX_FILE_NAME_LENGTH) {
    throw invalid("The file name is too long.");
  }
  const kind = await existingKind(path, false);
  if (kind === "directory" || (kind === "file" && !overwrite)) {
    throw invalid("The destination already exists.");
  }
}

/** Delete a file this download created, trying again while it is held; a file that stays is named in the log. */
async function removeCreated(path: string, what: string) {
  for (let attempt = 1; attempt <= FILE_STEP_ATTEMPTS; attempt++) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return;
      }
      if (attempt === FILE_STEP_ATTEMPTS) {
        console.error(`The ${what} could not be removed: ${path}`, error);
        return;
      }
      await Bun.sleep(FILE_STEP_RETRY_MS);
    }
  }
}

/** File operations that placing a file uses; tests replace them to make hard links fail. */
export type PlaceOps = {
  link: typeof link;
  rename: typeof rename;
};
const systemPlaceOps: PlaceOps = {
  link,
  rename,
};

/** Run a file step, trying again while a scanner or indexer may hold the file for a moment. */
async function retryTransient<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      const code = errorCode(error);
      if (
        attempt >= FILE_STEP_ATTEMPTS ||
        code === undefined ||
        !TRANSIENT_FILE_ERRORS.has(code)
      ) {
        throw error;
      }
      await Bun.sleep(FILE_STEP_RETRY_MS);
    }
  }
}

/**
 * Copy `part` into a target that this call creates exclusively, for file systems without hard
 * links. The target is created with an exclusive open, so a file that already exists at the path is
 * neither overwritten nor deleted. A copy that fails, is cancelled or cannot be closed removes the
 * target again by name; if that removal stays blocked the partial file is left and named in the log. The copy is not atomic: until it ends the target holds a prefix.
 */
async function copyExclusive(
  part: string,
  path: string,
  touch: () => void,
  signal: AbortSignal,
) {
  let target: FileHandle;
  try {
    target = await open(path, "wx");
  } catch (error) {
    throw errorCode(error) === "EEXIST"
      ? invalid("The destination already exists.")
      : error;
  }
  let failure:
    | {
        cause: unknown;
      }
    | undefined;
  try {
    const source = await open(part, "r");
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      while (true) {
        signal.throwIfAborted();
        const { bytesRead } = await source.read(buffer, 0, buffer.byteLength);
        if (bytesRead === 0) {
          break;
        }
        await writeAll(target, buffer.subarray(0, bytesRead));
        // A long copy is progress too, so the idle limit does not end it; the deadline still does.
        touch();
      }
    } finally {
      await source.close();
    }
  } catch (error) {
    failure = {
      cause: error,
    };
  }
  try {
    // Closing can report a write that failed late, so a copy only counts once it is closed.
    await target.close();
  } catch (error) {
    failure ??= {
      cause: error,
    };
  }
  if (failure) {
    await removeCreated(path, "partial download target");
    throw failure.cause;
  }
}

/**
 * Move the finished temporary file to `path`; returns whether the temporary name is gone.
 * With `overwrite` a rename replaces the target atomically. Without it a hard link fails when the
 * target exists, so nothing is replaced; where links cannot be made the file is copied instead.
 */
export async function commit(
  part: string,
  path: string,
  overwrite: boolean,
  touch: () => void,
  signal: AbortSignal,
  ops: PlaceOps = systemPlaceOps,
) {
  if (overwrite) {
    await retryTransient(() => ops.rename(part, path));
    return true;
  }
  try {
    await retryTransient(() => ops.link(part, path));
    return false;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw invalid("The destination already exists.");
    }
    // Links are not available here (or stayed locked); the copy below decides the outcome.
    console.warn("Hard link failed, copying the download instead.", error);
  }
  await copyExclusive(part, path, touch, signal);
  return false;
}

/** Write every byte of a chunk; a handle may accept fewer bytes than offered, and none means the disk refused. */
async function writeAll(file: FileHandle, chunk: Uint8Array) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(
      chunk,
      offset,
      chunk.byteLength - offset,
    );
    if (bytesWritten === 0) {
      throw new Error("The file accepted no bytes.");
    }
    offset += bytesWritten;
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
        await writeAll(file, result.value);
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
 * Stream a 200 body into `path` through `<path>.<id>.part`, which replaces the target only after the
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
  proxy?: string,
) {
  await checkTarget(input.path, input.overwrite);
  signal.throwIfAborted();
  const response = await fetch(input.url, {
    ...(proxy === undefined
      ? {}
      : {
          proxy,
        }),
    method: "GET",
    // Stored as sent, so the announced length is the size the file will have.
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
  // Only a complete body is a file: 206 is a fragment and 204 or 205 carry no body.
  if (response.status !== 200) {
    await response.body?.cancel();
    return {
      status: response.status,
      headers,
      saved: false,
      bytesWritten: 0,
    };
  }
  // fetch decodes a compressed body, which would make sizes and progress describe different bytes.
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    await response.body?.cancel();
    throw new BunawayError({
      code: "INTERNAL",
      message: "Response body is encoded.",
    });
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
  const part = `${input.path}.${input.downloadId.slice(-PART_SUFFIX_LENGTH)}.part`;
  // "wx" fails on a leftover of the same name, which this download then leaves alone.
  const file = await open(part, "wx");
  let gone = false;
  try {
    await writeBody(response, input, file, signal, entry, touch);
    signal.throwIfAborted();
    if (entry.totalBytes !== null && entry.receivedBytes !== entry.totalBytes) {
      throw new BunawayError({
        code: "INTERNAL",
        message: "Response body length differs from the announced length.",
      });
    }
    gone = await commit(part, input.path, input.overwrite, touch, signal);
  } finally {
    // After a rename the name is free again and may belong to another download, so only a hard
    // link, a copy or a failure leaves a file here to remove.
    if (!gone) {
      await removeCreated(part, "temporary download file");
    }
  }
  return {
    status: response.status,
    headers,
    saved: true,
    bytesWritten: entry.receivedBytes,
  };
}

import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import { MAX_UPLOAD_BYTES, type uploadInputSchema } from "#network/contract";
import { checkDestination } from "#network/platforms/download";
import { readBoundedResponse } from "#network/platforms/http";

type UploadInput = z.output<typeof uploadInputSchema>;

/** Read size of the file stream; each chunk counts as progress and restarts the idle limit. */
const UPLOAD_CHUNK_BYTES = 64 * 1024;

/** An upload that has started, addressed by the caller's id and owned by the `source` that began it. */
export type UploadEntry = {
  readonly source: string;
  readonly controller: AbortController;
  task: Promise<unknown>;
  sentBytes: number;
  totalBytes: number | null;
};

function invalid(message: string) {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

/**
 * Open the file for reading and return its size. The size comes from the open handle, so the file
 * that is checked is the file that is read. Only a regular file within the upload limit is accepted;
 * the handle is closed again when a check fails.
 */
async function openSource(path: string) {
  if (!isAbsolute(path)) {
    throw invalid("Expected an absolute file path.");
  }
  checkDestination(path);
  let file: FileHandle;
  try {
    file = await open(path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      throw invalid("The file does not exist.");
    }
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) {
      throw invalid("Expected a regular file.");
    }
    if (info.size > MAX_UPLOAD_BYTES) {
      throw invalid("The file exceeds the upload limit.");
    }
    return {
      file,
      size: info.size,
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}

/**
 * Stream exactly `size` bytes of the file. A file that ends early has changed while it was sent, so
 * the stream fails instead of delivering a shorter body than the announced length. Bytes past
 * `size` (a file that grew) are not read.
 */
function fileStream(
  file: FileHandle,
  size: number,
  entry: {
    sentBytes: number;
  },
  touch: () => void,
  failed: {
    error?: BunawayError;
  },
) {
  const buffer = Buffer.allocUnsafe(UPLOAD_CHUNK_BYTES);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (entry.sentBytes >= size) {
        controller.close();
        return;
      }
      try {
        const wanted = Math.min(buffer.byteLength, size - entry.sentBytes);
        const { bytesRead } = await file.read(
          buffer,
          0,
          wanted,
          entry.sentBytes,
        );
        if (bytesRead === 0) {
          failed.error = new BunawayError({
            code: "INTERNAL",
            message: "The file changed while it was sent.",
          });
          throw failed.error;
        }
        // The chunk is copied: the buffer is read into again before the connection may be done with it.
        controller.enqueue(Uint8Array.from(buffer.subarray(0, bytesRead)));
        entry.sentBytes += bytesRead;
        touch();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/**
 * Send the file at `path` as the body of a `PUT` or `POST` and return the bounded response like
 * `network.request`. The announced length is the size of the opened file, so the server never sees
 * a chunked body. Redirects are returned for the app to check again. The file is closed on success,
 * failure and cancellation.
 */
export async function upload(
  input: UploadInput,
  signal: AbortSignal,
  entry: {
    sentBytes: number;
    totalBytes: number | null;
  },
  touch: () => void,
) {
  const { file, size } = await openSource(input.path);
  try {
    signal.throwIfAborted();
    entry.totalBytes = size;
    const failed: {
      error?: BunawayError;
    } = {};
    const body = fileStream(file, size, entry, touch, failed);
    let response: Response;
    try {
      response = await fetch(input.url, {
        method: input.method,
        headers: [
          ...input.headers,
          [
            "content-length",
            String(size),
          ],
        ],
        body,
        redirect: "manual",
        credentials: "omit",
        signal,
      });
    } catch (error) {
      // A file that changed fails the stream; report that rather than the connection error it causes.
      throw failed.error ?? error;
    }
    touch();
    const result = await readBoundedResponse(
      response,
      input.maxResponseBytes,
      signal,
    );
    return {
      ...result,
      bytesSent: entry.sentBytes,
    };
  } finally {
    await file.close();
  }
}

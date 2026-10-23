import { type FileHandle, open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { BunawayError } from "@bunaway/protocol";
import type { z } from "zod";
import { MAX_UPLOAD_BYTES, type uploadInputSchema } from "#network/contract";
import { checkDestination, errorCode } from "#network/platforms/download";
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
  // A pipe or device blocks `open` until the other end appears, and that wait cannot be cancelled,
  // so the kind is read before the file is opened. The handle is checked again below.
  try {
    if (!(await stat(path)).isFile()) {
      throw invalid("Expected a regular file.");
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      throw invalid("The file does not exist.");
    }
    throw error;
  }
  const file = await open(path, "r");
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

/** What the stream and `upload` share: the failure to report, whether the file is closed, and the read in flight. */
type StreamState = {
  error?: BunawayError;
  closed: boolean;
  reading: Promise<void> | undefined;
};

/**
 * Stream exactly `size` bytes of the file. A file that ends early has changed while it was sent, so
 * the stream fails instead of delivering a shorter body than the announced length. Bytes past
 * `size` (a file that grew) are not read. Nothing is read once `state.closed` is set.
 */
function fileStream(
  file: FileHandle,
  size: number,
  entry: {
    sentBytes: number;
  },
  touch: () => void,
  state: StreamState,
) {
  /** Read one chunk; it never rejects, a failure is passed to the stream instead. */
  const readChunk = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) => {
    if (state.closed) {
      controller.error(new Error("The file is closed."));
      return;
    }
    if (entry.sentBytes >= size) {
      controller.close();
      return;
    }
    try {
      const chunk = new Uint8Array(
        Math.min(UPLOAD_CHUNK_BYTES, size - entry.sentBytes),
      );
      const { bytesRead } = await file.read(
        chunk,
        0,
        chunk.byteLength,
        entry.sentBytes,
      );
      if (bytesRead === 0) {
        state.error = new BunawayError({
          code: "INTERNAL",
          message: "The file changed while it was sent.",
        });
        throw state.error;
      }
      controller.enqueue(chunk.subarray(0, bytesRead));
      entry.sentBytes += bytesRead;
      touch();
    } catch (error) {
      controller.error(error);
    }
  };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      state.reading = readChunk(controller);
      return state.reading;
    },
  });
}

/**
 * Send the file at `path` as the body of a `PUT` or `POST` and return the bounded response like
 * `network.request`. The announced length is the size of the opened file, so the server never sees
 * a chunked body. Redirects are returned for the app to check again. The file is closed on success,
 * failure and cancellation, after the read that may still be running has ended.
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
  const state: StreamState = {
    closed: false,
    reading: undefined,
  };
  try {
    signal.throwIfAborted();
    entry.totalBytes = size;
    const body = fileStream(file, size, entry, touch, state);
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
      throw state.error ?? error;
    }
    touch();
    // The server may take long to answer after the last byte, and a slow body is progress too.
    const result = await readBoundedResponse(
      response,
      input.maxResponseBytes,
      signal,
      touch,
    );
    return {
      ...result,
      bytesSent: entry.sentBytes,
    };
  } finally {
    // A read that is still running must end before its handle is closed.
    state.closed = true;
    await state.reading;
    await file.close();
  }
}

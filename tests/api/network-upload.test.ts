import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ACTIVE_UPLOADS,
  MAX_UPLOAD_BYTES,
  uploadInputSchema,
} from "#plugins/network/src/contract";
import {
  dispose,
  initialize,
  runCancelUpload,
  runUpload,
  runUploadStatus,
} from "#plugins/network/src/platforms/shared";
import { deadline, waitFor } from "../fixtures/deadlines";

setDefaultTimeout(deadline("build"));

const SOURCE = "app";
/** Short enough to see a stall, long enough that a loaded runner does not trip it by accident. */
const SHORT_IDLE_MS = 300;
/** Larger than the socket buffers, so a server that does not read holds the upload back. */
const LARGE_BYTES = 8 * 1024 * 1024;
/** Far beyond what the socket buffers and the stream queue hold, so most of the file is still unread when it shrinks. */
const SHRINK_BYTES = 64 * 1024 * 1024;
/** The answer of the trickle route lasts longer than the idle limit the test sets, one byte per step. */
const TRICKLE_STEP_MS = 150;
const TRICKLE_STEPS = 6;
/** Consecutive probes with the same byte count that show the upload has stopped reading. */
const STEADY_PROBES = 5;
/** Second look at the byte count after the upload seems to have stopped reading. */
const RECHECK_MS = 500;
type Seen = {
  method: string;
  contentLength: string | null;
  transferEncoding: string | null;
  contentType: string | null;
  bytes: number;
  body: Uint8Array;
};
let folder: string;
let seen: Seen | undefined;
/** Upload ids whose request the server saw end; each test looks up its own id. */
const endedRequests = new Set<string>();
/** Resolves when the slow-reading route has taken its first chunk; the route then waits for `releaseSlowReader`. */
let slowReaderStarted: () => void = () => {};
let releaseSlowReader: () => void = () => {};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/never-read") {
      // Answers only when the request ends; the body is never consumed.
      await new Promise<void>((resolve) =>
        request.signal.addEventListener(
          "abort",
          () => {
            endedRequests.add(
              new URL(request.url).searchParams.get("id") ?? "",
            );
            resolve();
          },
          {
            once: true,
          },
        ),
      );
      return new Response("late");
    }
    if (path === "/trickle") {
      // The body is read in full, then the answer arrives a byte at a time, slower than it ends.
      await request.arrayBuffer();
      let sent = 0;
      return new Response(
        new ReadableStream({
          async pull(controller) {
            await Bun.sleep(TRICKLE_STEP_MS);
            controller.enqueue(new Uint8Array(1));
            if (++sent === TRICKLE_STEPS) {
              controller.close();
            }
          },
        }),
      );
    }
    if (path === "/slow-reader") {
      const reader = request.body?.getReader();
      await reader?.read();
      slowReaderStarted();
      await new Promise<void>((resolve) => {
        releaseSlowReader = resolve;
      });
      // Reads on until the upload ends, whether the body completes or the client fails it.
      try {
        while (!(await reader?.read())?.done) {}
      } catch {
        // The client ended the request early, which is what the route waits for.
      }
      return new Response("drained");
    }
    const body = new Uint8Array(await request.arrayBuffer());
    seen = {
      method: request.method,
      contentLength: request.headers.get("content-length"),
      transferEncoding: request.headers.get("transfer-encoding"),
      contentType: request.headers.get("content-type"),
      bytes: body.byteLength,
      body,
    };
    if (path === "/big-answer") {
      return new Response(new Uint8Array(200_000));
    }
    if (path === "/redirect") {
      return new Response(null, {
        status: 307,
        headers: {
          location: "/ok",
        },
      });
    }
    if (path === "/rejected") {
      return new Response("too large", {
        status: 413,
      });
    }
    return new Response("stored", {
      headers: {
        "x-test": "yes",
      },
    });
  },
});
const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "bunaway-upload-"));
});
afterAll(() => {
  void server.stop(true);
  rmSync(folder, {
    recursive: true,
    force: true,
  });
});

function fileOf(name: string, content: string | Uint8Array) {
  const path = join(folder, name);
  writeFileSync(path, content);
  return path;
}

function input(
  path: string,
  target = "/ok",
  extra: Partial<Record<string, unknown>> = {},
) {
  const uploadId = crypto.randomUUID();
  return uploadInputSchema.parse({
    uploadId,
    url: `${url(target)}?id=${uploadId}`,
    path,
    ...extra,
  });
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (
      error as {
        code?: string;
      }
    ).code;
  }
  return "no error";
}

/** Waits until a running upload has read its first chunk. */
const firstChunk = (
  state: ReturnType<typeof initialize>,
  request: {
    uploadId: string;
  },
) =>
  waitFor(
    () => {
      const { sentBytes } = runUploadStatus(state, SOURCE, request);
      return sentBytes > 0 ? sentBytes : undefined;
    },
    {
      deadline: "inProcess",
      what: "the first chunk",
    },
  );

test("network.upload sends the file as one sized body and returns the bounded answer", async () => {
  const state = initialize();
  const content = Buffer.from("hello upload");
  const request = input(fileOf("small.txt", content), "/ok", {
    headers: [
      [
        "content-type",
        "text/plain",
      ],
    ],
  });
  const result = await runUpload(state, SOURCE, request);
  expect(result.status).toBe(200);
  expect(Buffer.from(result.bodyBase64, "base64").toString()).toBe("stored");
  expect(result.headers).toContainEqual([
    "x-test",
    "yes",
  ]);
  expect(result.bytesSent).toBe(content.byteLength);
  expect(seen).toMatchObject({
    method: "PUT",
    contentLength: String(content.byteLength),
    transferEncoding: null,
    contentType: "text/plain",
  });
  expect(Buffer.from(seen?.body ?? []).equals(content)).toBe(true);
  expect(state.uploads.size).toBe(0);
  await dispose(state);
});

test("POST is allowed and a larger file arrives intact in chunks", async () => {
  const state = initialize();
  const content = Buffer.alloc(LARGE_BYTES / 4);
  for (let index = 0; index < content.byteLength; index++) {
    content[index] = index % 251;
  }
  const result = await runUpload(
    state,
    SOURCE,
    input(fileOf("large.bin", content), "/ok", {
      method: "POST",
    }),
  );
  expect(result.bytesSent).toBe(content.byteLength);
  expect(seen?.method).toBe("POST");
  expect(Buffer.from(seen?.body ?? []).equals(content)).toBe(true);
  await dispose(state);
});

test("an empty file is a valid zero length body", async () => {
  const state = initialize();
  const result = await runUpload(state, SOURCE, input(fileOf("empty.txt", "")));
  expect(result).toMatchObject({
    status: 200,
    bytesSent: 0,
  });
  expect(seen?.contentLength).toBe("0");
  await dispose(state);
});

test("redirects and error statuses are returned and the answer is bounded", async () => {
  const state = initialize();
  const path = fileOf("status.txt", "data");
  const redirect = await runUpload(state, SOURCE, input(path, "/redirect"));
  expect(redirect.status).toBe(307);
  const rejected = await runUpload(state, SOURCE, input(path, "/rejected"));
  expect(rejected.status).toBe(413);
  expect(Buffer.from(rejected.bodyBase64, "base64").toString()).toBe(
    "too large",
  );
  expect(
    await codeOf(
      runUpload(
        state,
        SOURCE,
        input(path, "/big-answer", {
          maxResponseBytes: 1000,
        }),
      ),
    ),
  ).toBe("INTERNAL");
  expect(state.uploads.size).toBe(0);
  await dispose(state);
});

test("the input refuses what a body cannot be", () => {
  const path = join(folder, "x.txt");
  for (const extra of [
    {
      method: "GET",
    },
    {
      method: "DELETE",
    },
    {
      headers: [
        [
          "content-length",
          "1",
        ],
      ],
    },
    {
      headers: [
        [
          "transfer-encoding",
          "chunked",
        ],
      ],
    },
    {
      uploadId: "not-an-id",
    },
    {
      url: "ftp://example.test/file",
    },
    {
      path: "",
    },
    {
      timeoutMs: 0,
    },
  ]) {
    expect(
      uploadInputSchema.safeParse({
        uploadId: crypto.randomUUID(),
        url: url("/ok"),
        path,
        ...extra,
      }).success,
    ).toBe(false);
  }
});

test("a missing file, a folder, a relative path and a dot part are refused before any request", async () => {
  const state = initialize();
  seen = undefined;
  const subfolder = join(folder, "sub");
  mkdirSync(subfolder, {
    recursive: true,
  });
  for (const path of [
    join(folder, "missing.txt"),
    subfolder,
    "relative.txt",
    `${folder}/../escape.txt`,
  ]) {
    expect(await codeOf(runUpload(state, SOURCE, input(path)))).toBe(
      "INVALID_ARGUMENT",
    );
  }
  expect(seen).toBeUndefined();
  expect(state.uploads.size).toBe(0);
  await dispose(state);
});

test("upload ids are free to reuse after the transfer, a running id is refused, and the cap is four", async () => {
  const state = initialize();
  const path = fileOf("hold.bin", Buffer.alloc(LARGE_BYTES));
  const running = Array.from(
    {
      length: MAX_ACTIVE_UPLOADS,
    },
    () => input(path, "/never-read"),
  );
  const pending = running.map((request) => runUpload(state, SOURCE, request));
  const settled = Promise.allSettled(pending);
  const first = running[0];
  if (!first) {
    throw new Error("No running upload.");
  }
  expect(await codeOf(runUpload(state, SOURCE, first))).toBe(
    "INVALID_ARGUMENT",
  );
  expect(await codeOf(runUpload(state, SOURCE, input(path)))).toBe("BUSY");
  await dispose(state);
  await settled;
  expect(state.uploads.size).toBe(0);
  const again = initialize();
  const result = await runUpload(again, SOURCE, {
    ...first,
    url: url("/ok"),
  });
  expect(result.status).toBe(200);
  await dispose(again);
});

test("status reports progress to the starting source only, and fails for unknown ids", async () => {
  const state = initialize();
  const request = input(
    fileOf("progress.bin", Buffer.alloc(LARGE_BYTES)),
    "/never-read",
  );
  const pending = runUpload(state, SOURCE, request);
  const settled = Promise.allSettled([
    pending,
  ]);
  await firstChunk(state, request);
  const status = runUploadStatus(state, SOURCE, request);
  expect(status.totalBytes).toBe(LARGE_BYTES);
  expect(status.sentBytes).toBeLessThanOrEqual(LARGE_BYTES);
  expect(() => runUploadStatus(state, "other", request)).toThrow(
    "Unknown upload.",
  );
  expect(() =>
    runUploadStatus(state, SOURCE, {
      uploadId: crypto.randomUUID(),
    }),
  ).toThrow("Unknown upload.");
  await runCancelUpload(state, "other", request);
  expect(state.uploads.has(request.uploadId)).toBe(true);
  await runCancelUpload(state, SOURCE, request);
  expect(await codeOf(pending)).toBe("CANCELLED");
  await settled;
  expect(state.uploads.size).toBe(0);
  await dispose(state);
});

test("cancelUpload ends the connection, releases the id and succeeds for unknown ids", async () => {
  const state = initialize();
  const request = input(
    fileOf("cancel.bin", Buffer.alloc(LARGE_BYTES)),
    "/never-read",
  );
  const pending = runUpload(state, SOURCE, request);
  const code = codeOf(pending);
  await firstChunk(state, request);
  expect(await runCancelUpload(state, SOURCE, request)).toEqual({});
  expect(await code).toBe("CANCELLED");
  expect(state.uploads.size).toBe(0);
  await waitFor(() => endedRequests.has(request.uploadId) || undefined, {
    deadline: "inProcess",
    what: "the server noticing the end of the request",
  });
  expect(
    await runCancelUpload(state, SOURCE, {
      uploadId: crypto.randomUUID(),
    }),
  ).toEqual({});
  await dispose(state);
});

test("an aborted call signal cancels the upload", async () => {
  const state = initialize();
  const controller = new AbortController();
  const request = input(
    fileOf("signal.bin", Buffer.alloc(LARGE_BYTES)),
    "/never-read",
  );
  const code = codeOf(runUpload(state, SOURCE, request, controller.signal));
  await firstChunk(state, request);
  controller.abort();
  expect(await code).toBe("CANCELLED");
  expect(state.uploads.size).toBe(0);
  await dispose(state);
});

test("a server that stops reading ends with a stall timeout", async () => {
  const state = initialize();
  const request = input(
    fileOf("stall.bin", Buffer.alloc(LARGE_BYTES)),
    "/never-read",
    {
      idleTimeoutMs: SHORT_IDLE_MS,
    },
  );
  const error = await runUpload(state, SOURCE, request).catch(
    (failure: unknown) =>
      failure as Error & {
        code?: string;
      },
  );
  expect(error).toMatchObject({
    code: "TIMEOUT",
    message: "Upload stalled.",
  });
  expect(state.uploads.size).toBe(0);
  await dispose(state);
});

test("the whole-upload deadline ends a transfer that keeps making progress slowly", async () => {
  const state = initialize();
  const request = input(
    fileOf("deadline.bin", Buffer.alloc(LARGE_BYTES)),
    "/never-read",
    {
      timeoutMs: SHORT_IDLE_MS,
    },
  );
  const error = await runUpload(state, SOURCE, request).catch(
    (failure: unknown) =>
      failure as Error & {
        code?: string;
      },
  );
  expect(error).toMatchObject({
    code: "TIMEOUT",
  });
  expect(state.uploads.size).toBe(0);
  await dispose(state);
});

test("a file that shrinks while it is sent fails and is not reported as sent", async () => {
  const state = initialize();
  const path = fileOf("shrink.bin", Buffer.alloc(SHRINK_BYTES));
  const started = new Promise<void>((resolve) => {
    slowReaderStarted = resolve;
  });
  const pending = runUpload(state, SOURCE, input(path, "/slow-reader"));
  const error = pending.catch(
    (failure: unknown) =>
      failure as Error & {
        code?: string;
      },
  );
  await started;
  truncateSync(path, 1024);
  releaseSlowReader();
  expect(await error).toMatchObject({
    code: "INTERNAL",
    message: "The file changed while it was sent.",
  });
  expect(state.uploads.size).toBe(0);
  await dispose(state);
});

test("bytes appended after the size was read are not sent", async () => {
  const state = initialize();
  const path = fileOf("grow.txt", "abc");
  const request = input(path);
  const result = await runUpload(state, SOURCE, request);
  appendFileSync(path, "def");
  expect(result.bytesSent).toBe(3);
  expect(seen?.contentLength).toBe("3");
  await dispose(state);
});

test("dispose cancels running uploads and later calls fail", async () => {
  const state = initialize();
  const request = input(
    fileOf("dispose.bin", Buffer.alloc(LARGE_BYTES)),
    "/never-read",
  );
  const code = codeOf(runUpload(state, SOURCE, request));
  await firstChunk(state, request);
  await dispose(state);
  expect(await code).toBe("CANCELLED");
  expect(state.uploads.size).toBe(0);
  expect(await codeOf(runUpload(state, SOURCE, input(request.path)))).toBe(
    "CANCELLED",
  );
});

test("the upload limit matches the download limit", () => {
  expect(MAX_UPLOAD_BYTES).toBe(4 * 1024 * 1024 * 1024);
});

test("a slow response body counts as progress for the idle limit", async () => {
  const state = initialize();
  const result = await runUpload(
    state,
    SOURCE,
    input(fileOf("trickle.txt", "data"), "/trickle", {
      idleTimeoutMs: TRICKLE_STEP_MS * 3,
    }),
  );
  expect(Buffer.from(result.bodyBase64, "base64").byteLength).toBe(
    TRICKLE_STEPS,
  );
  await dispose(state);
});

test("a server that does not read holds the file back instead of filling memory", async () => {
  const state = initialize();
  const request = input(
    fileOf("backpressure.bin", Buffer.alloc(SHRINK_BYTES)),
    "/never-read",
  );
  const code = codeOf(runUpload(state, SOURCE, request));
  await firstChunk(state, request);
  // Wait until progress stops, which only happens when the connection stops taking the stream.
  let previous = -1;
  let steady = 0;
  const sentWhenSteady = await waitFor(
    () => {
      const { sentBytes } = runUploadStatus(state, SOURCE, request);
      steady = sentBytes === previous ? steady + 1 : 0;
      previous = sentBytes;
      return steady >= STEADY_PROBES ? sentBytes : undefined;
    },
    {
      deadline: "inProcess",
      what: "the upload to stop reading",
    },
  );
  // A pause that only looked like a stop would read on during this second look.
  await Bun.sleep(RECHECK_MS);
  expect(runUploadStatus(state, SOURCE, request).sentBytes).toBe(
    sentWhenSteady,
  );
  expect(sentWhenSteady).toBeLessThan(SHRINK_BYTES / 2);
  await runCancelUpload(state, SOURCE, request);
  expect(await code).toBe("CANCELLED");
  await dispose(state);
});

test.skipIf(process.platform === "win32")(
  "a named pipe is refused without blocking",
  async () => {
    const state = initialize();
    const pipe = join(folder, "pipe");
    expect(
      Bun.spawnSync([
        "mkfifo",
        pipe,
      ]).exitCode,
    ).toBe(0);
    expect(await codeOf(runUpload(state, SOURCE, input(pipe)))).toBe(
      "INVALID_ARGUMENT",
    );
    expect(state.uploads.size).toBe(0);
    await dispose(state);
  },
);

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  type PathLike,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import network from "@bunaway/plugin-network";
import { NativeRegistry } from "@bunaway/protocol";
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  downloadInputSchema,
  MAX_ACTIVE_DOWNLOADS,
  MAX_DOWNLOAD_BYTES,
} from "#plugins/network/src/contract";
import {
  checkDestination,
  commit,
} from "#plugins/network/src/platforms/download";
import {
  dispose,
  initialize,
  runCancelDownload,
  runDownload,
  runDownloadStatus,
} from "#plugins/network/src/platforms/shared";
import { deadline, waitFor } from "../fixtures/deadlines";

setDefaultTimeout(deadline("build"));

const SOURCE = "app";
/** Short enough to see a stall, long enough that a loaded runner does not trip it by accident. */
const SHORT_IDLE_MS = 300;
const encoder = new TextEncoder();
let folder: string;
let releases: Array<() => void> = [];
/** Set when the client ended the connection of the endless body. */
let endlessCancelled = false;
/**
 * A raw HTTP/1.1 answer, so the response announces a length: the first five of eleven bytes arrive
 * at once and the rest only after the test calls a release function.
 */
const held = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    data(socket, data) {
      if (data.toString().startsWith("GET /cut")) {
        // The connection ends before the announced 100 bytes arrived.
        socket.write(
          "HTTP/1.1 200 OK\r\ncontent-length: 100\r\nconnection: close\r\n\r\nfirst",
        );
        socket.end();
        return;
      }
      socket.write(
        "HTTP/1.1 200 OK\r\ncontent-length: 11\r\nconnection: close\r\n\r\nfirst",
      );
      releases.push(() => {
        socket.write("second");
        socket.end();
      });
    },
    close() {},
  },
});
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/small") {
      return new Response("hello download", {
        headers: {
          "x-test": "yes",
        },
      });
    }
    if (path === "/missing") {
      return new Response("nope", {
        status: 404,
      });
    }
    if (path === "/partial") {
      return new Response("fragment", {
        status: 206,
      });
    }
    if (path === "/empty") {
      return new Response(null, {
        status: 204,
      });
    }
    if (path === "/redirect") {
      return new Response(null, {
        status: 302,
        headers: {
          location: "/small",
        },
      });
    }
    // One chunk arrives and the body never finishes.
    if (path === "/stall") {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("first"));
          },
        }),
      );
    }
    if (path === "/endless") {
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024));
          },
          cancel() {
            endlessCancelled = true;
          },
        }),
      );
    }
    if (path === "/gzip") {
      return new Response(Bun.gzipSync("compressed body"), {
        headers: {
          "content-encoding": "gzip",
        },
      });
    }
    return new Response("not found", {
      status: 404,
    });
  },
});
const url = (path: string) =>
  path === "/held" || path === "/cut"
    ? `http://127.0.0.1:${held.port}${path}`
    : `http://127.0.0.1:${server.port}${path}`;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "bunaway-download-"));
});
afterAll(() => {
  void server.stop(true);
  held.stop(true);
  rmSync(folder, {
    recursive: true,
    force: true,
  });
});

function input(
  name: string,
  path: string,
  extra: Partial<Record<string, unknown>> = {},
) {
  return downloadInputSchema.parse({
    downloadId: crypto.randomUUID(),
    url: url(path),
    path: join(folder, name),
    maxBytes: 1024 * 1024,
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

/** Waits until a running download has written its first chunk. */
const firstChunk = (
  state: ReturnType<typeof initialize>,
  request: {
    downloadId: string;
  },
) =>
  waitFor(
    () => {
      const { receivedBytes } = runDownloadStatus(state, SOURCE, request);
      return receivedBytes > 0 ? receivedBytes : undefined;
    },
    {
      deadline: "inProcess",
      what: "the first chunk",
    },
  );

const leftovers = () => readdirSync(folder).filter((n) => n.endsWith(".part"));

test("network.download saves a 200 body and reports status and headers", async () => {
  const state = initialize();
  const request = input("small.txt", "/small");
  const result = await runDownload(state, SOURCE, request);
  expect(result.saved).toBe(true);
  expect(result.status).toBe(200);
  expect(result.bytesWritten).toBe(14);
  expect(result.headers).toContainEqual([
    "x-test",
    "yes",
  ]);
  expect(readFileSync(request.path, "utf8")).toBe("hello download");
  expect(leftovers()).toEqual([]);
  expect(state.downloads.size).toBe(0);
  await dispose(state);
});

test("a status other than 200 or a redirect is returned and creates no file", async () => {
  const state = initialize();
  for (const [path, status] of [
    [
      "/missing",
      404,
    ],
    [
      "/redirect",
      302,
    ],
    [
      "/partial",
      206,
    ],
    [
      "/empty",
      204,
    ],
  ] as const) {
    const request = input(`status-${status}.txt`, path);
    const result = await runDownload(state, SOURCE, request);
    expect(result).toMatchObject({
      status,
      saved: false,
      bytesWritten: 0,
    });
    expect(existsSync(request.path)).toBe(false);
  }
  expect(leftovers()).toEqual([]);
  await dispose(state);
});

test("a download refuses an existing target unless overwrite is set, and never replaces a folder", async () => {
  const state = initialize();
  const target = join(folder, "existing.txt");
  writeFileSync(target, "old");
  const keep = input("existing.txt", "/small");
  expect(await codeOf(runDownload(state, SOURCE, keep))).toBe(
    "INVALID_ARGUMENT",
  );
  expect(readFileSync(target, "utf8")).toBe("old");
  const replace = input("existing.txt", "/small", {
    overwrite: true,
  });
  expect((await runDownload(state, SOURCE, replace)).saved).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("hello download");
  mkdirSync(join(folder, "dir"));
  const onFolder = input("dir", "/small", {
    overwrite: true,
  });
  expect(await codeOf(runDownload(state, SOURCE, onFolder))).toBe(
    "INVALID_ARGUMENT",
  );
  expect(leftovers()).toEqual([]);
  await dispose(state);
});

test("a missing destination folder fails before any request", async () => {
  const state = initialize();
  const request = input("absent/file.txt", "/small");
  expect(await codeOf(runDownload(state, SOURCE, request))).toBe(
    "INVALID_ARGUMENT",
  );
  await dispose(state);
});

test("a temporary file that cannot be created ends the connection instead of leaving it open", async () => {
  const state = initialize();
  const request = input("occupied.bin", "/endless");
  const part = `${request.path}.${request.downloadId.slice(-8)}.part`;
  writeFileSync(part, "leftover");
  endlessCancelled = false;
  expect(await codeOf(runDownload(state, SOURCE, request))).toBe("INTERNAL");
  await waitFor(() => endlessCancelled || undefined, {
    deadline: "inProcess",
    what: "the server to see the connection end",
  });
  // The leftover is not this download's file and stays.
  expect(readFileSync(part, "utf8")).toBe("leftover");
  rmSync(part);
  await dispose(state);
});

test("an encoded body, a Range header, an over-long name and a dangling link are refused", async () => {
  const state = initialize();
  const encoded = input("encoded.bin", "/gzip");
  expect(await codeOf(runDownload(state, SOURCE, encoded))).toBe("INTERNAL");
  expect(existsSync(encoded.path)).toBe(false);
  expect(
    downloadInputSchema.safeParse({
      downloadId: crypto.randomUUID(),
      url: url("/small"),
      path: join(folder, "ranged.bin"),
      maxBytes: 10,
      headers: [
        [
          "Range",
          "bytes=0-4",
        ],
      ],
    }).success,
  ).toBe(false);
  const tooLong = input(`${"n".repeat(250)}.bin`, "/small");
  expect(await codeOf(runDownload(state, SOURCE, tooLong))).toBe(
    "INVALID_ARGUMENT",
  );
  if (process.platform !== "win32") {
    symlinkSync(join(folder, "nowhere"), join(folder, "dangling.bin"));
    const dangling = input("dangling.bin", "/small");
    expect(await codeOf(runDownload(state, SOURCE, dangling))).toBe(
      "INVALID_ARGUMENT",
    );
  }
  expect(leftovers()).toEqual([]);
  await dispose(state);
});

const fsError = (code: string) =>
  Object.assign(new Error(code), {
    code,
  });

test("placing a file without hard links copies exclusively and never touches a file that appeared", async () => {
  const signal = new AbortController().signal;
  const touched = {
    count: 0,
  };
  const touch = () => {
    touched.count += 1;
  };
  const noLinks = {
    link: async () => {
      throw fsError("ENOTSUP");
    },
    rename: async () => {},
  };
  const part = join(folder, "place.part");
  writeFileSync(part, "complete body");
  const target = join(folder, "placed.bin");
  expect(await commit(part, target, false, touch, signal, noLinks)).toBe(false);
  expect(readFileSync(target, "utf8")).toBe("complete body");
  expect(existsSync(part)).toBe(true);
  expect(touched.count).toBeGreaterThan(0);
  // A file at the path is kept, both when the copy starts and when it is the reason for the failure.
  const error = await commit(part, target, false, touch, signal, noLinks).catch(
    (caught: { code?: string }) => caught,
  );
  expect(
    (
      error as {
        code?: string;
      }
    ).code,
  ).toBe("INVALID_ARGUMENT");
  expect(readFileSync(target, "utf8")).toBe("complete body");
  // A copy that fails after creating the target removes that target and reports the real cause.
  const lost = join(folder, "lost.bin");
  const cause = await commit(
    join(folder, "missing.part"),
    lost,
    false,
    touch,
    signal,
    noLinks,
  ).catch((caught: { code?: string }) => caught);
  expect(
    (
      cause as {
        code?: string;
      }
    ).code,
  ).toBe("ENOENT");
  expect(existsSync(lost)).toBe(false);
  rmSync(part);
});

test("placing a file tries again while the file is held and replaces only with overwrite", async () => {
  const signal = new AbortController().signal;
  const part = join(folder, "retry.part");
  writeFileSync(part, "new");
  const target = join(folder, "retried.bin");
  let linkFailures = 2;
  const busyLinks = {
    link: async (from: PathLike, to: PathLike) => {
      if (linkFailures > 0) {
        linkFailures -= 1;
        throw fsError("EBUSY");
      }
      linkSync(from, to);
    },
    rename: async () => {},
  };
  expect(await commit(part, target, false, () => {}, signal, busyLinks)).toBe(
    false,
  );
  expect(linkFailures).toBe(0);
  expect(readFileSync(target, "utf8")).toBe("new");
  let renameFailures = 1;
  const busyRename = {
    link: async () => {},
    rename: async (from: PathLike, to: PathLike) => {
      if (renameFailures > 0) {
        renameFailures -= 1;
        throw fsError("EPERM");
      }
      renameSync(from, to);
    },
  };
  // The linked target shares its content with `part`, so the replacement starts from fresh files.
  rmSync(part);
  rmSync(target);
  writeFileSync(target, "old");
  const replacement = join(folder, "replacement.part");
  writeFileSync(replacement, "new");
  expect(
    await commit(replacement, target, true, () => {}, signal, busyRename),
  ).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("new");
  expect(existsSync(replacement)).toBe(false);
});

test("cancelling during the copy ends the download and removes the partial target", async () => {
  const part = join(folder, "cancel-copy.part");
  writeFileSync(part, "x".repeat(4 * 1024 * 1024));
  const target = join(folder, "cancel-copy.bin");
  const controller = new AbortController();
  const noLinks = {
    link: async () => {
      throw fsError("ENOTSUP");
    },
    rename: async () => {},
  };
  const outcome = await commit(
    part,
    target,
    false,
    () => controller.abort(),
    controller.signal,
    noLinks,
  ).catch((caught: unknown) => caught);
  expect(
    (
      outcome as {
        name?: string;
      }
    ).name,
  ).toBe("AbortError");
  expect(existsSync(target)).toBe(false);
  rmSync(part);
});

test("a body over maxBytes, announced or streamed, fails and leaves no file", async () => {
  const state = initialize();
  const announced = input("announced.bin", "/held", {
    maxBytes: 5,
  });
  expect(await codeOf(runDownload(state, SOURCE, announced))).toBe("INTERNAL");
  const streamed = input("streamed.bin", "/endless", {
    maxBytes: 4096,
  });
  expect(await codeOf(runDownload(state, SOURCE, streamed))).toBe("INTERNAL");
  expect(existsSync(announced.path)).toBe(false);
  expect(existsSync(streamed.path)).toBe(false);
  expect(leftovers()).toEqual([]);
  await dispose(state);
});

test("a connection that breaks mid-body fails and removes the temporary file", async () => {
  const state = initialize();
  const request = input("broken.bin", "/cut");
  expect(await codeOf(runDownload(state, SOURCE, request))).toBe("INTERNAL");
  expect(existsSync(request.path)).toBe(false);
  expect(leftovers()).toEqual([]);
  await dispose(state);
});

test("a body that stops arriving ends with TIMEOUT", async () => {
  const state = initialize();
  const request = input("stalled.bin", "/stall", {
    idleTimeoutMs: SHORT_IDLE_MS,
  });
  expect(await codeOf(runDownload(state, SOURCE, request))).toBe("TIMEOUT");
  expect(existsSync(request.path)).toBe(false);
  expect(leftovers()).toEqual([]);
  await dispose(state);
});

test("downloadStatus reports progress to the starting source only, and cancelDownload stops the transfer", async () => {
  const state = initialize();
  const request = input("held.bin", "/held");
  const running = codeOf(runDownload(state, SOURCE, request));
  const status = await waitFor(
    () => {
      const current = runDownloadStatus(state, SOURCE, request);
      return current.receivedBytes > 0 ? current : undefined;
    },
    {
      deadline: "inProcess",
      what: "the first chunk",
    },
  );
  expect(status).toEqual({
    receivedBytes: 5,
    totalBytes: 11,
  });
  expect(() => runDownloadStatus(state, "other", request)).toThrow(
    "Unknown download.",
  );
  await runCancelDownload(state, "other", request);
  expect(state.downloads.size).toBe(1);
  expect(await runCancelDownload(state, SOURCE, request)).toEqual({});
  expect(await running).toBe("CANCELLED");
  expect(leftovers()).toEqual([]);
  expect(existsSync(request.path)).toBe(false);
  // A second cancel and a cancel of an unknown id both succeed.
  expect(await runCancelDownload(state, SOURCE, request)).toEqual({});
  expect(() => runDownloadStatus(state, SOURCE, request)).toThrow();
  await dispose(state);
});

test("a download whose length is announced reports it and completes after the rest arrives", async () => {
  const state = initialize();
  const request = input("complete.bin", "/held");
  const running = runDownload(state, SOURCE, request);
  await firstChunk(state, request);
  releases.pop()?.();
  const result = await running;
  expect(result).toMatchObject({
    saved: true,
    bytesWritten: 11,
  });
  expect(readFileSync(request.path, "utf8")).toBe("firstsecond");
  expect(() => runDownloadStatus(state, SOURCE, request)).toThrow(
    "Unknown download.",
  );
  await dispose(state);
});

test("aborting the call cancels the download", async () => {
  const state = initialize();
  const request = input("aborted.bin", "/held");
  const controller = new AbortController();
  const running = codeOf(
    runDownload(state, SOURCE, request, controller.signal),
  );
  await firstChunk(state, request);
  controller.abort();
  expect(await running).toBe("CANCELLED");
  expect(leftovers()).toEqual([]);
  await dispose(state);
});

test("downloads are limited to four at once and ids cannot repeat", async () => {
  const state = initialize();
  const started = Array.from(
    {
      length: MAX_ACTIVE_DOWNLOADS,
    },
    (_, index) => input(`busy-${index}.bin`, "/held"),
  );
  const running = started.map((request) =>
    codeOf(runDownload(state, SOURCE, request)),
  );
  for (const request of started) {
    await firstChunk(state, request);
  }
  expect(
    await codeOf(runDownload(state, SOURCE, input("busy-extra.bin", "/small"))),
  ).toBe("BUSY");
  await dispose(state);
  for (const promise of running) {
    expect(await promise).toBe("CANCELLED");
  }
  expect(leftovers()).toEqual([]);
});

test("a repeated download id is refused while the first still runs", async () => {
  const state = initialize();
  const request = input("repeat.bin", "/held");
  const running = codeOf(runDownload(state, SOURCE, request));
  expect(await codeOf(runDownload(state, SOURCE, request))).toBe(
    "INVALID_ARGUMENT",
  );
  await dispose(state);
  expect(await running).toBe("CANCELLED");
});

test("disposing the adapter cancels running downloads and removes temporary files", async () => {
  const state = initialize();
  const request = input("disposed.bin", "/held");
  const running = codeOf(runDownload(state, SOURCE, request));
  await firstChunk(state, request);
  await dispose(state);
  expect(await running).toBe("CANCELLED");
  expect(leftovers()).toEqual([]);
  expect(await codeOf(runDownload(state, SOURCE, request))).toBe("CANCELLED");
  releases = [];
});

test("download input is bounded and takes only plain http(s) GET fields", () => {
  const base = {
    downloadId: crypto.randomUUID(),
    url: "https://example.com/file",
    path: "/tmp/file",
    maxBytes: 1,
  };
  expect(downloadInputSchema.safeParse(base).success).toBe(true);
  expect(downloadInputSchema.parse(base)).toMatchObject({
    overwrite: false,
    timeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS,
  });
  for (const bad of [
    {
      maxBytes: undefined,
    },
    {
      maxBytes: MAX_DOWNLOAD_BYTES + 1,
    },
    {
      maxBytes: 0,
    },
    {
      downloadId: "not-a-uuid",
    },
    {
      downloadId: "6F9619FF-8B86-4011-B42D-00C04FC964FF",
    },
    {
      url: "file:///tmp/x",
    },
    {
      method: "POST",
    },
    {
      timeoutMs: 3_600_001,
    },
    {
      idleTimeoutMs: 300_001,
    },
    {
      headers: [
        [
          "cookie",
          "a=b",
        ],
      ],
    },
    {
      path: "",
    },
  ]) {
    expect(
      downloadInputSchema.safeParse({
        ...base,
        ...bad,
      }).success,
    ).toBe(false);
  }
});

test("destination paths: Windows needs drive or UNC paths of valid names, other systems absolute paths", () => {
  const ok = (path: string, windows: boolean) => {
    try {
      checkDestination(path, windows);
      return true;
    } catch {
      return false;
    }
  };
  for (const path of [
    "C:\\Users\\me\\a.bin",
    "c:/Users/me/a.bin",
    "\\\\server\\share\\a.bin",
  ]) {
    expect(ok(path, true)).toBe(true);
  }
  for (const path of [
    "a.bin",
    "C:a.bin",
    "C:\\",
    "C:\\dir\\..\\a.bin",
    "C:\\dir\\CON",
    "C:\\dir\\nul.txt",
    "C:\\dir\\a:stream",
    "C:\\dir\\a.",
    "\\\\?\\C:\\a.bin",
    "\\\\.\\COM1",
    "\\\\server\\share",
    "\\\\server\\share\\",
    "C:\\dir\\a\0b",
  ]) {
    expect(ok(path, true)).toBe(false);
  }
  expect(ok("/tmp/a.bin", false)).toBe(true);
  for (const path of [
    "a.bin",
    "/tmp/../a.bin",
    "/tmp/./a.bin",
    "/tmp/",
    "/tmp/a\0b",
  ]) {
    expect(ok(path, false)).toBe(false);
  }
});

test("each download operation needs its own grant", () => {
  const registry = new NativeRegistry([
    network._definition,
  ]);
  for (const name of [
    "download",
    "downloadStatus",
    "cancelDownload",
  ]) {
    const call = {
      operation: `network.${name}`,
      payload: null,
    };
    expect(
      registry.allowed(
        {
          permissions: [
            call.operation,
          ],
        },
        call,
      ),
    ).toBe(true);
    expect(
      registry.allowed(
        {
          permissions: [
            "network.request",
          ],
        },
        call,
      ),
    ).toBe(false);
  }
});

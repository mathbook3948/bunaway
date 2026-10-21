import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError } from "@bunaway/protocol";
import { createUpdater } from "#plugins/updater/src/adapter";
import {
  MAX_PACKAGE_BYTES,
  type PackageFiles,
} from "#plugins/updater/src/contract";
import { createPackageFiles } from "#plugins/updater/src/platforms/package-files";

const ENDPOINT = "https://updates.example.com/{{target}}/{{channel}}";
const PACKAGE_URL = "https://downloads.example.com/app-1.2.0.exe";
const BYTES = new TextEncoder().encode("package-bytes-".repeat(64));
const SHA256 = createHash("sha256").update(BYTES).digest("hex");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bunaway-updater-download-"));
});

afterEach(() => {
  rmSync(root, {
    recursive: true,
    force: true,
  });
});

function updatesDirectory(): string {
  return join(root, "data", "updates");
}

function updateFiles(): string[] {
  return existsSync(updatesDirectory()) ? readdirSync(updatesDirectory()) : [];
}

function environment(): NativeEnvironment {
  return {
    dataRoot: root,
    capabilities: [],
    app: {
      id: "com.example.app",
      version: "1.0.0",
      pluginSettings: {
        updater: {
          endpoint: ENDPOINT,
        },
      },
      launch: {
        mode: "packaged",
        executablePath: "C:\\App.exe",
        args: [],
      },
    },
  };
}

type Manifest = Record<string, unknown>;

function manifestWith(entry: Record<string, unknown>): Manifest {
  return {
    version: "1.2.0",
    platforms: {
      "windows-x86_64": {
        url: PACKAGE_URL,
        ...entry,
      },
    },
  };
}

const GOOD = manifestWith({
  sha256: SHA256,
  size: BYTES.byteLength,
});

type Served = {
  manifest?: Manifest | null;
  /** Answers the package request. */
  packageResponse?: (signal?: AbortSignal) => Response | Promise<Response>;
};

function setup(
  served: Served = {},
  downloadTimeoutMs?: number,
  files: PackageFiles = createPackageFiles(root),
) {
  const requests: string[] = [];
  const state: Served = {
    manifest: GOOD,
    packageResponse: () => new Response(BYTES),
    ...served,
  };
  const fetchImpl = (async (input: URL, init?: RequestInit) => {
    requests.push(String(input));
    if (String(input).startsWith("https://updates.example.com/")) {
      return state.manifest === null
        ? new Response(null, {
            status: 204,
          })
        : new Response(JSON.stringify(state.manifest));
    }
    return (
      state.packageResponse as (
        signal?: AbortSignal,
      ) => Response | Promise<Response>
    )(init?.signal ?? undefined);
  }) as unknown as typeof fetch;
  const instance = createUpdater("windows", "x64", environment(), {
    fetchImpl,
    files,
    ...(downloadTimeoutMs === undefined
      ? {}
      : {
          downloadTimeoutMs,
        }),
  });
  return {
    instance,
    state,
    packageRequests: () =>
      requests.filter((url) => !url.startsWith("https://updates.example.com/")),
  };
}

async function failure(promise: Promise<unknown>): Promise<BunawayError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BunawayError);
    return error as BunawayError;
  }
  throw new Error("Expected the download to fail.");
}

function reasonOf(error: BunawayError): unknown {
  return (
    error.details as {
      reason?: string;
    }
  ).reason;
}

/** A body that sends `first`, then waits until the request is aborted. */
function stalledBody(first: Uint8Array, signal?: AbortSignal): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(first);
        signal?.addEventListener("abort", () =>
          controller.error(new Error("aborted")),
        );
      },
    }),
  );
}

test("a checked update is saved under its digest after the size and SHA-256 match", async () => {
  const { instance } = setup();
  await instance.check();
  const result = await instance.download();
  expect(result).toEqual({
    path: join(updatesDirectory(), `${SHA256}.package`),
    version: "1.2.0",
    size: BYTES.byteLength,
    sha256: SHA256,
  });
  expect(new Uint8Array(readFileSync(result.path))).toEqual(BYTES);
  expect(updateFiles()).toEqual([
    `${SHA256}.package`,
  ]);
});

test("a download without a check, or after a check that found nothing, is refused", async () => {
  const { instance, state, packageRequests } = setup();
  expect(reasonOf(await failure(instance.download()))).toBe("notChecked");
  await instance.check();
  state.manifest = null;
  await instance.check();
  const error = await failure(instance.download());
  expect(error.code).toBe("UNSUPPORTED");
  expect(reasonOf(error)).toBe("notChecked");
  expect(packageRequests()).toEqual([]);
});

test("a manifest without sha256 or size, or with malformed values, never reaches the package server", async () => {
  const cases: [
    Record<string, unknown>,
    string,
  ][] = [
    [
      {
        size: 10,
      },
      "integrityMissing",
    ],
    [
      {
        sha256: SHA256,
      },
      "integrityMissing",
    ],
    [
      {
        sha256: "abc",
        size: 10,
      },
      "integrityInvalid",
    ],
    [
      {
        sha256: SHA256,
        size: "10",
      },
      "integrityInvalid",
    ],
    [
      {
        sha256: SHA256,
        size: 0,
      },
      "integrityInvalid",
    ],
    [
      {
        sha256: SHA256,
        size: 1.5,
      },
      "integrityInvalid",
    ],
    [
      {
        sha256: SHA256,
        size: MAX_PACKAGE_BYTES + 1,
      },
      "tooLarge",
    ],
  ];
  for (const [entry, reason] of cases) {
    const { instance, packageRequests } = setup({
      manifest: manifestWith(entry),
    });
    // The check still works for apps that only show the update.
    expect((await instance.check()).updateAvailable).toBe(true);
    expect(reasonOf(await failure(instance.download()))).toBe(reason);
    expect(packageRequests()).toEqual([]);
  }
});

test("top-level sha256 and size are used when the manifest has no platform table", async () => {
  const { instance } = setup({
    manifest: {
      version: "1.2.0",
      url: PACKAGE_URL,
      sha256: SHA256.toUpperCase(),
      size: BYTES.byteLength,
    },
  });
  await instance.check();
  expect((await instance.download()).sha256).toBe(SHA256);
});

test("a package that does not match the digest is removed", async () => {
  const wrong = new Uint8Array(BYTES);
  wrong[0] = (wrong[0] ?? 0) ^ 1;
  const { instance } = setup({
    packageResponse: () => new Response(wrong),
  });
  await instance.check();
  expect(reasonOf(await failure(instance.download()))).toBe(
    "integrityMismatch",
  );
  expect(updateFiles()).toEqual([]);
});

test("a body longer or shorter than the declared size fails and leaves no file", async () => {
  for (const body of [
    new Uint8Array([
      ...BYTES,
      1,
    ]),
    BYTES.slice(0, BYTES.byteLength - 1),
  ]) {
    const { instance } = setup({
      packageResponse: () => new Response(body),
    });
    await instance.check();
    expect(reasonOf(await failure(instance.download()))).toBe("sizeMismatch");
    expect(updateFiles()).toEqual([]);
  }
});

test("a content-length that differs from the declared size is refused before any byte is stored", async () => {
  const { instance } = setup({
    packageResponse: () =>
      new Response(BYTES, {
        headers: {
          "content-length": String(BYTES.byteLength + 5),
        },
      }),
  });
  await instance.check();
  expect(reasonOf(await failure(instance.download()))).toBe("sizeMismatch");
  expect(updateFiles()).toEqual([]);
});

test("an error status fails and a redirect to http is refused", async () => {
  const missing = setup({
    packageResponse: () =>
      new Response(null, {
        status: 404,
      }),
  });
  await missing.instance.check();
  const status = await failure(missing.instance.download());
  expect(reasonOf(status)).toBe("httpStatus");

  const downgrade = setup({
    packageResponse: () =>
      new Response(null, {
        status: 302,
        headers: {
          location: "http://downloads.example.com/app.exe",
        },
      }),
  });
  await downgrade.instance.check();
  expect(reasonOf(await failure(downgrade.instance.download()))).toBe(
    "redirectScheme",
  );
  expect(updateFiles()).toEqual([]);
});

test("a second download while one runs is busy, and the package server is asked once", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { instance, packageRequests } = setup({
    packageResponse: async () => {
      await gate;
      return new Response(BYTES);
    },
  });
  await instance.check();
  const first = instance.download();
  expect(instance.busy()).toBe(true);
  const error = await failure(instance.download());
  expect(error.code).toBe("BUSY");
  expect(reasonOf(error)).toBe("downloadInProgress");
  release();
  await first;
  expect(instance.busy()).toBe(false);
  expect(packageRequests()).toHaveLength(1);
});

test("cancelling the call stops the download and removes the partial file", async () => {
  const controller = new AbortController();
  const received = Promise.withResolvers<void>();
  const { instance } = setup({
    packageResponse: (signal) => {
      const response = stalledBody(BYTES.slice(0, 10), signal);
      received.resolve();
      return response;
    },
  });
  await instance.check();
  const running = failure(instance.download(controller.signal));
  await received.promise;
  controller.abort();
  expect((await running).code).toBe("CANCELLED");
  expect(updateFiles()).toEqual([]);
});

test("the time limit ends a stalled download and removes the partial file", async () => {
  const { instance } = setup(
    {
      packageResponse: (signal) => stalledBody(BYTES.slice(0, 10), signal),
    },
    50,
  );
  await instance.check();
  expect((await failure(instance.download())).code).toBe("TIMEOUT");
  expect(updateFiles()).toEqual([]);
});

test("dispose cancels a running download and waits until its partial file is gone", async () => {
  const received = Promise.withResolvers<void>();
  const { instance } = setup({
    packageResponse: (signal) => {
      received.resolve();
      return stalledBody(BYTES.slice(0, 10), signal);
    },
  });
  await instance.check();
  const running = failure(instance.download());
  await received.promise;
  await instance.dispose();
  // dispose returns only after the running download has cleaned up.
  expect(updateFiles()).toEqual([]);
  expect((await running).code).toBe("CANCELLED");
  expect((await failure(instance.download())).code).toBe("CANCELLED");
});

test("an intact package from an earlier download is reused without a request, a changed one is fetched again", async () => {
  const { instance, packageRequests } = setup();
  await instance.check();
  const first = await instance.download();
  expect(await instance.download()).toEqual(first);
  expect(packageRequests()).toHaveLength(1);
  writeFileSync(first.path, "tampered");
  expect(await instance.download()).toEqual(first);
  expect(packageRequests()).toHaveLength(2);
  expect(new Uint8Array(readFileSync(first.path))).toEqual(BYTES);
});

test("older packages and partial files are removed, other files stay", async () => {
  mkdirSync(updatesDirectory(), {
    recursive: true,
  });
  const stale = [
    `${"0".repeat(64)}.package`,
    `${"1".repeat(64)}.partial`,
  ];
  for (const name of stale) {
    writeFileSync(join(updatesDirectory(), name), "old");
  }
  writeFileSync(join(updatesDirectory(), "notes.txt"), "keep");
  const { instance } = setup();
  await instance.check();
  await instance.download();
  expect(updateFiles().sort()).toEqual(
    [
      "notes.txt",
      `${SHA256}.package`,
    ].sort(),
  );
});

test("a check after the download started does not change the running download's target", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { instance, state } = setup({
    packageResponse: async () => {
      await gate;
      return new Response(BYTES);
    },
  });
  await instance.check();
  const running = instance.download();
  state.manifest = null;
  await instance.check();
  release();
  expect((await running).sha256).toBe(SHA256);
  expect(reasonOf(await failure(instance.download()))).toBe("notChecked");
});

test("a partial file that cannot be removed does not replace the original failure", async () => {
  const files = createPackageFiles(root);
  const { instance } = setup(
    {
      packageResponse: () => new Response(BYTES.slice(0, 3)),
    },
    undefined,
    {
      ...files,
      async create(sha256) {
        const sink = await files.create(sha256);
        return {
          write: (chunk) => sink.write(chunk),
          finish: () => sink.finish(),
          publish: () => sink.publish(),
          async discard() {
            await sink.discard();
            throw new Error("EBUSY: C:\\secret\\path");
          },
        };
      },
    },
  );
  await instance.check();
  const error = await failure(instance.download());
  expect(reasonOf(error)).toBe("sizeMismatch");
  expect(error.message).not.toContain("secret");
});

test("cancelling while an existing package is verified stops with CANCELLED", async () => {
  const controller = new AbortController();
  const files = createPackageFiles(root);
  const { instance } = setup({}, undefined, {
    ...files,
    async reuse(sha256, size, signal) {
      // The stored file has the declared size, so the real digest calculation runs with an aborted signal.
      controller.abort();
      return files.reuse(sha256, size, signal);
    },
  });
  mkdirSync(updatesDirectory(), {
    recursive: true,
  });
  writeFileSync(join(updatesDirectory(), `${SHA256}.package`), BYTES);
  await instance.check();
  expect((await failure(instance.download(controller.signal))).code).toBe(
    "CANCELLED",
  );
});

test("reusing an existing package also removes the leftovers of other downloads", async () => {
  const { instance } = setup();
  await instance.check();
  await instance.download();
  const stale = join(updatesDirectory(), `${"2".repeat(64)}.package`);
  writeFileSync(stale, "old");
  await instance.download();
  expect(existsSync(stale)).toBe(false);
  expect(updateFiles()).toEqual([
    `${SHA256}.package`,
  ]);
});

test("a package of the declared size with another digest is fetched again", async () => {
  const { instance, packageRequests } = setup();
  await instance.check();
  const first = await instance.download();
  writeFileSync(first.path, new Uint8Array(BYTES.byteLength));
  expect(await instance.download()).toEqual(first);
  expect(packageRequests()).toHaveLength(2);
  expect(new Uint8Array(readFileSync(first.path))).toEqual(BYTES);
});

test("a folder that cannot be created fails with a storage reason and a path-free message", async () => {
  mkdirSync(join(root, "data"), {
    recursive: true,
  });
  writeFileSync(join(root, "data", "updates"), "not a folder");
  const { instance } = setup();
  await instance.check();
  const error = await failure(instance.download());
  expect(reasonOf(error)).toBe("storage");
  expect(error.message).not.toContain(root);
});

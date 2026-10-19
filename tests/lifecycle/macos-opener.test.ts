import { expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeRegistry } from "@bunaway/protocol";
import opener from "../../plugins/opener/src/index.ts";
import {
  assertExistingFile,
  resolveReadableFile,
  stripDevicePrefix,
} from "../../plugins/opener/src/platforms/file-check.ts";
import { normalizeMacosFilePath } from "../../plugins/opener/src/platforms/macos-path.ts";
import { createOpenerAdapter as createAdapter } from "../fixtures/injected-native-plugins.ts";
import { nativeFactory } from "../fixtures/native-platform.ts";

const createOperations = nativeFactory(opener, "macos");

test("macOS file syntax preserves POSIX names without changing Windows helpers", () => {
  for (const path of [
    '/private/tmp/한글 값,".txt',
    "/private/tmp/CON",
    "/a/space .",
    "/a/back\\slash",
  ]) {
    expect(normalizeMacosFilePath(path)).toBe(path);
  }
  for (const path of [
    "relative",
    "C:/file.txt",
    "/",
    "//server/file",
    "/a//b",
    "/a/../b",
    "/a/./b",
    "/a/b/",
    "/a/\0b",
    "/a/\ud800",
    `/a/${"é".repeat(128)}`,
    `/${"x".repeat(259)}`,
  ]) {
    expect(() => normalizeMacosFilePath(path)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});

test("isolated macOS opener preserves validation, acceptance, ownership and unsupported selected apps", async () => {
  const calls: string[] = [];
  const root = await realpath(await mkdtemp(join(tmpdir(), "bunaway-opener-")));
  const path = join(root, "한글 값.txt");
  await writeFile(path, "controlled fixture");
  const adapter = createAdapter({
    openUrl: (url) => {
      calls.push(url);
    },
    openFile: (path) => {
      calls.push(`open:${path}`);
    },
    revealFile: (path) => {
      calls.push(`reveal:${path}`);
    },
    dispose: () => {
      calls.push("workspace:dispose");
    },
  });
  for (const operation of [
    "openFile",
    "revealFile",
  ]) {
    expect(
      await adapter.execute(
        `opener.${operation}`,
        {
          path,
        },
        "backend",
      ),
    ).toBeNull();
  }
  expect(
    await adapter.execute(
      "opener.openUrl",
      {
        url: "https://localhost/한글 값?q=a&b=c#fragment",
      },
      "backend",
    ),
  ).toBeNull();
  expect(calls).toEqual([
    `open:${path}`,
    `reveal:${path}`,
    "https://localhost/%ED%95%9C%EA%B8%80%20%EA%B0%92?q=a&b=c#fragment",
  ]);
  for (const [operation, payload, code] of [
    [
      "opener.openFile",
      {
        path: "relative",
      },
      "INVALID_ARGUMENT",
    ],
    [
      "opener.openFile",
      {
        path,
        extra: true,
      },
      "INVALID_ARGUMENT",
    ],
    [
      "opener.openUrl",
      {
        url: "file:///private/tmp/file",
      },
      "INVALID_ARGUMENT",
    ],
    [
      "opener.openFileWith",
      {
        path,
        app: "C:/app.exe",
      },
      "UNSUPPORTED",
    ],
    [
      "opener.openUrlWith",
      {
        url: "http://localhost/",
        app: "C:/app.exe",
      },
      "UNSUPPORTED",
    ],
    [
      "opener.trashFile",
      {
        path,
      },
      "UNSUPPORTED",
    ],
    [
      "opener.addRecentDocument",
      {
        path,
      },
      "UNSUPPORTED",
    ],
    [
      "opener.clearRecentDocuments",
      {},
      "UNSUPPORTED",
    ],
    [
      "opener.getUrlHandler",
      {
        url: "https://example.com/",
      },
      "UNSUPPORTED",
    ],
    [
      "opener.missing",
      {
        path,
      },
      "UNSUPPORTED",
    ],
  ] as const) {
    await expect(
      adapter.execute(operation, payload, "backend"),
    ).rejects.toThrow(
      expect.objectContaining({
        code,
      }),
    );
  }
  expect(calls).toHaveLength(3);
  await adapter.dispose();
  await adapter.dispose();
  expect(calls.at(-1)).toBe("workspace:dispose");
  await rm(root, {
    recursive: true,
    force: true,
  });
  await expect(
    adapter.execute(
      "opener.openUrl",
      {
        url: "http://localhost/",
      },
      "backend",
    ),
  ).rejects.toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
});

test("each macOS opener operation keeps its independent host permission", () => {
  const registry = new NativeRegistry([
    opener._definition,
  ]);
  for (const operation of [
    "opener.openUrl",
    "opener.openFile",
    "opener.revealFile",
  ]) {
    const call = registry.validateCall({
      operation,
      payload:
        operation === "opener.openUrl"
          ? {
              url: "http://localhost/",
            }
          : {
              path: "/private/tmp/file",
            },
    });
    expect(
      registry.allowed(
        {
          permissions: [],
        },
        call,
      ),
    ).toBe(false);
    expect(
      registry.allowed(
        {
          permissions: [
            operation,
          ],
        },
        call,
      ),
    ).toBe(true);
    const other =
      operation === "opener.openUrl" ? "opener.openFile" : "opener.openUrl";
    expect(
      registry.allowed(
        {
          permissions: [
            other,
          ],
        },
        call,
      ),
    ).toBe(false);
  }
});

test("path resolution reports missing, unreadable and special files and follows links", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bunaway-opener-")));
  const sample = join(root, "한글 값.txt");
  try {
    await writeFile(sample, "controlled fixture");
    expect(resolveReadableFile(sample)).toBe(sample);
    expect(() => resolveReadableFile(`${sample}.missing`)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        details: {
          reason: "FILE_NOT_FOUND",
        },
      }),
    );
    expect(() => resolveReadableFile(root)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    const alias = join(root, "alias");
    await symlink(sample, alias);
    // A link resolves to its target, so callers check and open the target's name.
    expect(resolveReadableFile(alias)).toBe(sample);
    const parentAlias = join(root, "parent");
    await symlink(root, parentAlias);
    expect(resolveReadableFile(join(parentAlias, "한글 값.txt"))).toBe(sample);
    const hard = join(root, "hard");
    await link(sample, hard);
    expect(resolveReadableFile(hard)).toBe(hard);
    await rm(hard);
    const fifo = join(root, "pipe");
    expect(
      Bun.spawnSync([
        "mkfifo",
        fifo,
      ]).exitCode,
    ).toBe(0);
    // A FIFO is refused before it is opened, so this returns instead of blocking.
    expect(() => resolveReadableFile(fifo)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    if (process.getuid?.() !== 0) {
      await chmod(sample, 0);
      expect(() => resolveReadableFile(sample)).toThrow(
        expect.objectContaining({
          code: "PERMISSION_DENIED",
        }),
      );
      await chmod(sample, 0o600);
    }
    // Recycling targets the link itself, so a link needs no readable target.
    assertExistingFile(alias);
    expect(() => assertExistingFile(root)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    expect(() => assertExistingFile(`${sample}.missing`)).toThrow(
      expect.objectContaining({
        details: {
          reason: "FILE_NOT_FOUND",
        },
      }),
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("Win32 device and UNC prefixes of a resolved path are removed", () => {
  expect(stripDevicePrefix("\\\\?\\C:\\dir\\a.txt")).toBe("C:\\dir\\a.txt");
  expect(stripDevicePrefix("\\\\?\\UNC\\host\\share\\a.txt")).toBe(
    "\\\\host\\share\\a.txt",
  );
  expect(stripDevicePrefix("/tmp/a.txt")).toBe("/tmp/a.txt");
});

test.skipIf(process.platform !== "darwin")(
  "real macOS workspace binding load, malformed requests and repeated disposal",
  async () => {
    const adapter = createOperations({
      dataRoot: "/private/tmp",
      capabilities: [],
    });
    try {
      await expect(
        adapter.execute(
          "opener.openUrl",
          {
            url: "javascript:alert(1)",
          },
          "backend",
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      await expect(
        adapter.execute(
          "opener.openFileWith",
          {
            path: "/private/tmp/file",
            app: "C:/app.exe",
          },
          "backend",
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "UNSUPPORTED",
        }),
      );
    } finally {
      await adapter.dispose();
      await adapter.dispose();
    }
  },
);

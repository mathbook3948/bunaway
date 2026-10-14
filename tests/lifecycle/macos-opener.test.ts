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
import { openerPlugin } from "../../plugins/opener/src/index.ts";
import { createFiles } from "../../plugins/opener/src/macos-file.ts";
import { normalizeMacosFilePath } from "../../plugins/opener/src/macos-path.ts";
import { createOpenerAdapter as createAdapter } from "../fixtures/injected-native-plugins.ts";
import { nativeFactory } from "../fixtures/native-platform.ts";
const createOperations = nativeFactory(openerPlugin, "macos");

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
  const adapter = createAdapter(
    {
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
    },
    {
      withFile(path, request) {
        calls.push(`acquire:${path}`);
        try {
          request();
        } finally {
          calls.push(`release:${path}`);
        }
      },
      dispose: () => {
        calls.push("files:dispose");
      },
    },
  );
  const path = "/private/tmp/한글 값.txt";
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
    `acquire:${path}`,
    `open:${path}`,
    `release:${path}`,
    `acquire:${path}`,
    `reveal:${path}`,
    `release:${path}`,
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
  expect(calls).toHaveLength(7);
  await adapter.dispose();
  await adapter.dispose();
  expect(calls.slice(-2)).toEqual([
    "files:dispose",
    "workspace:dispose",
  ]);
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
    openerPlugin,
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

test("macOS resource cleanup still releases the workspace when file cleanup fails", async () => {
  let cleaned = 0;
  const adapter = createAdapter(
    {
      openUrl() {},
      openFile() {},
      revealFile() {},
      dispose() {
        cleaned++;
      },
    },
    {
      withFile(_path, request) {
        request();
      },
      dispose() {
        throw new Error("cleanup failed");
      },
    },
  );
  await expect(adapter.dispose()).rejects.toThrow("cleanup failed");
  await expect(adapter.dispose()).rejects.toThrow("cleanup failed");
  expect(cleaned).toBe(1);
});

test.skipIf(process.platform !== "darwin")(
  "real macOS descriptor checks reject missing files, directories, links and unreadable files",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-opener-")),
    );
    const sample = join(root, "한글 값.txt");
    const files = createFiles();
    try {
      await writeFile(sample, "controlled fixture");
      for (let i = 0; i < 20; i++) {
        let accepted = false;
        files.withFile(sample, () => {
          accepted = true;
        });
        expect(accepted).toBe(true);
        expect(() => files.withFile(`${sample}.missing`, () => {})).toThrow(
          expect.objectContaining({
            code: "INVALID_ARGUMENT",
            details: {
              reason: "FILE_NOT_FOUND",
            },
          }),
        );
      }
      expect(() => files.withFile(root, () => {})).toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      const alias = join(root, "alias");
      await symlink(sample, alias);
      expect(() => files.withFile(alias, () => {})).toThrow(
        expect.objectContaining({
          code: "PERMISSION_DENIED",
        }),
      );
      const parentAlias = join(root, "parent");
      await symlink(root, parentAlias);
      expect(() =>
        files.withFile(join(parentAlias, "한글 값.txt"), () => {}),
      ).toThrow(
        expect.objectContaining({
          code: "PERMISSION_DENIED",
        }),
      );
      const hard = join(root, "hard");
      await link(sample, hard);
      expect(() => files.withFile(sample, () => {})).toThrow(
        expect.objectContaining({
          code: "PERMISSION_DENIED",
        }),
      );
      await rm(hard);
      await chmod(sample, 0);
      expect(() => files.withFile(sample, () => {})).toThrow(
        expect.objectContaining({
          code: "PERMISSION_DENIED",
        }),
      );
      await chmod(sample, 0o600);
      expect(() =>
        files.withFile(sample, () => {
          throw new Error("request failed");
        }),
      ).toThrow(
        expect.objectContaining({
          code: "INTERNAL",
        }),
      );
      await rm(sample);
      files.dispose();
      files.dispose();
      expect(() => files.withFile(sample, () => {})).toThrow(
        expect.objectContaining({
          code: "CANCELLED",
        }),
      );
    } finally {
      files.dispose();
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
);

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

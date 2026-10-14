import { expect, test } from "bun:test";
import path from "@bunaway/plugin-path/native/windows";
import { NativeRegistry } from "@bunaway/protocol";
import { knownFolderId } from "../../plugins/path/src/known-folders.ts";
import { pathOperations } from "../../plugins/path/src/operations.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("path", pathOperations);

test("Pictures and Videos IDs retain the Windows SDK values through mixed-endian GUID encoding", () => {
  expect(knownFolderId("pictures").toString("hex")).toBe(
    "3081e2331e4e7646835a98395c3bc3bb",
  );
  expect(knownFolderId("videos").toString("hex")).toBe(
    "1d9b9818b5995b45841cab7c74e4ddfc",
  );
  expect(knownFolderId("downloads").readUInt16LE(4)).toBe(0x123f);
  expect(knownFolderId("home").readUInt16LE(6)).toBe(0x4760);
});

test("Windows lexical helpers handle Unicode, drives, UNC, namespace paths and trailing separators", async () => {
  const create = path._definition.nativePlatforms.windows?.create;
  if (!create) {
    throw new Error("Windows path adapter is missing.");
  }
  const adapter = create({
    dataRoot: "unused",
    capabilities: [],
  });
  try {
    const call = (
      operation: string,
      input: Parameters<typeof adapter.execute>[1],
    ) => adapter.execute(operation, input, "backend");
    expect(
      await call("path.join", {
        paths: [],
      }),
    ).toBe(".");
    expect(
      await call("path.join", {
        paths: [
          "C:/한글",
          "folder",
          "..",
          "🙂.txt",
        ],
      }),
    ).toBe("C:\\한글\\🙂.txt");
    expect(
      await call("path.normalize", {
        path: "//server/share/한글/../memo.txt",
      }),
    ).toBe("\\\\server\\share\\memo.txt");
    expect(
      await call("path.normalize", {
        path: "\\\\?\\C:\\한글\\file.txt",
      }),
    ).toBe("\\\\?\\C:\\한글\\file.txt");
    expect(
      await call("path.resolve", {
        base: "C:/앱/data",
        paths: [
          "..",
          "notes",
          "memo.txt",
        ],
      }),
    ).toBe("C:\\앱\\notes\\memo.txt");
    expect(
      await call("path.resolve", {
        base: "C:/앱/data",
        paths: [
          "D:/other",
          "file.txt",
        ],
      }),
    ).toBe("D:\\other\\file.txt");
    expect(
      await call("path.resolve", {
        base: "//server/share/app",
        paths: [
          "..",
          "한글.txt",
        ],
      }),
    ).toBe("\\\\server\\share\\한글.txt");
    expect(
      await call("path.basename", {
        path: "C:/folder/한글.tar.gz",
        suffix: ".gz",
      }),
    ).toBe("한글.tar");
    expect(
      await call("path.dirname", {
        path: "C:/folder/file.txt",
      }),
    ).toBe("C:/folder");
    expect(
      await call("path.extname", {
        path: "C:/folder/.hidden",
      }),
    ).toBe("");
    expect(
      await call("path.extname", {
        path: "C:/folder/file.",
      }),
    ).toBe(".");
    expect(
      await call("path.normalize", {
        path: "C:/folder//",
      }),
    ).toBe("C:\\folder\\");
    for (const path of [
      "C:/file",
      "\\rooted",
      "\\\\server\\share\\file",
      "\\\\?\\C:\\file",
    ]) {
      expect(
        await call("path.isAbsolute", {
          path,
        }),
      ).toBe(true);
    }
    for (const path of [
      "",
      "relative/file",
      "C:relative",
    ]) {
      expect(
        await call("path.isAbsolute", {
          path,
        }),
      ).toBe(false);
    }
    await adapter.dispose();
    await adapter.dispose();
    await expect(
      call("path.normalize", {
        path: "x",
      }),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
  } finally {
    await adapter.dispose();
  }
});

test("path resolution never accepts an implicit host or per-drive working directory", async () => {
  for (const payload of [
    {
      paths: [
        "file",
      ],
    },
    {
      base: "relative",
      paths: [],
    },
    {
      base: "C:relative",
      paths: [],
    },
    {
      base: "\\rooted",
      paths: [],
    },
    {
      base: "C:/base",
      paths: [
        "D:relative",
      ],
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "path.resolve",
        payload,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  for (const path of [
    "bad\u0000path",
    "bad\npath",
    "x".repeat(4097),
  ]) {
    await expect(
      parsers.validateCall({
        operation: "path.normalize",
        payload: {
          path,
        },
      }),
    ).rejects.toThrow();
  }
  await expect(
    parsers.validateCall({
      operation: "path.getDirectory",
      payload: {
        directory: "arbitrary-guid",
      },
    }),
  ).rejects.toThrow();
  await expect(
    parsers.validateCall({
      operation: "path.getDirectory",
      payload: {
        directory: "home",
        create: true,
      },
    }),
  ).rejects.toThrow();
});

test("path helper permissions neither imply each other nor grant storage access", () => {
  const registry = new NativeRegistry([
    path._definition,
  ]);
  for (const operation of registry.operations.keys()) {
    for (const target of registry.operations.keys()) {
      expect(
        registry.allowed(
          {
            permissions: [
              operation,
            ],
          },
          {
            operation: target,
            payload: null,
          },
        ),
      ).toBe(target === operation);
    }
  }
});

test("path input bounds count supplementary Unicode as UTF-16 units", async () => {
  const create = path._definition.nativePlatforms.windows?.create;
  if (!create) {
    throw new Error("Windows path adapter is missing.");
  }
  const adapter = create({
    dataRoot: "unused",
    capabilities: [],
  });
  try {
    const exactLimit = "🙂".repeat(2048);
    expect(exactLimit.length).toBe(4096);
    expect(
      await adapter.execute(
        "path.normalize",
        {
          path: exactLimit,
        },
        "backend",
      ),
    ).toBe(exactLimit);
    await expect(
      adapter.execute(
        "path.normalize",
        {
          path: "🙂".repeat(2049),
        },
        "backend",
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  } finally {
    await adapter.dispose();
  }
});

test("path output bounds count supplementary Unicode after joining", async () => {
  const create = path._definition.nativePlatforms.windows?.create;
  if (!create) {
    throw new Error("Windows path adapter is missing.");
  }
  const adapter = create({
    dataRoot: "unused",
    capabilities: [],
  });
  try {
    const paths = [
      "🙂".repeat(1024),
      `${"🙂".repeat(1023)}x`,
    ];
    const expected = paths.join("\\");
    expect(expected.length).toBe(4096);
    expect(
      await adapter.execute(
        "path.join",
        {
          paths,
        },
        "backend",
      ),
    ).toBe(expected);
    await expect(
      adapter.execute(
        "path.join",
        {
          paths: [
            "🙂".repeat(1500),
            "🙂".repeat(1500),
          ],
        },
        "backend",
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
    await expect(
      parsers.validateOutput("path.getDirectory", `C:/${"🙂".repeat(2047)}`),
    ).rejects.toMatchObject({
      code: "INTERNAL",
    });
  } finally {
    await adapter.dispose();
  }
});

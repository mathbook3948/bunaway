import { expect, test } from "bun:test";
import storage from "@bunaway/plugin-storage";
import { NativeRegistry, serializeHostResponse } from "@bunaway/protocol";
import { MAX_DIRECTORY_ENTRIES } from "../../plugins/storage/src/contract.ts";
import { storageOperations } from "../../plugins/storage/src/operations.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("storage", storageOperations);
const location = {
  path: "C:/notes/한글",
};

test("both platforms declare the same operations on the worker thread", () => {
  const targets = storage._definition.nativePlatforms;
  expect(targets.windows?.thread).toBe("worker");
  expect(targets.macos?.thread).toBe("worker");
  expect(targets.windows?.operations).toEqual(Object.keys(storageOperations));
  expect(targets.macos?.operations).toEqual(Object.keys(storageOperations));
});

test("directory operations resolve recursive defaults, bound output and retain independent permissions", async () => {
  expect(
    (
      await parsers.validateCall({
        operation: "storage.createDirectory",
        payload: location,
      })
    ).payload,
  ).toEqual({
    ...location,
    recursive: false,
  });
  expect(
    (
      await parsers.validateCall({
        operation: "storage.createDirectory",
        payload: {
          ...location,
          recursive: true,
        },
      })
    ).payload,
  ).toEqual({
    ...location,
    recursive: true,
  });
  for (const payload of [
    {
      ...location,
      recursive: "true",
    },
    {
      ...location,
      mode: "everyone",
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "storage.createDirectory",
        payload,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(await parsers.validateOutput("storage.readDirectory", [])).toEqual([]);
  const entries = Array.from(
    {
      length: MAX_DIRECTORY_ENTRIES,
    },
    () => ({
      name: "\u0001".repeat(255),
      kind: "file",
    }),
  );
  serializeHostResponse({
    kind: "result",
    payload: await parsers.validateOutput("storage.readDirectory", entries),
  });
  await expect(
    parsers.validateOutput("storage.readDirectory", [
      ...entries,
      {
        name: "extra",
        kind: "file",
      },
    ]),
  ).rejects.toThrow();
  for (const entry of [
    {
      name: "",
      kind: "file",
    },
    {
      name: "x".repeat(256),
      kind: "file",
    },
    {
      name: "file",
      kind: "unknown",
    },
    {
      name: "file",
      kind: "file",
      path: "untrusted",
    },
  ]) {
    await expect(
      parsers.validateOutput("storage.readDirectory", [
        entry,
      ]),
    ).rejects.toThrow();
  }
  const registry = new NativeRegistry([
    storage._definition,
  ]);
  for (const operation of [
    "storage.readDirectory",
    "storage.createDirectory",
    "storage.remove",
    "storage.removeRecursive",
    "storage.directorySize",
  ]) {
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
            payload: location,
          },
        ),
      ).toBe(operation === target);
    }
  }
});

test("directorySize accepts only a path, returns bounded totals and is Windows-only", async () => {
  expect(
    (
      await parsers.validateCall({
        operation: "storage.directorySize",
        payload: location,
      })
    ).payload,
  ).toEqual(location);
  for (const payload of [
    {},
    {
      path: "",
    },
    {
      path: "C:/a\nb",
    },
    {
      ...location,
      recursive: true,
    },
    {
      ...location,
      maxDepth: 1,
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "storage.directorySize",
        payload,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  const totals = {
    bytes: Number.MAX_SAFE_INTEGER,
    files: 2,
    directories: 1,
  };
  expect(await parsers.validateOutput("storage.directorySize", totals)).toEqual(
    totals,
  );
  for (const output of [
    {
      ...totals,
      bytes: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      ...totals,
      files: -1,
    },
    {
      ...totals,
      directories: 1.5,
    },
    {
      bytes: 0,
      files: 0,
    },
    {
      ...totals,
      path: "C:/untrusted",
    },
  ]) {
    await expect(
      parsers.validateOutput("storage.directorySize", output),
    ).rejects.toThrow();
  }
});

test("removeRecursive accepts only a path, returns null and needs its own permission on Windows", async () => {
  expect(
    (
      await parsers.validateCall({
        operation: "storage.removeRecursive",
        payload: location,
      })
    ).payload,
  ).toEqual(location);
  for (const payload of [
    {},
    {
      path: "C:/notes",
      recursive: true,
    },
    {
      path: "C:/a\nb",
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "storage.removeRecursive",
        payload,
      }),
    ).rejects.toThrow();
  }
  expect(await parsers.validateOutput("storage.removeRecursive", null)).toBe(
    null,
  );
  await expect(
    parsers.validateOutput("storage.removeRecursive", {}),
  ).rejects.toThrow();
});

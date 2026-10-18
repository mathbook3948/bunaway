import { expect, test } from "bun:test";
import storage from "@bunaway/plugin-storage";
import { NativeRegistry, serializeHostResponse } from "@bunaway/protocol";
import { MAX_DIRECTORY_ENTRIES } from "../../plugins/storage/src/contract.ts";
import {
  directoryEntries,
  scanDirectoryEntries,
} from "../../plugins/storage/src/platforms/windows-directory-entries.ts";
import { windowsOperations } from "../../plugins/storage/src/platforms/windows-operations.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("storage", windowsOperations);
const location = {
  path: "C:/notes/한글",
};

test("macOS supports directory reads and creation while checked-object removal remains Windows-only", () => {
  const targets = storage._definition.nativePlatforms;
  for (const operation of [
    "storage.readDirectory",
    "storage.createDirectory",
  ]) {
    expect(targets.macos?.thread).toBe("worker");
    expect(targets.macos?.operations).toContain(
      operation.slice("storage.".length),
    );
  }
  expect(targets.macos?.operations).not.toContain("remove");
  expect(targets.macos?.operations).not.toContain("move");
  expect(targets.macos?.operations).toHaveLength(11);
  expect(targets.windows?.thread).toBe("worker");
  expect(targets.windows?.operations).toEqual(Object.keys(windowsOperations));
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
  expect(storage._definition.nativePlatforms.macos?.operations).not.toContain(
    "directorySize",
  );
  expect(storage._definition.nativePlatforms.windows?.operations).toContain(
    "directorySize",
  );
});

function record(name: string, attributes = 0, endOfFile = 0n): Buffer {
  const bytes = Buffer.from(name, "utf16le");
  const record = Buffer.alloc(Math.ceil((104 + bytes.length) / 8) * 8);
  record.writeBigInt64LE(endOfFile, 40);
  record.writeUInt32LE(attributes, 56);
  record.writeUInt32LE(bytes.length, 60);
  bytes.copy(record, 104);
  return record;
}

test("native directory batches decode names and classify reparse points without following them", () => {
  const records = [
    record("."),
    record(".."),
    record("한글🙂.txt"),
    record("folder", 0x10),
    record("junction", 0x410),
  ];
  for (const current of records.slice(0, -1)) {
    current.writeUInt32LE(current.length, 0);
  }
  expect(directoryEntries(Buffer.concat(records))).toEqual([
    {
      name: "한글🙂.txt",
      kind: "file",
    },
    {
      name: "folder",
      kind: "directory",
    },
    {
      name: "junction",
      kind: "link",
    },
  ]);
  expect(
    scanDirectoryEntries(
      Buffer.concat([
        record("big.bin", 0, 2n ** 40n + 7n),
      ]),
    ),
  ).toEqual([
    {
      name: "big.bin",
      kind: "file",
      endOfFile: 2n ** 40n + 7n,
    },
  ]);
  const truncated = record("long-name").subarray(0, 105);
  const beyondBuffer = record("name");
  beyondBuffer.writeUInt32LE(beyondBuffer.length + 8, 0);
  const unaligned = record("name");
  unaligned.writeUInt32LE(105, 0);
  const oddName = record("name");
  oddName.writeUInt32LE(3, 60);
  for (const invalid of [
    Buffer.alloc(8),
    Buffer.alloc(104),
    truncated,
    beyondBuffer,
    unaligned,
    oddName,
    record("x".repeat(256)),
  ]) {
    expect(() => directoryEntries(invalid)).toThrow();
  }
});

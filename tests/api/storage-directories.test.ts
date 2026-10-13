import { expect, test } from "bun:test";
import { storagePlugin } from "@bunaway/plugin-storage";
import { NativeRegistry, serializeHostResponse } from "@bunaway/protocol";
import { storageOperations } from "../../plugins/storage/src/contract.ts";
import {
  directoryEntries,
  MAX_DIRECTORY_ENTRIES,
} from "../../plugins/storage/src/directory-entries.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("storage", storageOperations);
const location = {
  path: "C:/notes/한글",
};

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
    storagePlugin,
  ]);
  for (const operation of [
    "storage.readDirectory",
    "storage.createDirectory",
    "storage.remove",
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

function record(name: string, attributes = 0): Buffer {
  const bytes = Buffer.from(name, "utf16le");
  const record = Buffer.alloc(Math.ceil((104 + bytes.length) / 8) * 8);
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

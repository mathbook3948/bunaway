import { expect, test } from "bun:test";
import storage from "@bunaway/plugin-storage";
import { NativeRegistry, serializeHostResponse } from "@bunaway/protocol";
import { MAX_DIRECTORY_ENTRIES } from "../../plugins/storage/src/contract.ts";
import {
  directoryEntries,
  fileSizeBytes,
  type ScannedDirectoryEntry,
  scanDirectoryEntries,
  scanRole,
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
  expect(targets.macos?.operations).not.toContain("removeRecursive");
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
  expect(storage._definition.nativePlatforms.macos?.operations).not.toContain(
    "directorySize",
  );
  expect(storage._definition.nativePlatforms.windows?.operations).toContain(
    "directorySize",
  );
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
  expect(storage._definition.nativePlatforms.macos?.operations).not.toContain(
    "removeRecursive",
  );
  expect(storage._definition.nativePlatforms.windows?.operations).toContain(
    "removeRecursive",
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
  const [big] = scanDirectoryEntries(
    Buffer.concat([
      record("big.bin", 0, 2n ** 40n + 7n),
    ]),
  );
  expect(big).toEqual({
    name: "big.bin",
    kind: "file",
    endOfFile: 2n ** 40n + 7n,
    reparseTag: 0,
    isDirectoryAttribute: false,
  });
});

test("directory size counts data files behind non-surrogate reparse tags and skips name surrogates", () => {
  const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
  const tagged = (name: string, attributes: number, tag: number) => {
    const entry = record(name, attributes);
    entry.writeUInt32LE(tag, 64);
    return scanDirectoryEntries(entry)[0] as ScannedDirectoryEntry;
  };
  const reparseFile = FILE_ATTRIBUTE_REPARSE_POINT;
  const reparseDirectory = FILE_ATTRIBUTE_REPARSE_POINT | 0x10;
  // Cloud placeholder, deduplicated and WOF-compressed files keep a logical size.
  for (const tag of [
    0x9000001a,
    0x80000013,
    0x80000017,
  ]) {
    expect(scanRole(tagged("data", reparseFile, tag))).toBe("file");
  }
  // Symlink, junction and mount point tags carry the name surrogate bit, for files and folders.
  for (const tag of [
    0xa000000c,
    0xa0000003,
  ]) {
    expect(scanRole(tagged("link", reparseFile, tag))).toBe("skip");
    expect(scanRole(tagged("link-dir", reparseDirectory, tag))).toBe("skip");
  }
  // A cloud folder cannot be entered safely, so the scan must fail instead of skipping it.
  expect(scanRole(tagged("dir", reparseDirectory, 0x9000001a))).toBe(
    "opaque-directory",
  );
  expect(scanRole(tagged("plain", 0, 0))).toBe("file");
  expect(scanRole(tagged("folder", 0x10, 0))).toBe("directory");
});

test("directory size rejects a negative file size while listings stay readable", () => {
  const negative = record("negative.bin", 0, -1n);
  // Listing does not use sizes, so the record still decodes for readDirectory.
  expect(directoryEntries(negative)).toEqual([
    {
      name: "negative.bin",
      kind: "file",
    },
  ]);
  const [entry] = scanDirectoryEntries(negative) as [
    ScannedDirectoryEntry,
  ];
  expect(() => fileSizeBytes(entry)).toThrow("Invalid native directory entry");
  expect(
    fileSizeBytes({
      ...entry,
      endOfFile: 5n,
    }),
  ).toBe(5n);
});

test("malformed native directory batches are rejected", () => {
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

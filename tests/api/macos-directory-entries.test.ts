import { expect, test } from "bun:test";
import {
  darwinDirectoryEntry,
  darwinDirectoryRecordLength,
} from "../../plugins/storage/src/platforms/macos-directory-entries.ts";

function record(name: string, kind = 8): Buffer {
  const bytes = Buffer.from(name);
  const record = Buffer.alloc(Math.ceil((21 + bytes.length + 1) / 4) * 4);
  record.writeUInt16LE(record.length, 16);
  record.writeUInt16LE(bytes.length, 18);
  record[20] = kind;
  bytes.copy(record, 21);
  return record;
}

test("Darwin entries retain UTF-8 names and observed kinds without opening children", () => {
  for (const [name, nativeKind, kind] of [
    [
      "한글🙂.txt",
      8,
      "file",
    ],
    [
      "folder",
      4,
      "directory",
    ],
    [
      "dangling",
      10,
      "link",
    ],
  ] as const) {
    expect(darwinDirectoryEntry(record(name, nativeKind))).toEqual({
      name,
      kind,
    });
  }
  expect(darwinDirectoryEntry(record("."))).toBeNull();
  expect(darwinDirectoryEntry(record(".."))).toBeNull();
  for (const kind of [
    0,
    1,
    2,
    6,
    12,
    14,
  ]) {
    expect(() => darwinDirectoryEntry(record("special", kind))).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED",
      }),
    );
  }
  // The public bound counts UTF-16 code units, independently of native UTF-8 bytes.
  expect(darwinDirectoryEntry(record("한".repeat(255)))?.name.length).toBe(255);
  expect(() => darwinDirectoryEntry(record("🙂".repeat(128)))).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
});

test("Darwin record bounds, terminators and invalid names fail before decoding untrusted bytes", () => {
  const tooShort = record("x");
  tooShort.writeUInt16LE(20, 16);
  const unaligned = record("x");
  unaligned.writeUInt16LE(25, 16);
  const oversized = record("x");
  oversized.writeUInt16LE(1052, 16);
  const impossibleName = record("x");
  impossibleName.writeUInt16LE(1024, 18);
  for (const header of [
    Buffer.alloc(20),
    record(""),
    tooShort,
    unaligned,
    oversized,
    impossibleName,
  ]) {
    expect(() => darwinDirectoryRecordLength(header)).toThrow();
  }
  const unterminated = record("x");
  unterminated[22] = 1;
  const invalidUtf8 = record("x");
  invalidUtf8[21] = 0xff;
  for (const invalid of [
    record("long-name").subarray(0, 22),
    unterminated,
    invalidUtf8,
    record("a/b"),
    record("a\0b"),
  ]) {
    expect(() => darwinDirectoryEntry(invalid)).toThrow();
  }
});

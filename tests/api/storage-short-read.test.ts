import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { NodeStorage } from "../../plugins/storage/src/platforms/node-storage.ts";

/** The shared operations with the simplest path rules; the move is not used here. */
class TestStorage extends NodeStorage {
  constructor() {
    super({
      normalize: (path) => path,
      isBelow: (parent, child) => child.startsWith(`${parent}${sep}`),
    });
  }

  protected moveWithoutReplace(): void {}

  protected release(): void {}
}

const CONTENT = Buffer.from("0123456789abcdef");
let root = "";
let storage: TestStorage;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bunaway-short-"));
  storage = new TestStorage();
});

afterEach(() => {
  storage.dispose();
  rmSync(root, {
    recursive: true,
    force: true,
  });
});

function sample(): string {
  const path = join(root, "sample.bin");
  writeFileSync(path, CONTENT);
  return path;
}

/**
 * Make reads behave as if the file shrank after its size was checked: the first read returns at
 * most `firstBytes` bytes and every later read reports the end of the file. A real truncation
 * between the size check and the read cannot be timed, so the read call stands in for it.
 */
function shrinkAfter<T>(firstBytes: number, action: () => T): T {
  const original = fs.readSync;
  let reads = 0;
  const spy = spyOn(fs, "readSync").mockImplementation(((
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    reads += 1;
    if (reads > 1) {
      return 0;
    }
    return original(fd, buffer, offset, Math.min(length, firstBytes), position);
  }) as typeof fs.readSync);
  try {
    return action();
  } finally {
    spy.mockRestore();
  }
}

test("a whole read of a file that shrinks fails instead of returning fewer bytes", () => {
  const path = sample();
  for (const firstBytes of [
    0,
    5,
  ]) {
    expect(() =>
      shrinkAfter(firstBytes, () =>
        storage.readBytes({
          path,
        }),
      ),
    ).toThrow("Storage file changed during read.");
  }
});

test("a range read of a file that shrinks fails instead of returning fewer bytes", () => {
  const path = sample();
  for (const firstBytes of [
    0,
    3,
  ]) {
    expect(() =>
      shrinkAfter(firstBytes, () =>
        storage.readBytes({
          path,
          offset: 4,
          length: 8,
        }),
      ),
    ).toThrow("Storage file changed during read.");
  }
});

test("a copy of a file that shrinks fails and leaves the source untouched", () => {
  const from = sample();
  const to = join(root, "copy.bin");
  expect(() =>
    shrinkAfter(6, () =>
      storage.copyFile({
        from,
        to,
      }),
    ),
  ).toThrow("Storage file changed during copy.");
  expect(readFileSync(from)).toEqual(CONTENT);
  // The destination was created exclusively before the failure and is kept, not deleted by name.
  expect(existsSync(to)).toBe(true);
});

test("a range longer than the file returns the available bytes, and a start at or past the end is empty", () => {
  const path = sample();
  expect(
    storage.readBytes({
      path,
      offset: 10,
      length: 100,
    }),
  ).toBe(CONTENT.subarray(10).toString("base64"));
  for (const offset of [
    CONTENT.length,
    CONTENT.length + 50,
  ]) {
    expect(
      storage.readBytes({
        path,
        offset,
        length: 4,
      }),
    ).toBe("");
  }
});

test("a file that grows after its size was checked is read only up to the checked size", () => {
  for (const [range, expected] of [
    [
      undefined,
      CONTENT,
    ],
    [
      {
        offset: 4,
        length: 100,
      },
      CONTENT.subarray(4),
    ],
  ] as const) {
    const path = sample();
    const original = fs.readSync;
    let grown = false;
    const spy = spyOn(fs, "readSync").mockImplementation(((
      ...args: Parameters<typeof fs.readSync>
    ) => {
      if (!grown) {
        grown = true;
        fs.appendFileSync(path, "more bytes");
      }
      return original(...args);
    }) as typeof fs.readSync);
    try {
      expect(
        storage.readBytes({
          path,
          ...range,
        }),
      ).toBe(expected.toString("base64"));
      // The file only grows if the spy sits on the read the storage code makes.
      expect(grown).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }
});

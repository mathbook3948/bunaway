import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import storage from "@bunaway/plugin-storage";
import { NativeRegistry } from "@bunaway/protocol";
import {
  DEFAULT_DIRECTORY_PAGE_ENTRIES,
  MAX_DIRECTORY_ENTRIES,
  type StorageDirectoryEntry,
  type StorageDirectoryPage,
} from "../../plugins/storage/src/contract.ts";
import { storageOperations } from "../../plugins/storage/src/operations.ts";
import { listDirectoryPage } from "../../plugins/storage/src/platforms/node-directory.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("storage", storageOperations);
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bunaway-storage-page-"));
});

afterEach(() => {
  rmSync(root, {
    recursive: true,
    force: true,
  });
});

function createFiles(names: string[]): void {
  for (const name of names) {
    writeFileSync(join(root, name), "");
  }
}

/** Follow `next` until the listing ends, returning every page. */
function readAllPages(limit: number): StorageDirectoryPage[] {
  const pages: StorageDirectoryPage[] = [];
  let after: string | undefined;
  do {
    const page = listDirectoryPage(root, after, limit);
    pages.push(page);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return pages;
}

const names = (entries: StorageDirectoryEntry[]) =>
  entries.map((entry) => entry.name);

test("pages cover a directory over the entry limit once, in UTF-16 order", () => {
  const count = MAX_DIRECTORY_ENTRIES * 2 + 5;
  const created = Array.from(
    {
      length: count,
    },
    (_, index) => `f${String(index).padStart(4, "0")}`,
  );
  createFiles(created);
  const pages = readAllPages(DEFAULT_DIRECTORY_PAGE_ENTRIES);
  expect(pages.map((page) => page.entries.length)).toEqual([
    MAX_DIRECTORY_ENTRIES,
    MAX_DIRECTORY_ENTRIES,
    5,
  ]);
  expect(pages.map((page) => page.next === null)).toEqual([
    false,
    false,
    true,
  ]);
  expect(pages.flatMap((page) => names(page.entries))).toEqual(created);
});

test("a directory that ends exactly on a page boundary reports no next page", () => {
  createFiles([
    "a",
    "b",
    "c",
    "d",
  ]);
  const pages = readAllPages(2);
  expect(pages.map((page) => names(page.entries))).toEqual([
    [
      "a",
      "b",
    ],
    [
      "c",
      "d",
    ],
  ]);
  expect(pages.map((page) => page.next)).toEqual([
    "b",
    null,
  ]);
});

test("names sort by UTF-16 code unit and the cursor need not name an existing entry", () => {
  // U+FF5E sorts after the surrogate pair of U+1F600 by code unit, unlike by code point.
  const created = [
    "B",
    "a",
    "\u{1F600}",
    "\uFF5E",
  ];
  createFiles(created);
  const expected = [
    ...created,
  ].sort();
  expect(expected.at(-1)).toBe("\uFF5E");
  expect(names(listDirectoryPage(root, undefined, 10).entries)).toEqual(
    expected,
  );
  expect(names(listDirectoryPage(root, "b", 10).entries)).toEqual([
    "\u{1F600}",
    "\uFF5E",
  ]);
  expect(listDirectoryPage(root, "\uFF5E", 10)).toEqual({
    entries: [],
    next: null,
  });
});

test("names removed and added between pages are neither repeated nor skipped", () => {
  createFiles([
    "a",
    "b",
    "c",
    "d",
    "e",
  ]);
  const first = listDirectoryPage(root, undefined, 2);
  expect(first.next).toBe("b");
  unlinkSync(join(root, "b"));
  unlinkSync(join(root, "c"));
  createFiles([
    "aa",
    "cc",
  ]);
  const second = listDirectoryPage(root, first.next ?? undefined, 2);
  expect(names(second.entries)).toEqual([
    "cc",
    "d",
  ]);
  expect(second.next).toBe("d");
  expect(
    names(listDirectoryPage(root, second.next ?? undefined, 2).entries),
  ).toEqual([
    "e",
  ]);
});

test("entries carry the kinds of readDirectory and links are not followed", () => {
  mkdirSync(join(root, "folder"));
  writeFileSync(join(root, "plain"), "");
  let linked = true;
  try {
    symlinkSync(join(root, "folder"), join(root, "link"), "junction");
  } catch {
    // Creating links can need a privilege this runner lacks, which is not a storage failure.
    linked = false;
  }
  const { entries } = listDirectoryPage(root, undefined, 10);
  expect(entries).toEqual([
    {
      name: "folder",
      kind: "directory",
    },
    ...(linked
      ? [
          {
            name: "link",
            kind: "link" as const,
          },
        ]
      : []),
    {
      name: "plain",
      kind: "file",
    },
  ]);
});

test("a file target is not a directory", () => {
  createFiles([
    "a",
  ]);
  expect(() => listDirectoryPage(join(root, "a"), undefined, 10)).toThrow();
});

test("readDirectoryPage validates input, bounds output and keeps its own permission", async () => {
  const location = {
    path: "C:/notes/한글",
  };
  expect(
    (
      await parsers.validateCall({
        operation: "storage.readDirectoryPage",
        payload: location,
      })
    ).payload,
  ).toEqual(location);
  expect(
    (
      await parsers.validateCall({
        operation: "storage.readDirectoryPage",
        payload: {
          ...location,
          after: "b",
          limit: MAX_DIRECTORY_ENTRIES,
        },
      })
    ).payload,
  ).toEqual({
    ...location,
    after: "b",
    limit: MAX_DIRECTORY_ENTRIES,
  });
  for (const extra of [
    {
      limit: 0,
    },
    {
      limit: MAX_DIRECTORY_ENTRIES + 1,
    },
    {
      limit: 1.5,
    },
    {
      after: "",
    },
    {
      after: "x".repeat(256),
    },
    {
      after: 1,
    },
    {
      cursor: "b",
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "storage.readDirectoryPage",
        payload: {
          ...location,
          ...extra,
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  const entry = {
    name: "a",
    kind: "file",
  };
  expect(
    await parsers.validateOutput("storage.readDirectoryPage", {
      entries: [
        entry,
      ],
      next: "a",
    }),
  ).toEqual({
    entries: [
      entry,
    ],
    next: "a",
  });
  for (const output of [
    {
      entries: Array.from(
        {
          length: MAX_DIRECTORY_ENTRIES + 1,
        },
        () => entry,
      ),
      next: null,
    },
    {
      entries: [],
    },
    {
      entries: [],
      next: "",
    },
    [
      entry,
    ],
  ]) {
    await expect(
      parsers.validateOutput("storage.readDirectoryPage", output),
    ).rejects.toThrow();
  }
  const registry = new NativeRegistry([
    storage._definition,
  ]);
  for (const target of registry.operations.keys()) {
    expect(
      registry.allowed(
        {
          permissions: [
            "storage.readDirectoryPage",
          ],
        },
        {
          operation: target,
          payload: location,
        },
      ),
    ).toBe(target === "storage.readDirectoryPage");
  }
});

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MAX_DIRECTORY_ENTRIES,
  type StorageDirectoryEntry,
} from "#plugins/storage/src/contract";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";

assert.equal(process.platform, "win32");

const root = resolve(
  import.meta.dir,
  `../../build/wdp-${crypto.randomUUID().slice(0, 8)}`,
);
const storage = new WindowsStorage();
const at = (path: string) => ({
  path: `${root}/${path}`,
});

/** Read every page of a directory, following `next` the way an app does. */
function readPages(path: string, limit?: number): StorageDirectoryEntry[][] {
  const pages: StorageDirectoryEntry[][] = [];
  let after: string | undefined;
  do {
    const page = storage.readDirectoryPage({
      ...at(path),
      after,
      limit,
    });
    pages.push(page.entries);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return pages;
}

try {
  // NTFS compares names without case, so no two names here differ only by case. The listing order
  // is by UTF-16 code unit: upper case letters come before lower case ones and a supplementary
  // character sorts before U+FF5E.
  const mixed = [
    "b.txt",
    "C.txt",
    "a.txt",
    "한글.txt",
    "\u{1F600}.txt",
    "～.txt",
    "Z.txt",
  ];
  await mkdir(`${root}/small/folder`, {
    recursive: true,
  });
  for (const name of mixed) {
    await writeFile(`${root}/small/${name}`, "x");
  }
  const small = storage.readDirectory(at("small"));
  assert.deepEqual(
    small.map((entry) => entry.name),
    [
      ...mixed,
      "folder",
    ].sort(),
  );
  for (const limit of [
    1,
    3,
    small.length,
    small.length + 1,
  ]) {
    assert.deepEqual(readPages("small", limit).flat(), small);
  }
  assert.deepEqual(
    storage
      .readDirectoryPage({
        ...at("small"),
        after: "b",
      })
      .entries.map((entry) => entry.name),
    small.map((entry) => entry.name).filter((name) => name > "b"),
  );

  // A directory over the readDirectory limit is read completely, once, in order.
  await mkdir(`${root}/large`);
  const large = Array.from(
    {
      length: MAX_DIRECTORY_ENTRIES + 44,
    },
    (_, index) => `file-${String(index).padStart(4, "0")}.txt`,
  );
  await Promise.all(
    large.map((name) => writeFile(`${root}/large/${name}`, "")),
  );
  assert.throws(
    () => storage.readDirectory(at("large")),
    (error) =>
      error instanceof Error &&
      Reflect.get(error, "code") === "INVALID_ARGUMENT",
  );
  const pages = readPages("large");
  assert.deepEqual(
    pages.map((page) => page.length),
    [
      MAX_DIRECTORY_ENTRIES,
      44,
    ],
  );
  assert.deepEqual(
    pages.flat().map((entry) => entry.name),
    large,
  );
  assert.deepEqual(
    storage.readDirectoryPage({
      ...at("large"),
      after: large.at(-1),
    }),
    {
      entries: [],
      next: null,
    },
  );
} finally {
  storage.dispose();
  await rm(root, {
    recursive: true,
    force: true,
  });
}
console.log(
  "PASS Windows storage readDirectoryPage: UTF-16 name order, cursor continuation and a directory over the readDirectory limit",
);

import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MAX_DIRECTORY_ENTRIES,
  type StorageRecursiveEntry,
} from "#plugins/storage/src/contract";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";

assert.equal(process.platform, "win32");

const root = resolve(
  import.meta.dir,
  `../../build/wrl-${crypto.randomUUID().slice(0, 8)}`,
);
const storage = new WindowsStorage();
const at = (path: string) => ({
  path: `${root}/${path}`,
});

/** Read every page of a tree, following `next` the way an app does. */
async function readPages(
  path: string,
  limit?: number,
): Promise<StorageRecursiveEntry[][]> {
  const pages: StorageRecursiveEntry[][] = [];
  let after: string | undefined;
  do {
    const page = await storage.readDirectoryRecursive({
      ...at(path),
      after,
      limit,
    });
    pages.push(page.entries);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return pages;
}

async function tryLink(
  target: string,
  path: string,
  type: "junction" | "file",
): Promise<boolean> {
  try {
    await symlink(`${root}/${target}`, `${root}/${path}`, type);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      console.log(
        `SKIP ${type} link creation is not permitted on this runner.`,
      );
      return false;
    }
    throw error;
  }
}

try {
  // Depth first order on the real file system: a directory comes right before its contents and
  // siblings follow UTF-16 code unit order, so "a" and its contents precede "a b" although the
  // space sorts before "/". NTFS names do not differ only by case.
  await mkdir(`${root}/tree/a/deep`, {
    recursive: true,
  });
  await mkdir(`${root}/tree/한글`, {
    recursive: true,
  });
  for (const file of [
    "tree/a/deep/y.txt",
    "tree/a/x.txt",
    "tree/a b.txt",
    "tree/한글/z.txt",
    "tree/B.txt",
    "tree/\u{1F600}.txt",
    "tree/～.txt",
  ]) {
    await writeFile(`${root}/${file}`, "x");
  }
  const whole = await storage.readDirectoryRecursive(at("tree"));
  assert.equal(whole.next, null);
  assert.deepEqual(
    whole.entries.map((entry) => entry.path),
    [
      "B.txt",
      "a",
      "a/deep",
      "a/deep/y.txt",
      "a/x.txt",
      "a b.txt",
      "한글",
      "한글/z.txt",
      "\u{1F600}.txt",
      "～.txt",
    ],
  );
  for (const limit of [
    1,
    3,
    whole.entries.length,
  ]) {
    assert.deepEqual((await readPages("tree", limit)).flat(), whole.entries);
  }

  // Links are listed as links and not entered, so a junction back to an ancestor ends the walk.
  await mkdir(`${root}/outside`, {
    recursive: true,
  });
  await writeFile(`${root}/outside/big.bin`, "x");
  await mkdir(`${root}/linked`, {
    recursive: true,
  });
  await writeFile(`${root}/linked/own.bin`, "x");
  const outsideLink = await tryLink("outside", "linked/outside", "junction");
  const parentLink = await tryLink("linked", "linked/self", "junction");
  const fileLink = await tryLink(
    "outside/big.bin",
    "linked/file-link.bin",
    "file",
  );
  const linked = await storage.readDirectoryRecursive(at("linked"));
  const allLinked: StorageRecursiveEntry[] = [
    {
      path: "file-link.bin",
      kind: "link",
    },
    {
      path: "outside",
      kind: "link",
    },
    {
      path: "own.bin",
      kind: "file",
    },
    {
      path: "self",
      kind: "link",
    },
  ];
  // Only the links this runner may create exist.
  const created: Record<string, boolean> = {
    "file-link.bin": fileLink,
    outside: outsideLink,
    "own.bin": true,
    self: parentLink,
  };
  assert.deepEqual(
    linked.entries,
    allLinked.filter((entry) => created[entry.path]),
  );
  console.log(
    `Link coverage: outside junction=${outsideLink}, parent junction=${parentLink}, file symlink=${fileLink}.`,
  );

  // A tree over the readDirectory limit is read completely, once, in order.
  await mkdir(`${root}/large/inner`, {
    recursive: true,
  });
  const large = Array.from(
    {
      length: MAX_DIRECTORY_ENTRIES + 44,
    },
    (_, index) => `inner/file-${String(index).padStart(4, "0")}.txt`,
  );
  await Promise.all(
    large.map((name) => writeFile(`${root}/large/${name}`, "")),
  );
  const pages = await readPages("large");
  assert.deepEqual(
    pages.map((page) => page.length),
    [
      MAX_DIRECTORY_ENTRIES,
      45,
    ],
  );
  assert.deepEqual(
    pages.flat().map((entry) => entry.path),
    [
      "inner",
      ...large,
    ],
  );

  // A file and a missing directory are rejected.
  for (const path of [
    "large/inner/file-0000.txt",
    "missing",
  ]) {
    await assert.rejects(
      storage.readDirectoryRecursive(at(path)),
      (error) =>
        error instanceof Error &&
        Reflect.get(error, "code") === "INVALID_ARGUMENT",
    );
  }
} finally {
  storage.dispose();
  await rm(root, {
    recursive: true,
    force: true,
  });
}
console.log(
  "PASS Windows storage readDirectoryRecursive: depth first UTF-16 order, cursor paging, links listed and not entered",
);

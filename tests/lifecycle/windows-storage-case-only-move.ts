import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BunawayError } from "@bunaway/protocol";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";

assert.equal(process.platform, "win32");

const root = resolve(
  import.meta.dir,
  `../../build/wco-${crypto.randomUUID().slice(0, 8)}`,
);
const storage = new WindowsStorage();
const path = (name: string) => `${root}/${name}`;
const move = (from: string, to: string) =>
  storage.move({
    from: path(from),
    to: path(to),
  });
/** The spellings of one name in the root listing, compared without regard to case. */
const spellings = (name: string) =>
  storage
    .readDirectory({
      path: root,
    })
    .map((entry) => entry.name)
    .filter((entry) => entry.toLowerCase() === name);

await mkdir(`${root}/dir`, {
  recursive: true,
});
try {
  await writeFile(path("a.txt"), "file content");
  await writeFile(path("dir/inner.txt"), "inner content");

  // A case-sensitive directory (a per-directory NTFS flag) tells both spellings apart, and then a
  // case-only change is an ordinary rename to an absent name, which this test is not about.
  if (
    !storage.exists({
      path: path("A.TXT"),
    })
  ) {
    console.log(
      "SKIP Windows storage case-only move: the test directory distinguishes case, so the rename is not a case-only change here",
    );
  } else {
    // A file renamed to another case of its own name succeeds, the listing shows only the new
    // spelling once, and the content is kept.
    move("a.txt", "A.txt");
    assert.deepEqual(spellings("a.txt"), [
      "A.txt",
    ]);
    assert.equal(await readFile(path("a.txt"), "utf8"), "file content");

    // A directory with children keeps them under the new spelling.
    move("dir", "Dir");
    assert.deepEqual(spellings("dir"), [
      "Dir",
    ]);
    assert.equal(
      await readFile(path("Dir/inner.txt"), "utf8"),
      "inner content",
    );

    // Moving a name onto its own spelling is not part of the case-only contract. The outcome is
    // printed, and the entry must be intact either way.
    let sameSpelling = "returned";
    try {
      move("A.txt", "A.txt");
    } catch (error) {
      sameSpelling = error instanceof BunawayError ? error.code : String(error);
    }
    console.log(`INFO same-spelling move ${sameSpelling}`);
    assert.deepEqual(spellings("a.txt"), [
      "A.txt",
    ]);
    assert.equal(await readFile(path("A.txt"), "utf8"), "file content");

    console.log(
      "PASS Windows storage case-only move: renaming a file or a directory with children to another case of the same name succeeds, the listing shows the new spelling once with the content kept",
    );
  }
} finally {
  storage.dispose();
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";

assert.equal(process.platform, "win32");

const root = resolve(
  import.meta.dir,
  `../../build/wlu-${crypto.randomUUID().slice(0, 8)}`,
);
const storage = new WindowsStorage();
const at = (path: string) => ({
  path,
});

// The administrative share of the drive that holds the build folder: `D:\a\x` becomes `\\localhost\D$\a\x`.
const shareRoot = `\\\\localhost\\${root[0]}$\\`;
const uncRoot = `\\\\localhost\\${root.replace(":", "$")}`;

// Six 60 character folders put the file path well above MAX_PATH (260) in UNC spelling.
const top = "0".repeat(60);
const deep = [
  top,
  ...[
    1,
    2,
    3,
    4,
    5,
  ].map((index) => String(index).repeat(60)),
].join("\\");
const directory = `${uncRoot}\\${deep}`;
const file = `${directory}\\한글 long.txt`;
assert(file.length > 400, "The test path must exceed MAX_PATH.");
const text = "long unc path 🙂";

/** Run a raw call and print whether it worked, so a later failure can be told apart from a runner limit. */
function probe(label: string, action: () => unknown): void {
  try {
    action();
    console.log(`PROBE ${label}: ok`);
  } catch (error) {
    console.log(`PROBE ${label}: ${String(error)}`);
  }
}

try {
  mkdirSync(root, {
    recursive: true,
  });
  if (existsSync(shareRoot)) {
    // How the raw file system treats a long UNC path in each spelling, for the record.
    const rawDirectory = `${uncRoot}\\raw\\${"7".repeat(60)}\\${"8".repeat(60)}\\${"9".repeat(60)}\\${"a".repeat(60)}\\${"b".repeat(60)}`;
    const extended = (path: string) => `\\\\?\\UNC\\${path.slice(2)}`;
    probe("mkdir without prefix", () =>
      mkdirSync(rawDirectory, {
        recursive: true,
      }),
    );
    probe("write without prefix", () =>
      writeFileSync(`${rawDirectory}\\raw.txt`, text),
    );
    probe("mkdir with UNC prefix", () =>
      mkdirSync(extended(rawDirectory), {
        recursive: true,
      }),
    );
    probe("write with UNC prefix", () =>
      writeFileSync(extended(`${rawDirectory}\\raw.txt`), text),
    );

    // The write creates the missing parent folders, then the file is read back through the same path.
    storage.writeText({
      path: file,
      text,
    });
    assert.equal(storage.readText(at(file)), text);
    assert.equal(storage.exists(at(file)), true);
    assert.equal(storage.stat(at(file))?.kind, "file");

    // Entries come back as plain names.
    assert.deepEqual(
      storage.readDirectory(at(directory)).map((entry) => entry.name),
      [
        "한글 long.txt",
      ],
    );
    const size = await storage.directorySize(at(`${uncRoot}\\${top}`));
    assert.equal(size.files, 1);

    // Copy and move work across long UNC paths and still refuse to replace.
    const copy = `${directory}\\copy.txt`;
    storage.copyFile({
      from: file,
      to: copy,
    });
    assert.equal(storage.readText(at(copy)), text);
    assert.throws(
      () =>
        storage.move({
          from: copy,
          to: file,
        }),
      /already exists/,
    );
    const moved = `${directory}\\moved.txt`;
    storage.move({
      from: copy,
      to: moved,
    });
    assert.equal(storage.exists(at(copy)), false);
    assert.equal(storage.readText(at(moved)), text);

    // The share reaches the real tree: the same file is readable through the local drive path.
    assert.equal(storage.readText(at(`${root}\\${deep}\\moved.txt`)), text);

    // An error for a missing long UNC path is the public one and shows no prefix.
    try {
      storage.readText(at(`${directory}\\missing.txt`));
      assert.fail("Reading a missing file must fail.");
    } catch (error) {
      assert(error instanceof Error);
      assert.equal(error.message, "Storage target not found.");
    }

    storage.remove(at(moved));
    assert.equal(storage.exists(at(moved)), false);
    await storage.removeRecursive(at(`${uncRoot}\\${top}`));
    assert.equal(existsSync(`${root}\\${top}`), false);
  } else {
    console.log(
      "SKIP the administrative share is not available on this runner.",
    );
  }
  console.log("windows-storage-long-unc-path ok");
} finally {
  storage.dispose();
  rmSync(`\\\\?\\${root}`, {
    recursive: true,
    force: true,
  });
}

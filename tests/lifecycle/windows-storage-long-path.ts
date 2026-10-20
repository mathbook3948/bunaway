import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";

assert.equal(process.platform, "win32");

const root = resolve(
  import.meta.dir,
  `../../build/wlp-${crypto.randomUUID().slice(0, 8)}`,
);
const storage = new WindowsStorage();
const at = (path: string) => ({
  path,
});

// Six 60 character folders put the file path well above MAX_PATH (260).
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
const directory = `${root}\\${deep}`;
const file = `${directory}\\한글 long.txt`;
assert(file.length > 400, "The test path must exceed MAX_PATH.");
const text = "long path 🙂";

// Record whether the runner allows long paths without the prefix, so a result can be read correctly.
const longPaths = Bun.spawnSync([
  "reg",
  "query",
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem",
  "/v",
  "LongPathsEnabled",
]);
console.log(
  `LongPathsEnabled: ${longPaths.stdout.toString().trim() || "unreadable"}`,
);

try {
  await mkdir(root, {
    recursive: true,
  });
  // The write creates the missing parent folders, then the file is read back through the same path.
  storage.writeText({
    path: file,
    text,
  });
  assert.equal(storage.readText(at(file)), text);
  assert.equal(storage.exists(at(file)), true);
  assert.equal(storage.stat(at(file))?.kind, "file");

  // Entries come back as plain names without the extended-length prefix.
  assert.deepEqual(
    storage.readDirectory(at(directory)).map((entry) => entry.name),
    [
      "한글 long.txt",
    ],
  );
  const size = await storage.directorySize(at(`${root}\\${top}`));
  assert.equal(size.files, 1);

  // Copy and move work across long paths and still refuse to replace.
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

  // A folder cannot move into itself, compared by the app's spelling without the prefix.
  assert.throws(
    () =>
      storage.move({
        from: `${root}\\${top}`,
        to: `${directory}\\inside`,
      }),
    /into itself/,
  );

  // An error for a missing long path is the public one and does not show the extended prefix.
  try {
    storage.readText(at(`${directory}\\missing.txt`));
    assert.fail("Reading a missing file must fail.");
  } catch (error) {
    assert(error instanceof Error);
    assert.equal(error.message, "Storage target not found.");
  }

  // The same tree through the administrative share of this machine; a UNC path keeps its spelling.
  // Writing directly under a share root checks the parent folder handling of that form.
  const unc = `\\\\localhost\\${root.replace(":", "$")}`;
  if (existsSync(`\\\\localhost\\${root[0]}$\\`)) {
    const uncFile = `${unc}\\${top}\\unc-direct.txt`;
    storage.writeText({
      path: uncFile,
      text,
    });
    assert.equal(storage.readText(at(uncFile)), text);
    assert.deepEqual(
      storage
        .readDirectory(at(`${unc}\\${top}`))
        .map((entry) => entry.name)
        .sort(),
      [
        "unc-direct.txt",
        deep.split("\\")[1],
      ].sort(),
    );
    storage.remove(at(uncFile));
    const shareRootFile = `\\\\localhost\\${root[0]}$\\wlp-share-root-${crypto.randomUUID().slice(0, 8)}.txt`;
    try {
      storage.writeText({
        path: shareRootFile,
        text,
      });
      assert.equal(storage.readText(at(shareRootFile)), text);
    } catch (error) {
      // The runner may not let this account write to the root of the drive.
      assert(
        error instanceof Error && error.message === "Storage access denied.",
        String(error),
      );
      console.log("SKIP share root is not writable on this runner.");
    } finally {
      rmSync(shareRootFile, {
        force: true,
      });
    }
  } else {
    console.log(
      "SKIP the administrative share is not available on this runner.",
    );
  }

  storage.remove(at(moved));
  assert.equal(storage.exists(at(moved)), false);
  await storage.removeRecursive(at(`${root}\\${top}`));
  assert.deepEqual(await readdir(root), []);
  console.log("windows-storage-long-path ok");
} finally {
  storage.dispose();
  rmSync(`\\\\?\\${root}`, {
    recursive: true,
    force: true,
  });
}

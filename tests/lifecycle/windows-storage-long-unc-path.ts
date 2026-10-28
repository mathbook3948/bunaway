import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";
import { killAfter } from "../fixtures/deadlines";

assert.equal(process.platform, "win32");

// The parent passes its folder to the child that runs with long paths turned off.
const childRoot = process.argv[2] === "child" ? process.argv[3] : undefined;
const root =
  childRoot ??
  resolve(
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

const FILE_SYSTEM_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem";

/** Read `LongPathsEnabled` as a number; `reg query` prints `LongPathsEnabled    REG_DWORD    0x1`. */
function readLongPaths(): number | undefined {
  const query = Bun.spawnSync([
    "reg",
    "query",
    FILE_SYSTEM_KEY,
    "/v",
    "LongPathsEnabled",
  ]);
  const value = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(query.stdout.toString())?.[1];
  return query.exitCode === 0 && value !== undefined
    ? Number.parseInt(value, 16)
    : undefined;
}

/** Set `LongPathsEnabled` for processes started afterwards. Needs an elevated account. */
function setLongPaths(value: number): boolean {
  return (
    Bun.spawnSync([
      "reg",
      "add",
      FILE_SYSTEM_KEY,
      "/v",
      "LongPathsEnabled",
      "/t",
      "REG_DWORD",
      "/d",
      String(value),
      "/f",
    ]).exitCode === 0
  );
}

if (childRoot !== undefined) {
  // Child with long paths off: record what each spelling does, no assertions on the probes.
  console.log(`CHILD LongPathsEnabled=${readLongPaths()}`);
  const base = `\\\\localhost\\${childRoot.replace(":", "$")}\\child\\${deep}`;
  probe("child storage.writeText", () =>
    storage.writeText({
      path: `${base}\\a.txt`,
      text,
    }),
  );
  probe("child storage.readText", () => {
    assert.equal(storage.readText(at(`${base}\\a.txt`)), text);
  });
  probe("child raw mkdir without prefix", () =>
    mkdirSync(`${base}\\raw`, {
      recursive: true,
    }),
  );
  probe("child raw mkdir with UNC prefix", () =>
    mkdirSync(`\\\\?\\UNC\\${base.slice(2)}\\raw2`, {
      recursive: true,
    }),
  );
  storage.dispose();
  process.exit(0);
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
    // The extended prefix keeps this check exact when long paths are off for the runner.
    assert.equal(existsSync(`\\\\?\\${root}\\${top}`), false);

    // The runner turns long paths on. Turn them off for a child process to see what the spelling
    // alone provides, then restore the setting.
    // `reg query` prints `LongPathsEnabled    REG_DWORD    0x1`; no value means the setting was never written.
    const previous = readLongPaths();
    if (previous === undefined) {
      console.log("SKIP LongPathsEnabled has no readable value to restore.");
    } else if (setLongPaths(0)) {
      try {
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            import.meta.path,
            "child",
            root,
          ],
          {
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const timer = killAfter(child, "nativeFixture");
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        clearTimeout(timer);
        console.log(out.trim());
        console.log(err.trim());
        assert.equal(code, 0, "The child with long paths off must finish.");
        assert(
          out.includes("PROBE child storage.writeText"),
          "The child must report its probes.",
        );
        assert(
          out.includes("CHILD LongPathsEnabled=0"),
          "The child must run with long paths turned off.",
        );
      } finally {
        assert(
          setLongPaths(previous) && readLongPaths() === previous,
          "The LongPathsEnabled setting must be restored to its previous value.",
        );
      }
    } else {
      console.log("SKIP LongPathsEnabled cannot be changed on this runner.");
    }
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

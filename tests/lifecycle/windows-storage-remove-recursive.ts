import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { BunawayError } from "@bunaway/protocol";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";
import { deadline } from "../fixtures/deadlines.ts";

assert.equal(process.platform, "win32");

const root = resolve(
  import.meta.dir,
  `../../build/wrr-${crypto.randomUUID().slice(0, 8)}`,
);
const storage = new WindowsStorage();
const at = (path: string) => ({
  path: `${root}/${path}`,
});

async function present(path: string): Promise<boolean> {
  try {
    await stat(`${root}/${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function expectRejected(
  action: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(
    action,
    (error) => error instanceof BunawayError && error.code === code,
  );
}

/** Create a link of the given kind, or report that the runner cannot create one. */
async function tryLink(
  target: string,
  path: string,
  type: "junction" | "file" | "dir",
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

/** A folder with a file and a nested file, standing in for the data a link must not reach. */
async function seedOutside(name: string): Promise<void> {
  await mkdir(`${root}/${name}/nested`, {
    recursive: true,
  });
  await writeFile(`${root}/${name}/big.bin`, new Uint8Array(64));
  await writeFile(`${root}/${name}/nested/inner.bin`, "inner");
}

async function expectOutsideIntact(name: string): Promise<void> {
  assert.equal((await stat(`${root}/${name}/big.bin`)).size, 64);
  assert.equal(
    await readFile(`${root}/${name}/nested/inner.bin`, "utf8"),
    "inner",
  );
}

/**
 * Run a diskpart script. False when diskpart is missing, needs elevation or fails; the caller
 * decides whether that skips the scenario or, on CI, fails the run.
 */
function diskpart(script: string): boolean {
  const file = `${root}/diskpart-${crypto.randomUUID().slice(0, 8)}.txt`;
  writeFileSync(file, script);
  try {
    const result = Bun.spawnSync(
      [
        "diskpart",
        "/s",
        file,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: deadline("nativeFixture"),
      },
    );
    if (result.exitCode !== 0) {
      console.log(
        `diskpart exited with ${result.exitCode}: ${result.stdout.toString().slice(-400)}`,
      );
    }
    return result.exitCode === 0;
  } catch (error) {
    // A missing executable or a refused elevation throws instead of returning an exit code.
    console.log(`diskpart could not run: ${String(error)}`);
    return false;
  } finally {
    rmSync(file, {
      force: true,
    });
  }
}

try {
  // Nested Unicode tree, empty files and empty directories all go, the siblings stay.
  await mkdir(`${root}/tree/한글 폴더/deep/deeper`, {
    recursive: true,
  });
  await mkdir(`${root}/tree/empty`);
  await mkdir(`${root}/sibling`);
  await writeFile(`${root}/sibling/keep.txt`, "keep");
  await writeFile(`${root}/tree/a.bin`, new Uint8Array(10));
  await writeFile(`${root}/tree/한글 폴더/b.txt`, "공백 🙂");
  await writeFile(`${root}/tree/한글 폴더/deep/zero.bin`, new Uint8Array(0));
  await writeFile(`${root}/tree/한글 폴더/deep/deeper/c.bin`, "c");
  assert.equal(await storage.removeRecursive(at("tree")), null);
  assert.equal(await present("tree"), false);
  assert.equal(await readFile(`${root}/sibling/keep.txt`, "utf8"), "keep");

  // A large directory is deleted in one call.
  await mkdir(`${root}/many`);
  for (let index = 0; index < 1500; index++) {
    await writeFile(
      `${root}/many/entry-with-a-reasonably-long-name-${index}.txt`,
      "",
    );
  }
  await storage.removeRecursive(at("many"));
  assert.equal(await present("many"), false);

  // Read-only files and directories are removed, as Node and Rust do.
  await mkdir(`${root}/readonly/locked-dir`, {
    recursive: true,
  });
  await writeFile(`${root}/readonly/locked.txt`, "x");
  await writeFile(`${root}/readonly/locked-dir/inner.txt`, "y");
  await chmod(`${root}/readonly/locked.txt`, 0o444);
  await chmod(`${root}/readonly/locked-dir/inner.txt`, 0o444);
  await chmod(`${root}/readonly/locked-dir`, 0o444);
  await storage.removeRecursive(at("readonly"));
  assert.equal(await present("readonly"), false);

  // The root may be a file, including a read-only one.
  await writeFile(`${root}/single.txt`, "z");
  await chmod(`${root}/single.txt`, 0o444);
  await storage.removeRecursive(at("single.txt"));
  assert.equal(await present("single.txt"), false);

  // Hardlinks lose only their own name.
  await mkdir(`${root}/hard`);
  await mkdir(`${root}/shared`);
  await writeFile(`${root}/shared/original.txt`, "shared");
  await link(`${root}/shared/original.txt`, `${root}/hard/second-name.txt`);
  await storage.removeRecursive(at("hard"));
  assert.equal(await present("hard"), false);
  assert.equal(await readFile(`${root}/shared/original.txt`, "utf8"), "shared");

  // Links inside the tree are removed themselves and never followed, through the adapter and
  // through both Node removal APIs it could use.
  await seedOutside("outside");
  const kinds = [
    [
      "junction",
      "outside",
      "junction",
    ],
    [
      "file-link.bin",
      "outside/big.bin",
      "file",
    ],
    [
      "directory-link",
      "outside/nested",
      "dir",
    ],
  ] as const;
  const coverage: Record<string, boolean> = {};
  for (const [folder, remove] of [
    [
      "linked-adapter",
      async (path: string) => storage.removeRecursive(at(path)),
    ],
    [
      "linked-promises",
      async (path: string) =>
        rm(`${root}/${path}`, {
          recursive: true,
        }),
    ],
    [
      "linked-sync",
      async (path: string) =>
        rmSync(`${root}/${path}`, {
          recursive: true,
        }),
    ],
  ] as const) {
    await mkdir(`${root}/${folder}`);
    await writeFile(`${root}/${folder}/own.bin`, "own");
    for (const [name, target, type] of kinds) {
      coverage[`${folder}:${type}`] = await tryLink(
        target,
        `${folder}/${name}`,
        type,
      );
    }
    await remove(folder);
    assert.equal(await present(folder), false);
    await expectOutsideIntact("outside");
  }
  console.log(`Link coverage: ${JSON.stringify(coverage)}.`);

  // A link given as the root is removed itself, whatever API removes it.
  for (const [name, type] of [
    [
      "root-junction",
      "junction",
    ],
    [
      "root-directory-link",
      "dir",
    ],
  ] as const) {
    if (await tryLink("outside", name, type)) {
      await storage.removeRecursive(at(name));
      assert.equal(await present(name), false);
      await expectOutsideIntact("outside");
      await tryLink("outside", name, type);
      await rm(`${root}/${name}`, {
        recursive: true,
      });
      assert.equal(await present(name), false);
      await expectOutsideIntact("outside");
    }
  }

  // A volume mount point inside the tree is removed itself and the mounted volume keeps its files.
  // The volume is also mounted outside the tree up front, so the survival check reads it through
  // that second mount point and needs no further diskpart call.
  const disk = `${root}/mounted.vhd`.replaceAll("/", "\\");
  const mountFolder = `${root}/mount-tree/volume`.replaceAll("/", "\\");
  const verifyFolder = `${root}/verify`.replaceAll("/", "\\");
  await mkdir(`${root}/mount-tree/volume`, {
    recursive: true,
  });
  await mkdir(verifyFolder);
  await writeFile(`${root}/mount-tree/own.bin`, "own");
  let mountCovered = false;
  try {
    mountCovered = diskpart(
      [
        `create vdisk file="${disk}" maximum=64 type=expandable`,
        `select vdisk file="${disk}"`,
        "attach vdisk",
        "create partition primary",
        "format fs=ntfs quick label=bunaway",
        `assign mount="${mountFolder}"`,
        `assign mount="${verifyFolder}"`,
      ].join("\r\n"),
    );
    if (mountCovered) {
      await writeFile(`${mountFolder}/on-volume.bin`, "volume data");
      await mkdir(`${mountFolder}/nested`);
      await writeFile(`${mountFolder}/nested/deep.bin`, "deep");
      await storage.removeRecursive(at("mount-tree"));
      assert.equal(await present("mount-tree"), false);
      assert.equal(
        await readFile(`${verifyFolder}/on-volume.bin`, "utf8"),
        "volume data",
      );
      assert.equal(
        await readFile(`${verifyFolder}/nested/deep.bin`, "utf8"),
        "deep",
      );
    } else if (process.env.CI) {
      assert.fail("The CI runner must be able to mount a virtual disk.");
    } else {
      console.log("SKIP volume mount point: diskpart is not usable here.");
    }
  } finally {
    // The disk file exists once creation started, so detach even when a later step failed.
    if (existsSync(disk)) {
      // Drop the mount points first; a mount folder left behind would point at a volume that is
      // gone once the disk is detached. A folder that was never mounted just reports an error.
      for (const folder of [
        mountFolder,
        verifyFolder,
      ]) {
        Bun.spawnSync(
          [
            "mountvol",
            folder,
            "/D",
          ],
          {
            stdout: "ignore",
            stderr: "ignore",
            timeout: deadline("childStep"),
          },
        );
      }
      if (
        !diskpart(
          [
            `select vdisk file="${disk}"`,
            "detach vdisk",
          ].join("\r\n"),
        )
      ) {
        console.log(`The virtual disk ${disk} could not be detached.`);
      }
    }
  }

  // A signal that is already aborted deletes nothing; cancellation after the start has no effect.
  await mkdir(`${root}/wide`);
  await writeFile(`${root}/wide/file.bin`, new Uint8Array(1));
  const cancelled = new AbortController();
  cancelled.abort();
  await expectRejected(
    storage.removeRecursive(at("wide"), cancelled.signal),
    "CANCELLED",
  );
  assert.equal(await present("wide/file.bin"), true);
  const running = new AbortController();
  const removal = storage.removeRecursive(at("wide"), running.signal);
  running.abort();
  await removal;
  assert.equal(await present("wide"), false);

  // A disposed adapter refuses work.
  const disposable = new WindowsStorage();
  disposable.dispose();
  await expectRejected(disposable.removeRecursive(at("sibling")), "CANCELLED");

  // Missing targets and missing parents are rejected, not ignored.
  await expectRejected(
    storage.removeRecursive(at("absent")),
    "INVALID_ARGUMENT",
  );
  await expectRejected(
    storage.removeRecursive(at("absent/child")),
    "INVALID_ARGUMENT",
  );
} finally {
  storage.dispose();
  await rm(root, {
    recursive: true,
    force: true,
  });
}
console.log(
  "PASS Windows storage removeRecursive: nested and large trees, read-only entries, hardlinks, links inside and at the root through the adapter and both Node removal APIs, a volume mount point inside the tree when diskpart is usable, cancellation before the start and target errors",
);

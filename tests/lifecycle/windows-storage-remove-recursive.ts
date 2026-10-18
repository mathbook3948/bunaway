import assert from "node:assert/strict";
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
import { MAX_DIRECTORY_SIZE_DEPTH } from "#plugins/storage/src/contract";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";

assert.equal(process.platform, "win32");

const root = resolve(
  import.meta.dir,
  // A short name leaves room for MAX_DIRECTORY_SIZE_DEPTH nested levels within MAX_PATH.
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

  // A directory larger than one native listing batch is deleted while it is still being listed.
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

  // A read-only hardlink keeps the read-only attribute of its other names.
  await mkdir(`${root}/ro-hard`);
  await writeFile(`${root}/shared/protected.txt`, "protected");
  await chmod(`${root}/shared/protected.txt`, 0o444);
  await link(`${root}/shared/protected.txt`, `${root}/ro-hard/name.txt`);
  await storage.removeRecursive(at("ro-hard"));
  assert.equal(await present("ro-hard"), false);
  assert.equal((await stat(`${root}/shared/protected.txt`)).mode & 0o200, 0);
  await chmod(`${root}/shared/protected.txt`, 0o666);

  // Links are removed themselves and never followed.
  await mkdir(`${root}/outside/nested`, {
    recursive: true,
  });
  await writeFile(`${root}/outside/big.bin`, new Uint8Array(64));
  await writeFile(`${root}/outside/nested/inner.bin`, "inner");
  await mkdir(`${root}/linked`);
  await writeFile(`${root}/linked/own.bin`, "own");
  const junction = await tryLink("outside", "linked/junction", "junction");
  const fileLink = await tryLink(
    "outside/big.bin",
    "linked/file-link.bin",
    "file",
  );
  const directoryLink = await tryLink(
    "outside/nested",
    "linked/directory-link",
    "dir",
  );
  await storage.removeRecursive(at("linked"));
  assert.equal(await present("linked"), false);
  assert.equal((await stat(`${root}/outside/big.bin`)).size, 64);
  assert.equal(
    await readFile(`${root}/outside/nested/inner.bin`, "utf8"),
    "inner",
  );
  console.log(
    `Link coverage: junction=${junction}, file symlink=${fileLink}, directory link=${directoryLink}.`,
  );
  if (junction) {
    // A link given as the root is rejected like every other storage target.
    await tryLink("outside", "root-junction", "junction");
    await expectRejected(
      storage.removeRecursive(at("root-junction")),
      "PERMISSION_DENIED",
    );
    assert.equal((await stat(`${root}/outside/big.bin`)).size, 64);
    await rm(`${root}/root-junction`);
  }

  // The default depth admits exactly MAX_DIRECTORY_SIZE_DEPTH levels below the root.
  const levels = Array.from(
    {
      length: MAX_DIRECTORY_SIZE_DEPTH,
    },
    () => "d",
  );
  await mkdir(`${root}/fits/${levels.join("/")}`, {
    recursive: true,
  });
  await storage.removeRecursive(at("fits"));
  assert.equal(await present("fits"), false);
  await mkdir(
    `${root}/nest/${[
      ...levels,
      "d",
    ].join("/")}`,
    {
      recursive: true,
    },
  );
  await expectRejected(storage.removeRecursive(at("nest")), "INVALID_ARGUMENT");
  assert.equal(await present("nest"), true);

  // A signal that is already aborted deletes nothing.
  await mkdir(`${root}/wide`);
  for (let index = 0; index < 40; index++) {
    await mkdir(`${root}/wide/dir-${index}`);
    await writeFile(`${root}/wide/dir-${index}/file.bin`, new Uint8Array(1));
  }
  const cancelled = new AbortController();
  cancelled.abort();
  await expectRejected(
    storage.removeRecursive(at("wide"), cancelled.signal),
    "CANCELLED",
  );
  assert.equal(await present("wide/dir-0/file.bin"), true);

  // Cancelling after the walk started stops it with handles released, and a second call finishes.
  const running = new AbortController();
  const walk = storage.removeRecursive(at("wide"), running.signal);
  running.abort();
  await expectRejected(walk, "CANCELLED");
  await storage.removeRecursive(at("wide"));
  assert.equal(await present("wide"), false);

  // Disposal during the walk cancels it and still closes the handles with live bindings.
  await mkdir(`${root}/disposing`);
  for (let index = 0; index < 40; index++) {
    await mkdir(`${root}/disposing/dir-${index}`);
    await writeFile(
      `${root}/disposing/dir-${index}/file.bin`,
      new Uint8Array(1),
    );
  }
  const disposable = new WindowsStorage();
  const disposing = disposable.removeRecursive(at("disposing"));
  const disposed = disposable.dispose();
  await expectRejected(disposing, "CANCELLED");
  await disposed;
  await storage.removeRecursive(at("disposing"));
  assert.equal(await present("disposing"), false);
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
  await storage.dispose();
  // Removal succeeding also shows that every failed or cancelled walk released its handles.
  await rm(root, {
    recursive: true,
    force: true,
  });
}
console.log(
  "PASS Windows storage removeRecursive: nested and batched trees, read-only entries, hardlinks, links, depth limit, cancellation and disposal during the walk, target errors and handle release",
);

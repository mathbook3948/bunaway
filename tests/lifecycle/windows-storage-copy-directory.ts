import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
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

assert.equal(process.platform, "win32");

const root = resolve(
  import.meta.dir,
  `../../build/wcd-${crypto.randomUUID().slice(0, 8)}`,
);
const storage = new WindowsStorage();
const path = (name: string) => `${root}/${name}`;
const transfer = (from: string, to: string) => ({
  from: path(from),
  to: path(to),
});

async function expectRejected(
  action: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(
    action,
    (error) => error instanceof BunawayError && error.code === code,
  );
}

/** Create a junction, or report that the runner cannot create one. */
async function tryJunction(target: string, name: string): Promise<boolean> {
  try {
    await symlink(path(target), path(name), "junction");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      console.log("SKIP junction creation is not permitted on this runner.");
      return false;
    }
    throw error;
  }
}

try {
  await mkdir(path("src/한글 폴더/deep"), {
    recursive: true,
  });
  await mkdir(path("src/empty"));
  const bytes = Buffer.from([
    0,
    255,
    128,
    13,
    10,
    0,
  ]);
  await writeFile(path("src/a.txt"), "alpha");
  await writeFile(path("src/한글 폴더/b.bin"), bytes);
  await writeFile(path("src/한글 폴더/deep/zero"), "");

  // A nested tree is copied with its empty directories, empty files and exact bytes.
  assert.deepEqual(await storage.copyDirectory(transfer("src", "dst")), {
    bytes: 11,
    files: 3,
    directories: 3,
  });
  assert.equal(await readFile(path("dst/a.txt"), "utf8"), "alpha");
  assert.deepEqual(await readFile(path("dst/한글 폴더/b.bin")), bytes);
  assert.equal((await stat(path("dst/한글 폴더/deep/zero"))).size, 0);
  assert.equal((await stat(path("dst/empty"))).isDirectory(), true);
  assert.equal(await readFile(path("src/a.txt"), "utf8"), "alpha");

  // An existing destination is neither merged into nor replaced, and the source stays.
  await expectRejected(
    storage.copyDirectory(transfer("src", "dst")),
    "INVALID_ARGUMENT",
  );
  await expectRejected(
    storage.copyDirectory(transfer("src", "src/a.txt")),
    "INVALID_ARGUMENT",
  );
  await expectRejected(
    storage.copyDirectory(transfer("src", "missing-parent/dst")),
    "INVALID_ARGUMENT",
  );
  await expectRejected(
    storage.copyDirectory(transfer("src/a.txt", "from-file")),
    "INVALID_ARGUMENT",
  );

  // A destination inside the source is refused by name, including a different letter case.
  await expectRejected(
    storage.copyDirectory(transfer("src", "src/inside")),
    "INVALID_ARGUMENT",
  );
  await expectRejected(
    storage.copyDirectory({
      from: path("src"),
      to: path("SRC/inside"),
    }),
    "INVALID_ARGUMENT",
  );
  assert.equal(existsSync(path("src/inside")), false);

  if (await tryJunction("src", "alias")) {
    // A junction that places the destination inside the source is found by file identity.
    await expectRejected(
      storage.copyDirectory(transfer("src", "alias/viaLink")),
      "INVALID_ARGUMENT",
    );
    // A junction given as the root is followed.
    assert.deepEqual(
      await storage.copyDirectory(transfer("alias", "fromAlias")),
      {
        bytes: 11,
        files: 3,
        directories: 3,
      },
    );
    // A junction below the root fails the copy and its target is neither copied nor changed.
    await mkdir(path("outside"));
    await writeFile(path("outside/secret.txt"), "secret");
    await mkdir(path("withLink"));
    await writeFile(path("withLink/a.txt"), "a");
    assert.equal(await tryJunction("outside", "withLink/ln"), true);
    await expectRejected(
      storage.copyDirectory(transfer("withLink", "linkCopy")),
      "INVALID_ARGUMENT",
    );
    assert.equal(existsSync(path("linkCopy/ln")), false);
    assert.equal(await readFile(path("outside/secret.txt"), "utf8"), "secret");
  }

  // A cancelled call copies nothing.
  const cancelled = new AbortController();
  cancelled.abort();
  await expectRejected(
    storage.copyDirectory(transfer("src", "never"), cancelled.signal),
    "CANCELLED",
  );
  assert.equal(existsSync(path("never")), false);

  // Disposal ends the copy for any later call.
  storage.dispose();
  await expectRejected(
    storage.copyDirectory(transfer("src", "afterDispose")),
    "CANCELLED",
  );
} finally {
  storage.dispose();
  await rm(root, {
    recursive: true,
    force: true,
  });
}
console.log(
  "PASS Windows storage copyDirectory: nested Unicode tree, exact bytes, no merge or replace, destination inside the source by name and by junction, links below the root, cancellation and disposal",
);

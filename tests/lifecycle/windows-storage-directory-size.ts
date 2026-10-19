import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BunawayError } from "@bunaway/protocol";
import {
  MAX_DIRECTORY_SIZE_DEPTH,
  MAX_DIRECTORY_SIZE_ENTRIES,
} from "#plugins/storage/src/contract";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";

assert.equal(process.platform, "win32");

const root = resolve(
  import.meta.dir,
  // A short name leaves room for MAX_DIRECTORY_SIZE_DEPTH nested levels within MAX_PATH.
  `../../build/wds-${crypto.randomUUID().slice(0, 8)}`,
);
const storage = new WindowsStorage();
const at = (path: string) => ({
  path: `${root}/${path}`,
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

/** Create a link of the given kind, or report that the runner cannot create one. */
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
  await mkdir(`${root}/empty`, {
    recursive: true,
  });
  assert.deepEqual(await storage.directorySize(at("empty")), {
    bytes: 0,
    files: 0,
    directories: 0,
  });

  // Nested totals: the root is not counted as a directory and empty files add no bytes.
  await mkdir(`${root}/tree/한글 폴더/deep/deeper`, {
    recursive: true,
  });
  await writeFile(`${root}/tree/a.bin`, new Uint8Array(10));
  await writeFile(`${root}/tree/한글 폴더/b.txt`, "공백 🙂");
  await writeFile(`${root}/tree/한글 폴더/deep/zero.bin`, new Uint8Array(0));
  await writeFile(
    `${root}/tree/한글 폴더/deep/deeper/c.bin`,
    new Uint8Array(100),
  );
  const expectedBytes = 10 + Buffer.byteLength("공백 🙂") + 100;
  assert.deepEqual(await storage.directorySize(at("tree")), {
    bytes: expectedBytes,
    files: 4,
    directories: 3,
  });
  // A subdirectory is its own root.
  assert.deepEqual(await storage.directorySize(at("tree/한글 폴더/deep")), {
    bytes: 100,
    files: 2,
    directories: 1,
  });

  // Hardlinks add their size once per name.
  await mkdir(`${root}/hard`, {
    recursive: true,
  });
  await writeFile(`${root}/hard/original.bin`, new Uint8Array(30));
  await link(`${root}/hard/original.bin`, `${root}/hard/second-name.bin`);
  assert.deepEqual(await storage.directorySize(at("hard")), {
    bytes: 60,
    files: 2,
    directories: 0,
  });

  // Links are neither followed nor counted, even when their target is large.
  await mkdir(`${root}/outside`, {
    recursive: true,
  });
  await writeFile(`${root}/outside/big.bin`, new Uint8Array(4096));
  await mkdir(`${root}/linked`, {
    recursive: true,
  });
  await writeFile(`${root}/linked/own.bin`, new Uint8Array(5));
  const junction = await tryLink("outside", "linked/junction", "junction");
  const fileLink = await tryLink(
    "outside/big.bin",
    "linked/file-link.bin",
    "file",
  );
  assert.deepEqual(await storage.directorySize(at("linked")), {
    bytes: 5,
    files: 1,
    directories: 0,
  });
  console.log(`Link coverage: junction=${junction}, file symlink=${fileLink}.`);

  // Limits fail the whole operation; the injected values keep the fixture small.
  await expectRejected(
    storage.directorySizeWithin(at("tree"), undefined, {
      entries: 4,
      depth: MAX_DIRECTORY_SIZE_DEPTH,
    }),
    "INVALID_ARGUMENT",
  );
  await expectRejected(
    storage.directorySizeWithin(at("tree"), undefined, {
      entries: MAX_DIRECTORY_SIZE_ENTRIES,
      depth: 2,
    }),
    "INVALID_ARGUMENT",
  );
  assert.deepEqual(
    await storage.directorySizeWithin(at("tree"), undefined, {
      entries: 7,
      depth: 3,
    }),
    {
      bytes: expectedBytes,
      files: 4,
      directories: 3,
    },
  );

  // The default depth admits exactly MAX_DIRECTORY_SIZE_DEPTH levels below the root.
  const levels = Array.from(
    {
      length: MAX_DIRECTORY_SIZE_DEPTH + 1,
    },
    () => "d",
  );
  await mkdir(`${root}/nest/${levels.join("/")}`, {
    recursive: true,
  });
  await expectRejected(storage.directorySize(at("nest")), "INVALID_ARGUMENT");
  assert.deepEqual(await storage.directorySize(at(`nest/${levels[0]}`)), {
    bytes: 0,
    files: 0,
    directories: MAX_DIRECTORY_SIZE_DEPTH,
  });

  // A signal that is already aborted stops the scan before any entry is read.
  const cancelled = new AbortController();
  cancelled.abort();
  await expectRejected(
    storage.directorySize(at("tree"), cancelled.signal),
    "CANCELLED",
  );

  // Cancelling after the scan started: the first yield happens after 32 walk steps, and this
  // tree needs more than that, so the abort lands while directories are open.
  await mkdir(`${root}/wide`, {
    recursive: true,
  });
  for (let index = 0; index < 40; index++) {
    await mkdir(`${root}/wide/dir-${index}`);
    await writeFile(`${root}/wide/dir-${index}/file.bin`, new Uint8Array(1));
  }
  const running = new AbortController();
  const scan = storage.directorySize(at("wide"), running.signal);
  running.abort();
  await expectRejected(scan, "CANCELLED");

  // Disposal during the scan cancels it.
  const disposable = new WindowsStorage();
  const disposing = disposable.directorySize(at("wide"));
  disposable.dispose();
  await expectRejected(disposing, "CANCELLED");
  await expectRejected(disposable.directorySize(at("tree")), "CANCELLED");

  // An unreadable subdirectory fails the whole scan instead of under-counting.
  await mkdir(`${root}/acl/open`, {
    recursive: true,
  });
  await mkdir(`${root}/acl/locked`, {
    recursive: true,
  });
  await writeFile(`${root}/acl/open/file.bin`, new Uint8Array(3));
  const lockedPath = resolve(root, "acl/locked");
  const everyone = "*S-1-1-0";
  let denied = false;
  try {
    execFileSync("icacls", [
      lockedPath,
      "/deny",
      `${everyone}:(RD)`,
    ]);
    denied = true;
  } catch {
    console.log("SKIP icacls cannot set a deny ACE on this runner.");
  }
  try {
    if (denied) {
      await expectRejected(
        storage.directorySize(at("acl")),
        "PERMISSION_DENIED",
      );
    }
  } finally {
    if (denied) {
      // Always lift the ACE so the temporary tree can be removed.
      execFileSync("icacls", [
        lockedPath,
        "/remove:d",
        everyone,
      ]);
    }
  }

  // A file, a missing directory and a missing parent are rejected, not totalled.
  await expectRejected(
    storage.directorySize(at("tree/a.bin")),
    "INVALID_ARGUMENT",
  );
  await expectRejected(storage.directorySize(at("absent")), "INVALID_ARGUMENT");
  await expectRejected(
    storage.directorySize(at("absent/child")),
    "INVALID_ARGUMENT",
  );
  if (junction) {
    // A link given as the root is followed like any other path.
    assert.deepEqual(await storage.directorySize(at("linked/junction")), {
      bytes: 4096,
      files: 1,
      directories: 0,
    });
  }
} finally {
  storage.dispose();
  await rm(root, {
    recursive: true,
    force: true,
  });
}
console.log(
  "PASS Windows storage directorySize: totals, hardlinks, links, limits, cancellation and disposal during the scan, denied subdirectory and target errors",
);

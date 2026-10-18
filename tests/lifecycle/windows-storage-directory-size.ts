import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
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

function expectError(action: () => unknown, code: string): void {
  assert.throws(
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
  assert.deepEqual(storage.directorySize(at("empty")), {
    bytes: 0,
    files: 0,
    directories: 0,
  });

  // Nested totals: the root is not a directory, hardlinks add per name, empty files add nothing.
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
  assert.deepEqual(storage.directorySize(at("tree")), {
    bytes: expectedBytes,
    files: 4,
    directories: 3,
  });
  // A subdirectory is its own root.
  assert.deepEqual(storage.directorySize(at("tree/한글 폴더/deep")), {
    bytes: 100,
    files: 2,
    directories: 1,
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
  assert.deepEqual(storage.directorySize(at("linked")), {
    bytes: 5,
    files: 1,
    directories: 0,
  });
  console.log(`Link coverage: junction=${junction}, file symlink=${fileLink}.`);

  // Limits fail the whole operation; the injected values keep the fixture small.
  expectError(
    () =>
      storage.directorySize(at("tree"), undefined, {
        entries: 4,
        depth: MAX_DIRECTORY_SIZE_DEPTH,
      }),
    "INVALID_ARGUMENT",
  );
  expectError(
    () =>
      storage.directorySize(at("tree"), undefined, {
        entries: MAX_DIRECTORY_SIZE_ENTRIES,
        depth: 2,
      }),
    "INVALID_ARGUMENT",
  );
  assert.deepEqual(
    storage.directorySize(at("tree"), undefined, {
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
  expectError(() => storage.directorySize(at("nest")), "INVALID_ARGUMENT");
  assert.deepEqual(storage.directorySize(at(`nest/${levels[0]}`)), {
    bytes: 0,
    files: 0,
    directories: MAX_DIRECTORY_SIZE_DEPTH,
  });

  // Cancellation is checked before any entry is read.
  const cancelled = new AbortController();
  cancelled.abort();
  expectError(
    () => storage.directorySize(at("tree"), cancelled.signal),
    "CANCELLED",
  );

  // A file, a missing directory and a missing parent are rejected, not totalled.
  expectError(
    () => storage.directorySize(at("tree/a.bin")),
    "INVALID_ARGUMENT",
  );
  expectError(() => storage.directorySize(at("absent")), "INVALID_ARGUMENT");
  expectError(
    () => storage.directorySize(at("absent/child")),
    "INVALID_ARGUMENT",
  );
  if (junction) {
    // A link given as the root is rejected like every other storage target.
    expectError(
      () => storage.directorySize(at("linked/junction")),
      "PERMISSION_DENIED",
    );
  }
} finally {
  storage.dispose();
  // Removal succeeding also shows that every failed or cancelled scan released its handles.
  await rm(root, {
    recursive: true,
    force: true,
  });
}
console.log(
  "PASS Windows storage directorySize: totals, links, limits, cancellation, target errors and handle release",
);

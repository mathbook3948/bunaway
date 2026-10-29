import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BunawayError } from "@bunaway/protocol";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";
import { waitFor } from "../fixtures/deadlines.ts";

assert.equal(process.platform, "win32");

const root = resolve(
  import.meta.dir,
  `../../build/wrl-${crypto.randomUUID().slice(0, 8)}`,
);
const storage = new WindowsStorage();
const at = (path: string) => ({
  path: `${root}/${path}`,
});

/** The codes the contract allows for a file another process holds open without delete sharing. */
const LOCK_CODES = [
  "BUSY",
  "PERMISSION_DENIED",
];

/** A child process that keeps one file open with the given share mode until it is stopped. */
type Holder = {
  stop(): Promise<void>;
};

/**
 * Open `file` in a child PowerShell with `share` as the FileShare mode, and return once the child
 * has the handle. The marker lives outside the tree under test so it never takes part in a removal.
 */
async function holdOpen(
  file: string,
  share: "Read" | "ReadWrite, Delete",
  markerName: string,
): Promise<Holder> {
  const marker = `${root}/${markerName}`;
  const holder = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-Command",
      `$f=[IO.File]::Open('${file}','Open','Read','${share}');[IO.File]::WriteAllText('${marker}','1');Start-Sleep -Seconds 120`,
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const stop = async () => {
    holder.kill();
    await holder.exited;
  };
  try {
    await waitFor(() => existsSync(marker), {
      deadline: "childStep",
      what: "the lock holder to open the file",
      failed: () =>
        holder.exitCode === null
          ? undefined
          : new Error(`The lock holder exited with ${holder.exitCode}.`),
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    stop,
  };
}

/** The error a rejected call carries, so a call that unexpectedly succeeds fails the test. */
async function rejection(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("The call was expected to fail but it succeeded.");
}

function assertLockFailure(error: unknown): void {
  assert.ok(
    error instanceof BunawayError && LOCK_CODES.includes(error.code),
    `A locked file must fail with ${LOCK_CODES.join(" or ")}: ${String(error)}`,
  );
}

/** Retry until the OS has released a handle that was just closed (a scanner may still hold it). */
async function removeRecursiveWhenReleased(path: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        await storage.removeRecursive(at(path));
        return true;
      } catch (error) {
        assertLockFailure(error);
        return false;
      }
    },
    {
      deadline: "childStep",
      what: `${path} to be removable after the handle closed`,
    },
  );
}

async function seedTree(): Promise<void> {
  await mkdir(`${root}/tree/locked-dir/inner`, {
    recursive: true,
  });
  await mkdir(`${root}/tree/other`);
  await writeFile(`${root}/tree/locked-dir/locked.txt`, "locked content");
  await writeFile(`${root}/tree/locked-dir/inner/free.txt`, "free");
  await writeFile(`${root}/tree/other/free.txt`, "free");
  await writeFile(`${root}/tree/top.txt`, "top");
}

await mkdir(root, {
  recursive: true,
});
let holder: Holder | undefined;
try {
  // A file held without delete sharing: removeRecursive reports the failure instead of success,
  // and the held file and every directory above it remain. Which free siblings are already gone
  // depends on the traversal order, so it is recorded and not asserted.
  await seedTree();
  holder = await holdOpen(
    `${root}/tree/locked-dir/locked.txt`,
    "Read",
    "locked.ready",
  );
  assertLockFailure(await rejection(() => storage.removeRecursive(at("tree"))));
  assert.equal(
    await readFile(`${root}/tree/locked-dir/locked.txt`, "utf8"),
    "locked content",
  );
  console.log(
    `INFO partial removal: top.txt remained = ${existsSync(`${root}/tree/top.txt`)}, other/free.txt remained = ${existsSync(`${root}/tree/other/free.txt`)}, inner/free.txt remained = ${existsSync(`${root}/tree/locked-dir/inner/free.txt`)}`,
  );

  // remove on the held file fails the same way and leaves it whole.
  assertLockFailure(
    await rejection(() => storage.remove(at("tree/locked-dir/locked.txt"))),
  );
  assert.equal(
    await readFile(`${root}/tree/locked-dir/locked.txt`, "utf8"),
    "locked content",
  );

  // The same call succeeds once the holder closes its handle, and the whole tree is gone.
  await holder.stop();
  holder = undefined;
  await removeRecursiveWhenReleased("tree");
  assert.equal(existsSync(`${root}/tree`), false);

  // A file held with delete sharing can be marked for deletion, but its name stays until the
  // handle closes. The call must then fail or leave nothing behind, never report success with
  // the directory still present.
  await seedTree();
  holder = await holdOpen(
    `${root}/tree/locked-dir/locked.txt`,
    "ReadWrite, Delete",
    "pending.ready",
  );
  let pendingOutcome: string;
  try {
    await storage.removeRecursive(at("tree"));
    pendingOutcome = "resolved";
    assert.equal(
      existsSync(`${root}/tree`),
      false,
      "removeRecursive reported success while the tree was still present.",
    );
  } catch (error) {
    if (error instanceof assert.AssertionError) {
      throw error;
    }
    pendingOutcome = `rejected ${error instanceof BunawayError ? error.code : String(error)}`;
    assert.ok(error instanceof BunawayError, String(error));
  }
  console.log(`INFO delete-pending tree: ${pendingOutcome}`);
  await holder.stop();
  holder = undefined;
  if (existsSync(`${root}/tree`)) {
    await removeRecursiveWhenReleased("tree");
  }
  assert.equal(existsSync(`${root}/tree`), false);
} finally {
  await holder?.stop();
  storage.dispose();
  await rm(root, {
    recursive: true,
    force: true,
  });
}
console.log(
  "PASS Windows storage remove of a locked file: removeRecursive and remove fail with BUSY or PERMISSION_DENIED while another process holds a file without delete sharing, the held file stays, the same call succeeds after the handle closes, and a delete-pending name never produces a false success",
);

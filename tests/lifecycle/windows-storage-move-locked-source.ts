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
  `../../build/wml-${crypto.randomUUID().slice(0, 8)}`,
);
const storage = new WindowsStorage();
const move = (from: string, to: string) =>
  storage.move({
    from: `${root}/${from}`,
    to: `${root}/${to}`,
  });

/** A source another process holds open without delete sharing is an OS access denial. */
const LOCK_CODE = "PERMISSION_DENIED";

/** A child process that keeps one file open without delete sharing until it is stopped. */
type Holder = {
  stop(): Promise<void>;
};

/**
 * Open `file` in a child PowerShell with `FileShare.Read` (no delete sharing), and return once the
 * child has the handle. The marker lives outside the paths under test so it never takes part in a
 * move.
 */
async function holdOpen(file: string, markerName: string): Promise<Holder> {
  const marker = `${root}/${markerName}`;
  const holder = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-Command",
      `$f=[IO.File]::Open('${root}/${file}','Open','Read','Read');[IO.File]::WriteAllText('${marker}','1');Start-Sleep -Seconds 3600`,
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

function isLockFailure(error: unknown): boolean {
  return error instanceof BunawayError && error.code === LOCK_CODE;
}

/** The error a call throws, so a call that unexpectedly succeeds fails the test. */
function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("The call was expected to fail but it succeeded.");
}

function assertLockFailure(error: unknown): void {
  assert.ok(
    isLockFailure(error),
    `A locked source must fail with ${LOCK_CODE}: ${String(error)}`,
  );
}

/** Retry until the OS has released a handle that was just closed (a scanner may still hold it). */
async function moveWhenReleased(from: string, to: string): Promise<void> {
  await waitFor(
    () => {
      try {
        move(from, to);
        return true;
      } catch (error) {
        assertLockFailure(error);
        return false;
      }
    },
    {
      deadline: "childStep",
      what: `${from} to be movable after the handle closed`,
    },
  );
}

await mkdir(`${root}/dir/inner`, {
  recursive: true,
});
await mkdir(`${root}/free-dir`);
await writeFile(`${root}/locked.txt`, "locked content");
await writeFile(`${root}/dir/locked.txt`, "dir locked content");
await writeFile(`${root}/dir/inner/free.txt`, "free");
await writeFile(`${root}/free-dir/free.txt`, "free sibling");
let holder: Holder | undefined;
try {
  // A file held without delete sharing: the rename fails instead of reporting success, the
  // source keeps its name and content, and nothing appears at the destination.
  holder = await holdOpen("locked.txt", "file.ready");
  assertLockFailure(thrown(() => move("locked.txt", "moved.txt")));
  assert.equal(await readFile(`${root}/locked.txt`, "utf8"), "locked content");
  assert.equal(existsSync(`${root}/moved.txt`), false);

  // The same call succeeds once the holder closes its handle.
  await holder.stop();
  holder = undefined;
  await moveWhenReleased("locked.txt", "moved.txt");
  assert.equal(existsSync(`${root}/locked.txt`), false);
  assert.equal(await readFile(`${root}/moved.txt`, "utf8"), "locked content");

  // A directory with a held file inside is refused the same way: the directory stays whole and
  // nothing appears at the destination.
  holder = await holdOpen("dir/locked.txt", "dir.ready");
  assertLockFailure(thrown(() => move("dir", "moved-dir")));
  assert.equal(
    await readFile(`${root}/dir/locked.txt`, "utf8"),
    "dir locked content",
  );
  assert.equal(await readFile(`${root}/dir/inner/free.txt`, "utf8"), "free");
  assert.equal(existsSync(`${root}/moved-dir`), false);

  // A directory without any held handle is not affected while the holder is still running.
  assert.equal(move("free-dir", "moved-free-dir"), null);
  assert.equal(existsSync(`${root}/free-dir`), false);
  assert.equal(
    await readFile(`${root}/moved-free-dir/free.txt`, "utf8"),
    "free sibling",
  );

  // After the holder closes, the directory moves whole.
  await holder.stop();
  holder = undefined;
  await moveWhenReleased("dir", "moved-dir");
  assert.equal(existsSync(`${root}/dir`), false);
  assert.equal(
    await readFile(`${root}/moved-dir/locked.txt`, "utf8"),
    "dir locked content",
  );
  assert.equal(
    await readFile(`${root}/moved-dir/inner/free.txt`, "utf8"),
    "free",
  );
} finally {
  try {
    await holder?.stop();
  } finally {
    storage.dispose();
    // A scanner may still hold a file that was just released, so the folder removal retries.
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
console.log(
  "PASS Windows storage move of a locked source: a same-volume move of the file or of a directory holding it fails with PERMISSION_DENIED while another process holds the file without delete sharing, the source stays whole with nothing at the destination, an unheld sibling directory moves, and the same call succeeds after the handle closes",
);

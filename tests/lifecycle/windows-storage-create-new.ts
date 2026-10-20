import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BunawayError } from "@bunaway/plugin";
import { KERNEL32, pick, withWide } from "@bunaway/plugin/win32";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";

assert.equal(process.platform, "win32");

const CHILD_MODE = "child";
const COPIERS = 6;
const ROUNDS = 5;
const SOURCE_BYTES = 4 * 1024 * 1024;
// Children start Bun and bind kernel32 first, so the shared start time leaves room for the slowest.
const START_DELAY_MS = 4000;

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const DELETE_ACCESS = 0x10000;
const SHARE_ALL = 0x7;
const CREATE_NEW = 1;
const OPEN_EXISTING = 3;
const FILE_FLAG_DELETE_ON_CLOSE = 0x04000000;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;

/** One copier: wait for the shared start time, then copy once and report the outcome as a JSON line. */
function runCopier(from: string, to: string, startAtMs: number): void {
  const storage = new WindowsStorage();
  while (Date.now() < startAtMs) {
    // Spin so that every copier reaches the exclusive create within a few milliseconds.
  }
  let outcome: Record<string, string>;
  try {
    storage.copyFile({
      from,
      to,
    });
    outcome = {
      result: "ok",
    };
  } catch (error) {
    outcome =
      error instanceof BunawayError
        ? {
            result: "error",
            code: error.code,
            message: error.message,
          }
        : {
            result: "raw",
            message: String(error),
          };
  }
  console.log(JSON.stringify(outcome));
  storage.dispose();
}

const [, , mode = "", childFrom = "", childTo = "", childStart = "0"] =
  process.argv;
if (mode === CHILD_MODE) {
  runCopier(childFrom, childTo, Number(childStart));
  process.exit(0);
}

const root = resolve(
  import.meta.dir,
  `../../build/wcn-${crypto.randomUUID().slice(0, 8)}`,
);

type Outcome = {
  result: string;
  code?: string;
  message?: string;
};

async function race(round: number): Promise<void> {
  const target = `${root}\\target-${round}.bin`;
  const sources = Array.from(
    {
      length: COPIERS,
    },
    (_, index) => {
      const path = `${root}\\source-${round}-${index}.bin`;
      // A different fill byte per source makes a mixture of two copies visible.
      writeFileSync(path, Buffer.alloc(SOURCE_BYTES, index + 1));
      return path;
    },
  );
  const startAtMs = Date.now() + START_DELAY_MS;
  const children = sources.map((source) =>
    Bun.spawn(
      [
        process.execPath,
        import.meta.path,
        CHILD_MODE,
        source,
        target,
        String(startAtMs),
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    ),
  );
  const outcomes: Outcome[] = [];
  for (const child of children) {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, `copier failed: ${err}`);
    outcomes.push(JSON.parse(out.trim().split("\n").at(-1) ?? "{}"));
  }

  // Exactly one copier creates the name; every other one is refused as an existing destination.
  const winners = outcomes.flatMap((outcome, index) =>
    outcome.result === "ok"
      ? [
          index,
        ]
      : [],
  );
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  for (const [index, outcome] of outcomes.entries()) {
    if (index !== winners[0]) {
      assert.deepEqual(
        [
          outcome.result,
          outcome.code,
          outcome.message,
        ],
        [
          "error",
          "INVALID_ARGUMENT",
          "Storage destination already exists.",
        ],
        JSON.stringify(outcomes),
      );
    }
  }
  // The file holds the winner's bytes only; later attempts never write into it.
  const copied = await readFile(target);
  const winningSource = sources[winners[0] ?? -1];
  assert(winningSource !== undefined, "The winner must be one of the sources.");
  const original = await readFile(winningSource);
  assert(copied.equals(original), "The target must equal the winning source.");
}

/**
 * Make `path` delete-pending: it is deleted while another handle stays open, so the name still
 * exists but no new file can take it. Returns the handle that keeps it pending.
 */
function holdDeletePending(path: string): bigint {
  const api = dlopen(
    "kernel32.dll",
    pick(KERNEL32, "CreateFileW", "CloseHandle"),
  );
  try {
    const holder = withWide(path, (name) =>
      api.symbols.CreateFileW(
        name,
        GENERIC_READ,
        SHARE_ALL,
        null,
        CREATE_NEW,
        0,
        0n,
      ),
    );
    assert.notEqual(
      holder,
      INVALID_HANDLE_VALUE,
      "The holder handle must open.",
    );
    // Closing the only handle that asked for delete-on-close marks the file for deletion.
    const deleter = withWide(path, (name) =>
      api.symbols.CreateFileW(
        name,
        DELETE_ACCESS | GENERIC_WRITE,
        SHARE_ALL,
        null,
        OPEN_EXISTING,
        FILE_FLAG_DELETE_ON_CLOSE,
        0n,
      ),
    );
    assert.notEqual(
      deleter,
      INVALID_HANDLE_VALUE,
      "The deleter handle must open.",
    );
    api.symbols.CloseHandle(deleter);
    return holder;
  } finally {
    api.close();
  }
}

function releaseHandle(handle: bigint): void {
  const api = dlopen("kernel32.dll", pick(KERNEL32, "CloseHandle"));
  try {
    api.symbols.CloseHandle(handle);
  } finally {
    api.close();
  }
}

const storage = new WindowsStorage();
try {
  await mkdir(root, {
    recursive: true,
  });

  for (let round = 0; round < ROUNDS; round++) {
    await race(round);
  }

  // A delete-pending name cannot be created again; the refusal is an access error, not "exists".
  const pending = `${root}\\pending.bin`;
  const source = `${root}\\pending-source.bin`;
  writeFileSync(source, "pending");
  const holder = holdDeletePending(pending);
  try {
    assert.throws(
      () =>
        storage.copyFile({
          from: source,
          to: pending,
        }),
      (error) =>
        error instanceof BunawayError &&
        error.code === "PERMISSION_DENIED" &&
        error.message === "Storage access denied.",
    );
  } finally {
    releaseHandle(holder);
  }
  // Once the last handle closes the name is free again.
  storage.copyFile({
    from: source,
    to: pending,
  });
  assert.equal(await readFile(pending, "utf8"), "pending");

  assert.equal(
    readdirSync(root).filter((name) => name.startsWith("target-")).length,
    ROUNDS,
  );
  console.log("windows-storage-create-new ok");
} finally {
  storage.dispose();
  rmSync(root, {
    recursive: true,
    force: true,
  });
}

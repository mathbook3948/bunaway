import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BunawayError } from "@bunaway/plugin";
import { KERNEL32, pick, withWide } from "@bunaway/plugin/win32";
import { WindowsStorage } from "#plugins/storage/src/platforms/windows";
import { deadline, killAfter, waitFor } from "../fixtures/deadlines.ts";

assert.equal(process.platform, "win32");

const CHILD_MODE = "child";
const COPIERS = 6;
const ROUNDS = 5;
const SOURCE_BYTES = 16 * 1024 * 1024;
// Children start Bun and bind kernel32 first, so the shared start time leaves room for the slowest.
const START_DELAY_NAME = "childExit";
const REMOVE_RETRIES = 10;
const REMOVE_RETRY_DELAY_MS = 200;

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const DELETE_ACCESS = 0x10000;
const SHARE_ALL = 0x7;
const CREATE_NEW = 1;
const OPEN_EXISTING = 3;
const FILE_FLAG_DELETE_ON_CLOSE = 0x04000000;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;

/** What one copier reports: when it was ready, when its copy ran, and how the copy ended. */
type Outcome = {
  readyAtMs: number;
  beforeMs: number;
  afterMs: number;
  result: "ok" | "error" | "raw";
  code?: string;
  message?: string;
};

/**
 * One copier: wait for the shared start time, then copy once and report the outcome as a JSON line.
 * The timestamps let the parent prove that the attempts overlapped instead of running in turn.
 */
async function runCopier(
  from: string,
  to: string,
  startAtMs: number,
): Promise<void> {
  const storage = new WindowsStorage();
  const readyAtMs = Date.now();
  while (Date.now() < startAtMs) {
    // Spin so that every copier reaches the exclusive create within a few milliseconds.
  }
  const beforeMs = Date.now();
  let result: Pick<Outcome, "result" | "code" | "message"> = {
    result: "ok",
  };
  try {
    storage.copyFile({
      from,
      to,
    });
  } catch (error) {
    result =
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
  const outcome: Outcome = {
    readyAtMs,
    beforeMs,
    afterMs: Date.now(),
    ...result,
  };
  storage.dispose();
  // Wait for the write so that exiting cannot cut the line off.
  await Bun.write(Bun.stdout, `${JSON.stringify(outcome)}\n`);
}

const [, , mode = "", childFrom = "", childTo = "", childStart = "0"] =
  process.argv;
if (mode === CHILD_MODE) {
  await runCopier(childFrom, childTo, Number(childStart));
  process.exit(0);
}

const root = resolve(
  import.meta.dir,
  `../../build/wcn-${crypto.randomUUID().slice(0, 8)}`,
);

/** Children still running; the final cleanup stops them before the folder is removed. */
const liveChildren = new Set<ReturnType<typeof Bun.spawn>>();

/** Read the last non-empty line of a copier's output as its outcome. */
function parseOutcome(text: string): Outcome {
  const line = text.trim().split("\n").at(-1) ?? "";
  assert(line !== "", "A copier printed no outcome.");
  const parsed: unknown = JSON.parse(line);
  assert(
    typeof parsed === "object" &&
      parsed !== null &&
      "result" in parsed &&
      "readyAtMs" in parsed &&
      "beforeMs" in parsed &&
      "afterMs" in parsed,
    `Unexpected copier output: ${line}`,
  );
  return parsed as Outcome;
}

async function collect(child: ReturnType<typeof Bun.spawn>): Promise<Outcome> {
  const timer = killAfter(child, "nativeFixture");
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    assert.equal(code, 0, `copier failed: ${err}`);
    return parseOutcome(out);
  } finally {
    clearTimeout(timer);
    liveChildren.delete(child);
  }
}

/** Start six copiers at one instant and check the exclusive create. Returns the overlapping losers. */
async function race(round: number): Promise<number> {
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
  const startAtMs = Date.now() + deadline(START_DELAY_NAME);
  const children = sources.map((source) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
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
    );
    liveChildren.add(child);
    return child;
  });
  const outcomes = await Promise.all(children.map(collect));

  // A copier that was not ready by the start time would make the round a sequence, not a race.
  for (const outcome of outcomes) {
    assert(
      outcome.readyAtMs <= startAtMs,
      `A copier started late: ${JSON.stringify(outcomes)}`,
    );
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
  const winnerIndex = winners[0] ?? -1;
  const winner = outcomes[winnerIndex];
  const winningSource = sources[winnerIndex];
  assert(
    winner !== undefined && winningSource !== undefined,
    "The winner must be one of the copiers.",
  );
  let overlapping = 0;
  for (const [index, outcome] of outcomes.entries()) {
    if (index === winnerIndex) {
      continue;
    }
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
    // This loser was refused before the winner finished, so it met a name that was still in use.
    if (outcome.afterMs < winner.afterMs) {
      overlapping++;
    }
  }
  // The file holds the winner's bytes only; later attempts never write into it.
  const copied = await readFile(target);
  const original = await readFile(winningSource);
  assert(copied.equals(original), "The target must equal the winning source.");
  return overlapping;
}

/**
 * Make `path` delete-pending: it is deleted while another handle stays open, so the name still
 * exists but no new file can take it. Returns the handle that keeps it pending, which the caller
 * closes. If the deletion cannot be set up, the opened handle is closed before the error is thrown.
 */
function holdDeletePending(path: string): bigint {
  const api = dlopen(
    "kernel32.dll",
    pick(KERNEL32, "CreateFileW", "CloseHandle"),
  );
  let holder = INVALID_HANDLE_VALUE;
  let handedOver = false;
  try {
    holder = withWide(path, (name) =>
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
    handedOver = true;
    return holder;
  } finally {
    if (!handedOver && holder !== INVALID_HANDLE_VALUE) {
      api.symbols.CloseHandle(holder);
    }
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

  const overlaps: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    overlaps.push(await race(round));
  }
  console.log(`Losers that overlapped the winning copy per round: ${overlaps}`);
  // Every round must have had at least one attempt while the winner was still copying.
  assert(
    overlaps.every((count) => count > 0),
    `The attempts did not overlap: ${overlaps}`,
  );

  // A name deleted with delete-on-close and still held open cannot be created again; the refusal
  // is an access error, not "exists".
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
  // Once the last handle closes the name is free again. A scanner can hold the file briefly, so
  // the copy is retried until it stops being refused.
  await waitFor(
    () => {
      try {
        storage.copyFile({
          from: source,
          to: pending,
        });
        return true;
      } catch (error) {
        if (
          error instanceof BunawayError &&
          error.code === "PERMISSION_DENIED"
        ) {
          return false;
        }
        throw error;
      }
    },
    {
      deadline: "childExit",
      what: "the delete-pending name to be released",
    },
  );
  assert.equal(await readFile(pending, "utf8"), "pending");

  assert.equal(
    readdirSync(root).filter((name) => name.startsWith("target-")).length,
    ROUNDS,
  );
  console.log("windows-storage-create-new ok");
} finally {
  storage.dispose();
  // Stop any copier that is still running so the folder can be removed and the first error shows.
  for (const child of liveChildren) {
    child.kill();
    await child.exited;
  }
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: REMOVE_RETRIES,
    retryDelay: REMOVE_RETRY_DELAY_MS,
  });
}

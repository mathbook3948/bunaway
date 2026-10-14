import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BunawayError } from "@bunaway/protocol";
import {
  dispose,
  initialize,
  run,
} from "#plugins/process/src/platforms/windows";
import {
  activeDescendants,
  containAppProcess,
  terminateAppDescendants,
} from "../../native/windows/bun/job.ts";

const root = process.argv[2];
assert(root);
containAppProcess(root);

const SYNCHRONIZE = 0x00100000;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
const api = dlopen("kernel32.dll", {
  CreateJobObjectW: {
    args: [
      "ptr",
      "ptr",
    ],
    returns: "u64",
  },
  GetCurrentProcess: {
    args: [],
    returns: "u64",
  },
  AssignProcessToJobObject: {
    args: [
      "u64",
      "u64",
    ],
    returns: "i32",
  },
  QueryInformationJobObject: {
    args: [
      "u64",
      "i32",
      "ptr",
      "u32",
      "ptr",
    ],
    returns: "i32",
  },
  IsProcessInJob: {
    args: [
      "u64",
      "u64",
      "ptr",
    ],
    returns: "i32",
  },
  OpenProcess: {
    args: [
      "u32",
      "i32",
      "u32",
    ],
    returns: "u64",
  },
  QueryFullProcessImageNameW: {
    args: [
      "u64",
      "u32",
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
  GetSystemDirectoryW: {
    args: [
      "ptr",
      "u32",
    ],
    returns: "u32",
  },
  WaitForSingleObject: {
    args: [
      "u64",
      "u32",
    ],
    returns: "u32",
  },
  CloseHandle: {
    args: [
      "u64",
    ],
    returns: "i32",
  },
  GetLastError: {
    args: [],
    returns: "u32",
  },
});
function check(result: number | bigint, operation: string) {
  assert(result, `${operation} failed (Win32 ${api.symbols.GetLastError()}).`);
}

// A known nested Job handle lets the fixture verify membership by identity,
// while the real containAppProcess owner retains the outer shutdown Job.
const parentJob = api.symbols.CreateJobObjectW(null, null);
check(parentJob, "CreateJobObjectW");
check(
  api.symbols.AssignProcessToJobObject(
    parentJob,
    api.symbols.GetCurrentProcess(),
  ),
  "AssignProcessToJobObject",
);
const handles = new Map<number, bigint>();
const member = Buffer.alloc(4);
function requireMembership(handle: bigint) {
  check(
    api.symbols.IsProcessInJob(handle, parentJob, ptr(member)),
    "IsProcessInJob",
  );
  assert.equal(
    member.readUInt32LE(),
    1,
    "Intended process escaped its parent Job.",
  );
}
requireMembership(api.symbols.GetCurrentProcess());

async function waitForFile(path: string, signal: AbortSignal) {
  const deadline = Date.now() + 2000;
  while (!(await Bun.file(path).exists())) {
    signal.throwIfAborted();
    assert(Date.now() < deadline, "Fixture readiness timed out.");
    await Bun.sleep(2);
  }
}

const state = initialize();
const first = new AbortController();
const second = new AbortController();
const firstPidFile = join(root, "first.pid");
const secondPidFile = join(root, "second.pid");
const input = {
  executablePath: process.execPath,
  args: [
    resolve(import.meta.dir, "process-ready.ts"),
  ],
  maxOutputBytes: 65536,
  timeoutMs: 30000,
};
const firstTask = run(
  state,
  {
    ...input,
    args: [
      ...input.args,
      firstPidFile,
    ],
  },
  first.signal,
).catch((error: unknown) => error);
const secondTask = run(
  state,
  {
    ...input,
    args: [
      ...input.args,
      secondPidFile,
    ],
  },
  second.signal,
).catch((error: unknown) => error);

async function requireReady(
  path: string,
  signal: AbortSignal,
  task: Promise<unknown>,
) {
  await Promise.race([
    waitForFile(path, signal),
    task.then((result) => {
      // Preserve startup failures and their Win32 causes rather than treating a
      // missing root as delayed Job accounting or silently cancelling it.
      if (result instanceof Error) {
        throw result;
      }
      throw new Error("Invocation completed before publishing its PID.");
    }),
  ]);
  return Number(await Bun.file(path).text());
}

try {
  const [firstPid, secondPid] = await Promise.all([
    requireReady(firstPidFile, first.signal, firstTask),
    requireReady(secondPidFile, second.signal, secondTask),
  ]);
  assert.notEqual(firstPid, secondPid);
  const ids = Buffer.alloc(8 + 8 * 128); // JOBOBJECT_BASIC_PROCESS_ID_LIST, Win64
  check(
    api.symbols.QueryInformationJobObject(
      parentJob,
      JOB_OBJECT_BASIC_PROCESS_ID_LIST,
      ptr(ids),
      ids.length,
      null,
    ),
    "QueryInformationJobObject",
  );
  const directory = Buffer.alloc(8192);
  const directoryUnits = api.symbols.GetSystemDirectoryW(
    ptr(directory),
    directory.length / 2,
  );
  assert(directoryUnits > 0 && directoryUnits < directory.length / 2);
  const consoleImage =
    `${directory.subarray(0, directoryUnits * 2).toString("utf16le")}\\conhost.exe`.toLowerCase();
  const consolePids: number[] = [];
  for (let index = 0; index < ids.readUInt32LE(4); index++) {
    const pid = Number(ids.readBigUInt64LE(8 + index * 8));
    if (pid === process.pid) {
      continue;
    }
    const handle = api.symbols.OpenProcess(
      SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
      0,
      pid,
    );
    check(handle, "OpenProcess");
    handles.set(pid, handle);
    requireMembership(handle);
    assert.equal(api.symbols.WaitForSingleObject(handle, 0), WAIT_TIMEOUT);
    if (pid !== firstPid && pid !== secondPid) {
      const image = Buffer.alloc(8192);
      const units = Buffer.alloc(4);
      units.writeUInt32LE(image.length / 2);
      check(
        api.symbols.QueryFullProcessImageNameW(
          handle,
          0,
          ptr(image),
          ptr(units),
        ),
        "QueryFullProcessImageNameW",
      );
      assert.equal(
        image
          .subarray(0, units.readUInt32LE() * 2)
          .toString("utf16le")
          .toLowerCase(),
        consoleImage,
        "Unexpected process in the host Job.",
      );
      consolePids.push(pid);
    }
  }
  const firstHandle = handles.get(firstPid);
  const secondHandle = handles.get(secondPid);
  assert(
    firstHandle && secondHandle,
    "Both intended PIDs must be in the host Job inventory.",
  );
  assert.equal(state.active.size, 2);

  // Let the outer test hold identities for every root and console helper before
  // either invocation can end, so shutdown cannot be confused with PID reuse.
  const inventoryFile = join(root, "members.json");
  await Bun.write(
    `${inventoryFile}.pending`,
    JSON.stringify({
      pids: [
        ...handles.keys(),
      ],
      consolePids,
    }),
  );
  await rename(`${inventoryFile}.pending`, inventoryFile);
  await waitForFile(join(root, "release"), first.signal);

  first.abort();
  const firstResult = await firstTask;
  assert(firstResult instanceof BunawayError);
  assert.equal(firstResult.code, "CANCELLED");
  assert.equal(api.symbols.WaitForSingleObject(firstHandle, 0), WAIT_OBJECT_0);
  assert.equal(
    api.symbols.WaitForSingleObject(secondHandle, 0),
    WAIT_TIMEOUT,
    "Cancelling the first invocation killed the second root.",
  );
  requireMembership(secondHandle);
  assert.equal(state.active.size, 1);

  second.abort();
  const secondResult = await secondTask;
  assert(secondResult instanceof BunawayError);
  assert.equal(secondResult.code, "CANCELLED");
  assert.equal(api.symbols.WaitForSingleObject(secondHandle, 0), WAIT_OBJECT_0);
  assert.equal(state.active.size, 0);
  await dispose(state);

  // A console helper can belong to the host rather than either foreground Job.
  // Exercise the real host shutdown owner and require zero remaining processes.
  process.stdout.write("contained");
  await terminateAppDescendants();
  assert.equal(activeDescendants(), 0);
  for (const handle of handles.values()) {
    assert.equal(api.symbols.WaitForSingleObject(handle, 0), WAIT_OBJECT_0);
  }
} finally {
  first.abort();
  second.abort();
  await Promise.allSettled([
    firstTask,
    secondTask,
  ]);
  await dispose(state);
  await terminateAppDescendants();
  for (const handle of handles.values()) {
    check(api.symbols.CloseHandle(handle), "CloseHandle");
  }
  // This probe has no kill-on-close flag. The real host Job retains lifetime
  // ownership of the fixture itself until process exit releases its handle.
  check(api.symbols.CloseHandle(parentJob), "CloseHandle parent Job");
  api.close();
}

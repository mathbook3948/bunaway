import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export class AppAlreadyRunningError extends Error {
  constructor() {
    super("App data directory is already in use.");
  }
}

let owned:
  | { handle: bigint; lock: bigint; dataRoot: string; api: ReturnType<typeof openBindings> }
  | undefined;
function openBindings() {
  return dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    GetLastError: { args: [], returns: "u32" },
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
    GetCurrentProcess: { args: [], returns: "u64" },
    SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    QueryInformationJobObject: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    TerminateProcess: { args: ["u64", "u32"], returns: "i32" },
    WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
}
export function containAppProcess(dataRoot: string) {
  mkdirSync(dataRoot, { recursive: true });
  const canonical = realpathSync(dataRoot).toLowerCase();
  if (owned) {
    assert.equal(owned.dataRoot, canonical, "App process already owns another data directory");
    return;
  }
  const api = openBindings();
  const name = Buffer.from(`${resolve(dataRoot, "host.lock")}\0`, "utf16le");
  // OPEN_ALWAYS, no sharing: preserve profiles but reject a second owner before app import.
  const lock = api.symbols.CreateFileW(ptr(name), 0xc0000000, 0, null, 4, 0x00200000, 0n);
  if (lock === 0xffffffffffffffffn) {
    const error = api.symbols.GetLastError();
    api.close();
    if (error === 32) throw new AppAlreadyRunningError();
    throw new Error(`App lock failed (${error})`);
  }
  let handle = 0n;
  try {
    handle = api.symbols.CreateJobObjectW(null, null);
    assert(handle, "App Job creation failed");
    const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, Win64
    limits.writeUInt32LE(0x2000, 16); // BasicLimitInformation.LimitFlags: KILL_ON_JOB_CLOSE
    assert(
      api.symbols.SetInformationJobObject(handle, 9, ptr(limits), limits.length),
      "App Job limits failed",
    );
    assert(
      api.symbols.AssignProcessToJobObject(handle, api.symbols.GetCurrentProcess()),
      "App Job assignment failed",
    );
    // Non-inheritable handle lives until process exit. Closing it here would kill
    // this process too; OS handle teardown also reaps remaining app descendants.
    // The OS also releases the file lock on normal exit or a crash; no stale-lock deletion.
    owned = { api, handle, lock, dataRoot: canonical };
  } catch (error) {
    if (handle) api.symbols.CloseHandle(handle);
    api.symbols.CloseHandle(lock);
    api.close();
    throw error;
  }
}
export function activeDescendants(): number {
  assert(owned);
  const accounting = Buffer.alloc(48); // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
  assert(
    owned.api.symbols.QueryInformationJobObject(
      owned.handle,
      1,
      ptr(accounting),
      accounting.length,
      null,
    ),
    "App Job query failed",
  );
  return Math.max(0, accounting.readUInt32LE(40) - 1); // exclude this Bun process
}

// The development-server worker remains alive until its Job descendants exit.
// A worker exit notification alone does not establish that their ports are free.
export async function terminateAppDescendants(timeoutMs = 5000): Promise<void> {
  assert(owned);
  const { api, handle } = owned;
  const deadline = Date.now() + timeoutMs;
  while (activeDescendants() > 0) {
    assert(Date.now() < deadline, "App Job descendant cleanup timed out");
    let list = Buffer.alloc(8 + 8 * 128); // JOBOBJECT_BASIC_PROCESS_ID_LIST, Win64
    while (!api.symbols.QueryInformationJobObject(handle, 3, ptr(list), list.length, null)) {
      assert.equal(api.symbols.GetLastError(), 234, "App Job process inventory failed"); // ERROR_MORE_DATA
      assert(list.length < 16 * 1024 * 1024, "App Job process inventory is too large");
      list = Buffer.alloc(list.length * 2);
    }
    const count = list.readUInt32LE(4);
    for (let index = 0; index < count; index++) {
      const pid = Number(list.readBigUInt64LE(8 + index * 8));
      if (pid === process.pid) continue;
      const processHandle = api.symbols.OpenProcess(0x100001, 0, pid); // SYNCHRONIZE | PROCESS_TERMINATE
      if (!processHandle) {
        assert.equal(api.symbols.GetLastError(), 87, `Cannot open Job descendant ${pid}`); // already exited
        continue;
      }
      try {
        if (api.symbols.WaitForSingleObject(processHandle, 0) !== 0) {
          const terminated = api.symbols.TerminateProcess(processHandle, 1);
          assert(
            terminated || api.symbols.WaitForSingleObject(processHandle, 0) === 0,
            `Cannot terminate Job descendant ${pid}`,
          );
        }
      } finally {
        api.symbols.CloseHandle(processHandle);
      }
    }
    await Bun.sleep(10);
  }
}

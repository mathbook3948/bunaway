import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

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
    throw new Error(
      error === 32 ? "App data directory is already in use." : `App lock failed (${error})`,
    );
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

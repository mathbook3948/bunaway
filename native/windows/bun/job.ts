import { dlopen, ptr } from "bun:ffi";
import assert from "node:assert/strict";

let owned: { handle: bigint; api: ReturnType<typeof openBindings> } | undefined;
function openBindings() {
  return dlopen("kernel32.dll", {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
    GetCurrentProcess: { args: [], returns: "u64" },
    SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    QueryInformationJobObject: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
}
export function containAppProcess() {
  if (owned) return;
  const api = openBindings();
  const handle = api.symbols.CreateJobObjectW(null, null);
  assert(handle, "App Job creation failed");
  try {
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
    owned = { api, handle };
  } catch (error) {
    api.symbols.CloseHandle(handle);
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

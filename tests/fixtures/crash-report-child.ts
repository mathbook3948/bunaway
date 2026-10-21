import { CFunction, dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import assert from "node:assert/strict";
import crashReport from "@bunaway/plugin-crash-report/native/windows";

/**
 * Child of tests/lifecycle/windows-crash-report.test.ts: enable local dumps for `dataRoot`, then end
 * the process the way `mode` says. It prints "ready" once the registration is in place.
 *   failfast: RaiseFailFastException, which hands the process to Windows Error Reporting at once.
 *   access-violation: a native write to address 0, which Bun's own crash handling sees first.
 */
const [dataRoot, mode] = process.argv.slice(2);
assert(
  dataRoot &&
    (mode === "failfast" || mode === "int29" || mode === "access-violation"),
);

const platform = crashReport._definition.nativePlatforms.windows;
assert(platform);
const adapter = platform.create({
  dataRoot,
  capabilities: [],
});
await adapter.execute("crashReport.enable", null, "backend");
console.log("ready");

const kernel32 = dlopen("kernel32.dll", {
  RaiseFailFastException: {
    args: [
      "ptr",
      "ptr",
      "u32",
    ],
    returns: "void",
  },
  RtlMoveMemory: {
    args: [
      "u64",
      "ptr",
      "u64",
    ],
    returns: "void",
  },
});
if (mode === "int29") {
  // mov ecx, 7 (FAST_FAIL_FATAL_APP_EXIT); int 0x29: the kernel fail-fast that no user-mode handler sees.
  const code = Buffer.from([
    0xb9,
    0x07,
    0x00,
    0x00,
    0x00,
    0xcd,
    0x29,
  ]);
  const memory = dlopen("kernel32.dll", {
    VirtualAlloc: {
      args: [
        "u64",
        "u64",
        "u32",
        "u32",
      ],
      returns: "u64",
    },
  }).symbols.VirtualAlloc(0n, 4096n, 0x3000, 0x40);
  assert(memory);
  new Uint8Array(toArrayBuffer(Number(memory) as Pointer, 0, 4096)).set(code);
  CFunction({
    ptr: Number(memory) as Pointer,
    args: [],
    returns: "void",
  })();
} else if (mode === "failfast") {
  kernel32.symbols.RaiseFailFastException(null, null, 0);
} else {
  kernel32.symbols.RtlMoveMemory(0n, ptr(Buffer.alloc(8)), 8n);
}

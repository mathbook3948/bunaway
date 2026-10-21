import { dlopen, ptr } from "bun:ffi";
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
    (mode === "failfast" ||
      mode === "rtl-failfast" ||
      mode === "access-violation"),
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
if (mode === "rtl-failfast") {
  const ntdll = dlopen("ntdll.dll", {
    RtlFailFast: {
      args: [
        "u32",
      ],
      returns: "void",
    },
  });
  ntdll.symbols.RtlFailFast(5);
} else if (mode === "failfast") {
  kernel32.symbols.RaiseFailFastException(null, null, 0);
} else {
  kernel32.symbols.RtlMoveMemory(0n, ptr(Buffer.alloc(8)), 8n);
}

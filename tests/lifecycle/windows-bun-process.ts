import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { validateValue } from "@bunaway/protocol";

if (process.argv.includes("--validate")) {
  for await (const line of console) {
    if (!line.trim()) {
      continue;
    }
    const { schema, value } = JSON.parse(line);
    let accepted = true;
    try {
      validateValue(schema, value);
    } catch {
      accepted = false;
    }
    console.log(JSON.stringify(accepted));
  }
} else {
  assert(process.argv.includes("--watch"));
  const api = dlopen("kernel32.dll", {
    OpenProcess: {
      args: [
        "u32",
        "i32",
        "u32",
      ],
      returns: "u64",
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
  });
  const handles = process.argv
    .slice(process.argv.indexOf("--watch") + 1)
    .map((pid) => api.symbols.OpenProcess(0x100000, 0, Number(pid)));
  assert(handles.length && handles.every(Boolean));
  try {
    // The parent starts killing renderers only after these handles are open.
    console.log("watch-ready");
    const deadline = Date.now() + 60000;
    while (
      handles.some(
        (handle) => api.symbols.WaitForSingleObject(handle, 0) === 258,
      )
    ) {
      assert(Date.now() < deadline, "Process handle exit timeout");
      await Bun.sleep(10);
    }
    for (const handle of handles) {
      assert.equal(api.symbols.WaitForSingleObject(handle, 0), 0);
    }
  } finally {
    for (const handle of handles) {
      assert(api.symbols.CloseHandle(handle));
    }
    api.close();
  }
}

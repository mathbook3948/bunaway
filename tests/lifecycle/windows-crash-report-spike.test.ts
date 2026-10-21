import { dlopen, ptr } from "bun:ffi";
import { test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { withWide } from "@bunaway/plugin/win32";

const symbols = {
  WerRegisterAppLocalDump: {
    args: [
      "ptr",
    ],
    returns: "i32",
  },
  WerUnregisterAppLocalDump: {
    args: [],
    returns: "i32",
  },
} as const;

test.skipIf(process.platform !== "win32")("spike", () => {
  const local = process.env.LOCALAPPDATA ?? "";
  const names = [
    "kernel32.dll",
    "kernelbase.dll",
    "wer.dll",
  ];
  for (const name of names) {
    try {
      const library = dlopen(name, symbols);
      console.log(`SPIKE exports in ${name}`);
      library.close();
    } catch (error) {
      console.log(`SPIKE no export in ${name}: ${String(error).slice(0, 80)}`);
    }
  }
  const kernel32 = dlopen("kernel32.dll", {
    ...symbols,
    GetCurrentPackageFullName: {
      args: [
        "ptr",
        "ptr",
      ],
      returns: "i32",
    },
  });
  const length = new Uint32Array(1);
  console.log(
    `SPIKE package rc ${kernel32.symbols.GetCurrentPackageFullName(ptr(length), null)}`,
  );
  const base = join(local, "bunaway", `spike-${process.pid}`);
  mkdirSync(join(base, "dumps"), {
    recursive: true,
  });
  const variants: [
    string,
    string,
  ][] = [
    [
      "nested backslash",
      `bunaway\\spike-${process.pid}\\dumps`,
    ],
    [
      "nested forward slash",
      `bunaway/spike-${process.pid}/dumps`,
    ],
    [
      "nested trailing backslash",
      `bunaway\\spike-${process.pid}\\dumps\\`,
    ],
    [
      "leading backslash",
      `\\bunaway\\spike-${process.pid}\\dumps`,
    ],
    [
      "one segment missing",
      "bunaway-spike-missing",
    ],
    [
      "one segment existing",
      "bunaway",
    ],
    [
      "dot",
      ".",
    ],
    [
      "empty",
      "",
    ],
    [
      "absolute",
      join(base, "dumps"),
    ],
  ];
  for (const [label, path] of variants) {
    const hr = withWide(path, (address) =>
      kernel32.symbols.WerRegisterAppLocalDump(address),
    );
    console.log(`SPIKE ${label}: 0x${(hr >>> 0).toString(16)}`);
    console.log(
      `SPIKE unregister after ${label}: 0x${(kernel32.symbols.WerUnregisterAppLocalDump() >>> 0).toString(16)}`,
    );
  }
  console.log(
    `SPIKE null pointer: 0x${(kernel32.symbols.WerRegisterAppLocalDump(null) >>> 0).toString(16)}`,
  );
});

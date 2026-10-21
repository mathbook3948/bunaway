import { dlopen, ptr } from "bun:ffi";
import { test } from "bun:test";
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
  for (const total of [
    16,
    32,
    48,
    60,
    62,
    63,
    64,
    65,
    66,
    72,
    80,
    100,
    128,
    200,
    259,
    300,
  ]) {
    const prefix = "bunaway\\";
    const path = prefix + "a".repeat(total - prefix.length);
    const hr = withWide(path, (address) =>
      kernel32.symbols.WerRegisterAppLocalDump(address),
    );
    console.log(`SPIKE length ${path.length}: 0x${(hr >>> 0).toString(16)}`);
    kernel32.symbols.WerUnregisterAppLocalDump();
  }
});

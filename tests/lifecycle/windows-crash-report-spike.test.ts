import { dlopen, ptr } from "bun:ffi";
import { setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { withWide } from "@bunaway/plugin/win32";

setDefaultTimeout(300_000);

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

async function text(command: string[]): Promise<string> {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  return `${out}${err}`.replaceAll("\r\n", " | ");
}

test.skipIf(process.platform !== "win32")("spike crash modes", async () => {
  console.log(
    `SPIKE wersvc ${await text([
      "sc",
      "query",
      "WerSvc",
    ])}`,
  );
  console.log(
    `SPIKE wer policy ${await text([
      "reg",
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting",
      "/v",
      "Disabled",
    ])}`,
  );
  console.log(
    `SPIKE wer local ${await text([
      "reg",
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps",
    ])}`,
  );
  const child = resolve(import.meta.dir, "../fixtures/crash-report-child.ts");
  for (const mode of [
    "failfast",
    "rtl-failfast",
    "access-violation",
  ]) {
    const root = join(
      process.env.LOCALAPPDATA ?? "",
      "bunaway",
      `sp-${process.pid}-${mode.length}`,
    );
    const process_ = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        child,
        root,
        mode,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(process_.stdout).text(),
      new Response(process_.stderr).text(),
      process_.exited,
    ]);
    await Bun.sleep(25_000);
    const folder = join(root, "crash-dumps");
    console.log(
      `SPIKE ${mode}: exit 0x${(code >>> 0).toString(16)} stdout ${JSON.stringify(out.slice(0, 200))} stderr ${JSON.stringify(err.slice(0, 600))} files ${JSON.stringify(existsSync(folder) ? readdirSync(folder) : "no folder")}`,
    );
  }
});

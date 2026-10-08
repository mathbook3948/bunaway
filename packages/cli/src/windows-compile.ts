import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { frameworkRoot } from "./files.ts";
import { runManagedCommand } from "./managed-command.ts";
import { run } from "./processes.ts";

export function compiledAssetArguments(
  bundledAssets: readonly string[],
): string[] {
  return [
    "app.json",
    "policy.json",
    "web",
    ...bundledAssets,
  ].map((name) => `--asset=${name}`);
}

// Compile using the verified runtime supplied by prepareNative, without downloads.
export async function compileWindowsApp(
  root: string,
  bun: string,
  executableName: string,
  app: {
    title: string;
    icon?: string;
  },
  bundledAssets: readonly string[],
  signal?: AbortSignal,
  framework = frameworkRoot,
): Promise<void> {
  const assets = resolve(root, "assets");
  // Bun 1.4.2 cannot copy a --compile-executable-path containing Unicode.
  // Keep the verified compiler input local and pass an ASCII relative path.
  await cp(bun, resolve(assets, "bun.exe"));
  const args = [
    bun,
    "build",
    "--compile",
    "--target=bun-windows-x64-baseline",
    "--compile-executable-path=./bun.exe",
    "--windows-hide-console",
    `--windows-title=${app.title}`,
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-tsconfig",
    "--no-compile-autoload-package-json",
    ...compiledAssetArguments(bundledAssets),
    ...(app.icon
      ? [
          `--windows-icon=${resolve(assets, "app.ico")}`,
        ]
      : []),
    `--outfile=${resolve(root, executableName)}`,
    "./boot.js",
    "./ui.js",
    "./host-operations.js",
  ];
  if (signal) {
    await runManagedCommand(args, assets, {}, signal, framework);
  } else {
    await run(args, assets);
  }
  // The compiler has consumed the staging assets; only the DLL stays external.
  await rm(assets, {
    recursive: true,
    force: true,
  });
}

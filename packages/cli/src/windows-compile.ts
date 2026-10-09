import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { frameworkRoot } from "./files.ts";
import { runManagedCommand } from "./managed-command.ts";
import { run } from "./processes.ts";

/** Convert required app and bundled web assets to Bun compile flags. */
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

/** Compile the Windows host with the prepared Bun runtime, then remove consumed staging assets. */
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
  // Bun 1.4.2 requires an ASCII --compile-executable-path, so copy the verified runtime beside the entry points.
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

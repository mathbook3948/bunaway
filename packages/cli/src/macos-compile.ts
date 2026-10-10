import { frameworkRoot } from "./files.ts";
import { runManagedCommand } from "./managed-command.ts";
import { run } from "./processes.ts";

/** Compile the main entry, backend Worker and file imports; web resources stay external. */
export async function compileMacosApp(
  assets: string,
  bun: string,
  executable: string,
  bundledAssets: readonly string[],
  signal?: AbortSignal,
  framework = frameworkRoot,
): Promise<void> {
  const args = [
    bun,
    "build",
    "--compile",
    "--target=bun-darwin-arm64",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-tsconfig",
    "--no-compile-autoload-package-json",
    "--asset=manifest.json",
    ...bundledAssets.map((name) => `--asset=${name}`),
    `--outfile=${executable}`,
    "./boot.js",
    "./backend.js",
  ];
  if (signal) {
    await runManagedCommand(args, assets, {}, signal, framework);
  } else {
    await run(args, assets);
  }
}

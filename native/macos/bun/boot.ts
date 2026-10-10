import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { verifyMacosPackage } from "./config.ts";
import { runMacosApp } from "./entry.ts";

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const compiled = Bun.embeddedFiles.some(
      (file) => (file as File).name === "manifest.json",
    );
    const root = compiled
      ? resolve(dirname(process.execPath), "../Resources")
      : resolve(import.meta.dir, "..");
    assert(
      args.length === 0 ||
        (args[0] === "--package" &&
          (args.length === 2 ||
            (args.length === 4 && args[2] === "--dev-url"))),
      "Usage: bunaway [--package <dir> [--dev-url <url>]]",
    );
    const config = await verifyMacosPackage(args[1] ?? root, args[3]);
    await runMacosApp(config);
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

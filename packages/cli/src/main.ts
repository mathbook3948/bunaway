#!/usr/bin/env bun
import { buildProject, createProject, devProject, doctor, validateProject } from "./index.ts";

const help = `bunaway (vanilla MVP)
  create <new-directory>  Generate an independent project (then bun install)
  validate [directory]   Validate configuration and deny-by-default policy
  dev [directory]        Watch sources; rebuild and restart the native host
  build [directory]      Build a native package with pinned bundled Bun
  doctor [directory]     Check project, runtime version and native tools
Builds are native only: Windows x64 / macOS arm64.`;

export async function main(args: string[]): Promise<number> {
  const [command, directory, ...extra] = args;
  if (!command || command === "--help" || command === "help") {
    console.log(help);
    return 0;
  }
  if (extra.length || directory?.startsWith("--"))
    throw new Error("Unexpected argument. Use --help.");
  switch (command) {
    case "create": {
      if (!directory) throw new Error("create requires a new directory.");
      const path = await createProject(directory);
      console.log(
        `Created ${path}\nNext: enter the directory, run bun install, then bun run doctor / dev / build.`,
      );
      return 0;
    }
    case "validate":
      await validateProject(directory ?? ".");
      console.log("Configuration and policy are valid.");
      return 0;
    case "dev":
      await devProject(directory ?? ".");
      return 0;
    case "build":
      console.log(`Built ${(await buildProject(directory ?? ".")).output}`);
      return 0;
    case "doctor":
      return (await doctor(directory ?? ".")) ? 0 : 1;
    default:
      throw new Error(`Unknown command: ${command}. Use --help.`);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`bunaway: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

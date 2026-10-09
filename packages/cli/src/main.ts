#!/usr/bin/env bun
import {
  buildProject,
  createProject,
  devProject,
  doctor,
  packageProject,
  validateProject,
} from "./index.ts";
import { isTemplate, templateNames, type Template } from "./templates.ts";
import { parseDevArguments } from "./dev.ts";

const help = `bunaway (vanilla / Vite / React / Vue / Svelte)
  create <new-directory>   Generate an independent project (then bun install)
                          [--template ${templateNames.join("|")}] [--package-dir <tarball-directory>]
  validate [directory]    Validate configuration and deny-by-default policy
  dev [directory]         Watch sources; rebuild and restart the native host
                          [--inspect[=<port>]] Windows backend debugger (default 6499)
  build [directory]       Build frontend and app with pinned bundled Bun
  package <channel> [dir] Package a build artifact for a channel [--build]
  doctor [directory]      Check project, runtime version and native tools
Builds are native only: Windows x64 / macOS arm64.`;

/** Run a CLI command and return its process exit code. */
export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "help") {
    console.log(help);
    return 0;
  }
  if (command === "create") {
    const [directory, ...options] = rest;
    const usage = `Usage: bunaway create <directory> [--template ${templateNames.join("|")}] [--package-dir <tarball-directory>].`;
    if (!directory || directory.startsWith("--")) {
      throw new Error(usage);
    }
    let packageDirectory: string | undefined;
    let template: Template = "vanilla";
    const seen = new Set<string>();
    // Parse options as name/value pairs so a missing value cannot be mistaken for another flag.
    for (let index = 0; index < options.length; index += 2) {
      const option = options[index];
      const value = options[index + 1];
      if (!option || seen.has(option) || !value || value.startsWith("--")) {
        throw new Error(usage);
      }
      seen.add(option);
      if (option === "--package-dir") {
        packageDirectory = value;
      } else if (option === "--template" && isTemplate(value)) {
        template = value;
      } else {
        throw new Error(usage);
      }
    }
    const path = await createProject(directory, {
      template,
      ...(packageDirectory
        ? {
            packageDirectory,
          }
        : {}),
    });
    console.log(
      `Created ${path}\nNext: enter the directory, run bun install, then bun run doctor and bun run dev.`,
    );
    return 0;
  }
  if (command === "package") {
    const [channel, ...tail] = rest;
    if (!channel) {
      throw new Error(
        "package requires a channel, e.g. bunaway package win-direct.",
      );
    }
    let directory = ".";
    let build = false;
    for (const arg of tail) {
      if (arg === "--build") {
        build = true;
      } else if (arg.startsWith("--")) {
        throw new Error(`Unknown option: ${arg}. Use --help.`);
      } else if (directory !== ".") {
        throw new Error("Unexpected extra argument. Use --help.");
      } else {
        directory = arg;
      }
    }
    const report = await packageProject(directory, channel, {
      build,
    });
    return report.ok ? 0 : 1;
  }
  if (command === "dev") {
    const { directory, ...options } = parseDevArguments(rest);
    await devProject(directory, options);
    return 0;
  }
  const [directory, ...extra] = rest;
  if (extra.length || directory?.startsWith("--")) {
    throw new Error("Unexpected argument. Use --help.");
  }
  switch (command) {
    case "validate": {
      await validateProject(directory ?? ".");
      console.log("Configuration and policy are valid.");
      return 0;
    }
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
    console.error(
      `bunaway: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

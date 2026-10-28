#!/usr/bin/env bun
import {
  buildAndroidProject,
  isAndroidSerial,
  runAndroidProject,
  syncAndroidProject,
} from "./android.ts";
import { contractListText } from "./contract-list.ts";
import { parseDevArguments } from "./dev.ts";
import {
  buildNativePlugin,
  buildProject,
  createNativePlugin,
  createProject,
  devProject,
  doctor,
  packageProject,
  validateProject,
} from "./index.ts";
import { buildIosProject, runIosProject, syncIosProject } from "./ios.ts";
import { isTemplate, type Template, templateNames } from "./templates.ts";
import { upgradeProject } from "./upgrade.ts";

const help = `bunaway (vanilla / Vite / React / Vue / Svelte)
  create <new-directory>   Generate an independent project (then bun install)
                          [--template ${templateNames.join("|")}] [--package-dir <tarball-directory>]
  validate [directory]    Validate configuration and deny-by-default policy
  contract [directory]    Print the commands, events and per-view exposure as JSON
                          (imports the app entry, so its top-level code runs)
  dev [directory]         Watch sources; rebuild and restart the native host
                          [--inspect[=<port>]] Windows backend debugger (default 6499)
  build [directory]       Build frontend and app with pinned bundled Bun
  package <channel> [dir] Package a build artifact for a channel [--build]
  doctor [directory]      Check project, runtime version and native tools
  upgrade [directory]     Check framework package pins against this CLI [--write]
  plugin build [dir]     Build a native plugin package from src/index.ts
  plugin new <name>      Scaffold and register a plugin workspace in this repository
  android sync [dir]     Create or refresh the editable Android Studio project
  android build [dir]    Sync and build an experimental Android debug APK on Windows
  android run [dir]      Build, install and start the APK [--serial <device>]
  ios sync [dir]         Create or refresh the editable Xcode project
  ios build [dir]        Sync and build an experimental arm64 Simulator app
  ios run [dir]          Build, install and start on a booted Simulator --device <UUID>
Desktop builds: Windows x64 / macOS arm64. Android debug APK builds: Windows. iOS Simulator builds: macOS arm64.`;

/** Parse `--package-dir` and `--template` as name/value pairs, each at most once. */
function parseCreateOptions(
  options: string[],
  usage: string,
): {
  packageDirectory: string | undefined;
  template: Template;
} {
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
  return {
    packageDirectory,
    template,
  };
}

async function createCommand(rest: string[]): Promise<number> {
  const [directory, ...options] = rest;
  const usage = `Usage: bunaway create <directory> [--template ${templateNames.join("|")}] [--package-dir <tarball-directory>].`;
  if (!directory || directory.startsWith("--")) {
    throw new Error(usage);
  }
  const { packageDirectory, template } = parseCreateOptions(options, usage);
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

/** The optional `--build` flag and at most one project directory. */
function parsePackageArguments(tail: string[]): {
  directory: string;
  build: boolean;
} {
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
  return {
    directory,
    build,
  };
}

async function packageCommand(rest: string[]): Promise<number> {
  const [channel, ...tail] = rest;
  if (!channel) {
    throw new Error(
      "package requires a channel, e.g. bunaway package win-direct.",
    );
  }
  const { directory, build } = parsePackageArguments(tail);
  const report = await packageProject(directory, channel, {
    build,
  });
  return report.ok ? 0 : 1;
}

async function pluginCommand(rest: string[]): Promise<number> {
  const [action, argument, ...extra] = rest;
  const usage = "Usage: bunaway plugin build [directory] | plugin new <name>.";
  if (extra.length || argument?.startsWith("--")) {
    throw new Error(usage);
  }
  if (action === "build") {
    console.log(`Built ${await buildNativePlugin(argument ?? ".")}`);
    return 0;
  }
  if (action === "new" && argument) {
    const files = await createNativePlugin(argument);
    console.log(
      `Created ${files.length} files for plugins/${argument}\nNext: run bun install, then replace the ping operation and its page.`,
    );
    return 0;
  }
  throw new Error(usage);
}

/**
 * Parse `[directory]` and, for `run` only, one `valueFlag <value>` pair in any order.
 * `accepts` rejects values the platform tool cannot use.
 */
function parseMobileArguments(
  action: "sync" | "build" | "run",
  options: string[],
  valueFlag: string,
  accepts: (value: string) => boolean,
  usage: string,
): {
  directory: string;
  value: string | undefined;
} {
  let directory = ".";
  let directorySeen = false;
  let value: string | undefined;
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (option === valueFlag && action === "run" && value === undefined) {
      value = options[++index];
      if (!value || !accepts(value)) {
        throw new Error(usage);
      }
    } else if (option && !option.startsWith("--") && !directorySeen) {
      directory = option;
      directorySeen = true;
    } else {
      throw new Error(usage);
    }
  }
  return {
    directory,
    value,
  };
}

function isMobileAction(
  action: string | undefined,
): action is "sync" | "build" | "run" {
  return action === "sync" || action === "build" || action === "run";
}

async function androidCommand(rest: string[]): Promise<number> {
  const [action, ...options] = rest;
  const usage =
    "Usage: bunaway android sync [directory] | android build [directory] | android run [directory] --serial <device>.";
  if (!isMobileAction(action)) {
    throw new Error(usage);
  }
  const { directory, value: serial } = parseMobileArguments(
    action,
    options,
    "--serial",
    isAndroidSerial,
    usage,
  );
  if (action === "sync") {
    console.log(`Synced ${await syncAndroidProject(directory)}`);
  } else if (action === "build") {
    console.log(`Built ${(await buildAndroidProject(directory)).apk}`);
  } else {
    if (!serial) {
      throw new Error(usage);
    }
    await runAndroidProject(directory, serial);
  }
  return 0;
}

async function iosCommand(rest: string[]): Promise<number> {
  const [action, ...options] = rest;
  const usage =
    "Usage: bunaway ios sync [directory] | ios build [directory] | ios run [directory] --device <Simulator UUID>.";
  if (!isMobileAction(action)) {
    throw new Error(usage);
  }
  const { directory, value: device } = parseMobileArguments(
    action,
    options,
    "--device",
    () => true,
    usage,
  );
  if (action === "sync") {
    console.log(`Synced ${await syncIosProject(directory)}`);
  } else if (action === "build") {
    console.log(`Built ${(await buildIosProject(directory)).app}`);
  } else {
    if (!device) {
      throw new Error(usage);
    }
    await runIosProject(directory, device);
  }
  return 0;
}

/** Check the project's framework pins, writing package.json only with `--write`. */
async function upgradeCommand(rest: string[]): Promise<number> {
  const operands = rest.filter((argument) => argument !== "--write");
  const writes = rest.length - operands.length;
  if (
    operands.length > 1 ||
    writes > 1 ||
    operands.some((argument) => argument.startsWith("-"))
  ) {
    throw new Error("Usage: bunaway upgrade [directory] [--write]");
  }
  return upgradeProject(operands[0] ?? ".", writes === 1);
}

/** Commands that take one optional project directory. */
async function projectCommand(
  command: string,
  rest: string[],
): Promise<number> {
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
    case "contract":
      process.stdout.write(await contractListText(directory ?? "."));
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

/** Run a CLI command and return its process exit code. */
export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "help") {
    console.log(help);
    return 0;
  }
  switch (command) {
    case "create":
      return createCommand(rest);
    case "package":
      return packageCommand(rest);
    case "dev": {
      const { directory, ...options } = parseDevArguments(rest);
      await devProject(directory, options);
      return 0;
    }
    case "upgrade":
      return upgradeCommand(rest);
    case "plugin":
      return pluginCommand(rest);
    case "android":
      return androidCommand(rest);
    case "ios":
      return iosCommand(rest);
    default:
      return projectCommand(command, rest);
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

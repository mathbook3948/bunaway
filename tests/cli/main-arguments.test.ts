import { expect, test } from "bun:test";
import { main } from "#cli/main";

const createUsage =
  "Usage: bunaway create <directory> [--template vanilla|vite|react|vue|svelte] [--package-dir <tarball-directory>].";
const androidUsage =
  "Usage: bunaway android sync [directory] | android build [directory] | android run [directory] --serial <device>.";
const iosUsage =
  "Usage: bunaway ios sync [directory] | ios build [directory] | ios run [directory] --device <Simulator UUID>.";
const pluginUsage =
  "Usage: bunaway plugin build [directory] | plugin new <name>.";

/** Argument errors are reported before any command runs, so no project or tool is touched. */
async function rejects(args: string[], message: string) {
  await expect(main(args)).rejects.toThrow(message);
}

test("create rejects a missing directory, repeated, unknown or valueless options and unknown templates", async () => {
  for (const args of [
    [
      "create",
    ],
    [
      "create",
      "--template",
    ],
    [
      "create",
      "app",
      "--template",
    ],
    [
      "create",
      "app",
      "--template",
      "--package-dir",
    ],
    [
      "create",
      "app",
      "--template",
      "react",
      "--template",
      "vue",
    ],
    [
      "create",
      "app",
      "--unknown",
      "value",
    ],
    [
      "create",
      "app",
      "--template",
      "angular",
    ],
  ]) {
    await rejects(args, createUsage);
  }
});

test("package reports a missing channel, unknown options and extra directories", async () => {
  await rejects(
    [
      "package",
    ],
    "package requires a channel",
  );
  await rejects(
    [
      "package",
      "win-direct",
      "--unknown",
    ],
    "Unknown option: --unknown. Use --help.",
  );
  await rejects(
    [
      "package",
      "win-direct",
      "one",
      "two",
    ],
    "Unexpected extra argument. Use --help.",
  );
});

test("plugin accepts only build [directory] and new <name> without extra arguments or flags", async () => {
  for (const args of [
    [
      "plugin",
    ],
    [
      "plugin",
      "new",
    ],
    [
      "plugin",
      "unknown",
    ],
    [
      "plugin",
      "build",
      "one",
      "two",
    ],
    [
      "plugin",
      "build",
      "--flag",
    ],
  ]) {
    await rejects(args, pluginUsage);
  }
});

test("android and iOS validate the action, one directory and a run-only device flag before running", async () => {
  for (const [platform, usage, flag] of [
    [
      "android",
      androidUsage,
      "--serial",
    ],
    [
      "ios",
      iosUsage,
      "--device",
    ],
  ] as const) {
    for (const args of [
      [
        platform,
      ],
      [
        platform,
        "unknown",
      ],
      [
        platform,
        "sync",
        flag,
        "device",
      ],
      [
        platform,
        "build",
        flag,
        "device",
      ],
      [
        platform,
        "run",
      ],
      [
        platform,
        "run",
        "dir",
      ],
      [
        platform,
        "run",
        flag,
      ],
      [
        platform,
        "run",
        flag,
        "device",
        flag,
        "other",
      ],
      [
        platform,
        "sync",
        "one",
        "two",
      ],
      [
        platform,
        "sync",
        "--unknown",
      ],
    ]) {
      await rejects(args, usage);
    }
  }
  await rejects(
    [
      "android",
      "run",
      "--serial",
      "bad serial!",
    ],
    androidUsage,
  );
});

test("project commands reject extra arguments, flags and unknown commands", async () => {
  await rejects(
    [
      "validate",
      "one",
      "two",
    ],
    "Unexpected argument. Use --help.",
  );
  await rejects(
    [
      "doctor",
      "--flag",
    ],
    "Unexpected argument. Use --help.",
  );
  await rejects(
    [
      "unknown",
    ],
    "Unknown command: unknown. Use --help.",
  );
});

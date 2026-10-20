import { expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunawayError } from "@bunaway/protocol";
import {
  checkRelaunchArguments,
  type MacosHostLaunch,
  RelaunchIntent,
  relaunchCommand,
  startRelaunch,
} from "#native/macos/bun/relaunch";
import { deadline, waitFor } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("childStep"));

const host: MacosHostLaunch = {
  executablePath: "/Applications/Demo.app/Contents/MacOS/demo",
  args: [
    "--package",
    "/Applications/Demo.app/Contents/Resources",
  ],
  cwd: "/tmp",
  env: {
    HOME: "/Users/demo",
  },
};

test("the replacement is the app's own executable and arguments behind a wait on the previous pid", () => {
  const command = relaunchCommand(host, 4242);
  expect(command.executable).toBe("/bin/sh");
  // Everything after the script is data for `exec "$@"`: pid, executable, then its arguments.
  expect(command.args.slice(3)).toEqual([
    "4242",
    host.executablePath,
    ...host.args,
  ]);
  expect(command.cwd).toBe("/tmp");
  expect(command.env).toEqual(host.env);
});

test("an app cannot add arguments or change the executable of the replacement", () => {
  expect(() => checkRelaunchArguments(undefined)).not.toThrow();
  expect(() => checkRelaunchArguments([])).not.toThrow();
  for (const argv of [
    [
      "--flag",
    ],
    [
      "",
    ],
  ]) {
    try {
      checkRelaunchArguments(argv);
      throw new Error("expected INVALID_ARGUMENT");
    } catch (error) {
      expect(error).toBeInstanceOf(BunawayError);
      expect((error as BunawayError).code).toBe("INVALID_ARGUMENT");
    }
  }
});

/** Runs the real wait script with a shell script standing in for the app. */
async function relaunchInto(
  directory: string,
  previous: {
    pid: number;
  },
  extra: readonly string[],
) {
  const marker = join(directory, "started");
  // Records the arguments one per line and the time it started.
  const app = join(directory, "app.sh");
  await Bun.write(
    app,
    `#!/bin/sh\nfor argument in "$@"; do printf '%s\\n' "$argument"; done > "${marker}.tmp"\nmv "${marker}.tmp" "${marker}"\n`,
  );
  await chmod(app, 0o755);
  const command = relaunchCommand(
    {
      executablePath: app,
      args: extra,
      cwd: directory,
      env: {
        PATH: process.env.PATH,
      },
    },
    previous.pid,
  );
  await startRelaunch(command);
  return marker;
}

// The wait wrapper is POSIX `sh`, which exists on macOS and Linux but not on Windows runners.
test.skipIf(process.platform === "win32")(
  "the replacement starts only after the previous process is gone, with arguments unparsed",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "bunaway-relaunch-"));
    try {
      const previous = Bun.spawn(
        [
          "/bin/sleep",
          "30",
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const hostile = [
        "a b",
        "$(touch injected)",
        "; touch injected",
        "'quoted'",
        "",
      ];
      const marker = await relaunchInto(directory, previous, hostile);
      // The previous process is alive, so the replacement must still be waiting.
      await Bun.sleep(400);
      expect(await Bun.file(marker).exists()).toBe(false);
      previous.kill();
      await previous.exited;
      await waitFor(() => Bun.file(marker).exists(), {
        deadline: "childStep",
        what: "the replacement to start after the previous process exited",
      });
      // One argument per line, exactly as given; nothing was run by the shell.
      expect((await readFile(marker, "utf8")).split("\n")).toEqual([
        ...hostile,
        "",
      ]);
      expect(await Bun.file(join(directory, "injected")).exists()).toBe(false);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a replacement that cannot be created rejects instead of failing silently",
  async () => {
    await expect(
      startRelaunch({
        executable: "/nonexistent/bunaway-relaunch",
        args: [],
        cwd: tmpdir(),
        env: {},
      }),
    ).rejects.toThrow();
  },
);

test("a signal or session end cancels a relaunch whenever it arrives", () => {
  const intent = new RelaunchIntent();
  expect(intent.pending).toBe(false);
  intent.request(true);
  expect(intent.pending).toBe(true);
  // The cancel can follow the backend's final packet or precede it.
  intent.cancel();
  expect(intent.pending).toBe(false);
  intent.request(true);
  expect(intent.pending).toBe(false);
  const early = new RelaunchIntent();
  early.cancel();
  early.request(true);
  expect(early.pending).toBe(false);
});

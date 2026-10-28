import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadline, waitFor } from "../fixtures/deadlines.ts";
import {
  canonicalPath,
  newShellTestName,
  registerShellExtension,
  registerShellScheme,
  shellCommand,
  shellOpen,
} from "../fixtures/windows-shell-registration.ts";

setDefaultTimeout(deadline("nativeFixture"));

/**
 * The registered command starts this script, which writes what it received to the file named by
 * its first argument. Writing to a temporary name and renaming keeps the reader from seeing a
 * partial file.
 */
const RECORDER = `import { renameSync, writeFileSync } from "node:fs";
const [out, ...argv] = process.argv.slice(2);
writeFileSync(out + ".part", JSON.stringify({ argv, cwd: process.cwd() }));
renameSync(out + ".part", out);
`;

type Received = {
  argv: string[];
  cwd: string;
};

type Workspace = {
  dir: string;
  recorder: string;
  command: (out: string) => string;
};

/**
 * Makes a directory holding the recorder script. `command(out)` is the registered command that
 * runs it with Bun, passing `out` and then the shell's `%1`.
 */
async function createWorkspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "bw-shell-"));
  const recorder = join(dir, "recorder.ts");
  await writeFile(recorder, RECORDER);
  return {
    dir,
    recorder,
    command: (out) =>
      shellCommand(process.execPath, "--no-env-file", recorder, out),
  };
}

/** Waits for the recorder to report, then returns what the registered command received. */
async function readReceived(out: string): Promise<Received> {
  return waitFor(
    () => (existsSync(out) ? readFileSync(out, "utf8") : undefined),
    {
      deadline: "childStep",
      what: "the shell-started command to record its arguments",
      intervalMs: 50,
    },
  ).then((text) => JSON.parse(text) as Received);
}

/** Registers a scheme, opens `url` through the shell and returns what the command received. */
async function activateUrl(makeUrl: (scheme: string) => string): Promise<{
  url: string;
  received: Received;
  workingDirectory: string;
}> {
  const space = await createWorkspace();
  const scheme = newShellTestName();
  const out = join(space.dir, "received.json");
  const unregister = await registerShellScheme(scheme, space.command(out));
  const url = makeUrl(scheme);
  try {
    await shellOpen(url, space.dir);
    return {
      url,
      received: await readReceived(out),
      workingDirectory: space.dir,
    };
  } finally {
    await unregister();
    await rm(space.dir, {
      recursive: true,
      force: true,
    });
  }
}

// Each URL reaches the command as exactly one argument, with the characters a shell or a command
// line parser treats specially left unchanged.
const URL_CASES: [
  name: string,
  url: (scheme: string) => string,
][] = [
  [
    "an ampersand and an equals sign",
    (scheme) => `${scheme}://host/path?a=1&b=2`,
  ],
  [
    "percent escapes",
    (scheme) => `${scheme}://host/a%20b/%41%25?q=%7Bx%7D`,
  ],
  [
    "non-ASCII characters",
    (scheme) => `${scheme}://host/${encodeURI("한글")}/😀?q=한글`,
  ],
  [
    "a caret, an exclamation mark and a percent variable name",
    (scheme) => `${scheme}://host/%PATH%/^x!y`,
  ],
  [
    "a trailing backslash",
    (scheme) => `${scheme}://host/path\\`,
  ],
];

for (const [name, url] of URL_CASES) {
  test.skipIf(process.platform !== "win32")(
    `the shell passes a registered scheme URL with ${name} as one unchanged argument`,
    async () => {
      const { url: opened, received } = await activateUrl(url);
      expect(received.argv).toEqual([
        opened,
      ]);
    },
  );
}

test.skipIf(process.platform !== "win32")(
  "the shell starts a registered scheme command in the working directory it was given",
  async () => {
    const { received, workingDirectory } = await activateUrl(
      (scheme) => `${scheme}://host/cwd`,
    );
    expect(canonicalPath(received.cwd)).toBe(canonicalPath(workingDirectory));
  },
);

test.skipIf(process.platform !== "win32")(
  "a double quote in a scheme URL does not split it into extra arguments",
  async () => {
    const { received } = await activateUrl(
      (scheme) => `${scheme}://host/a"b --extra "c`,
    );
    // Whatever the shell does with the quote (escape or encode it), the command receives one
    // argument, so a URL cannot inject options into the app.
    expect(received.argv).toHaveLength(1);
  },
);

// File names the shell opens through an extension association: spaces, an ampersand, percent
// signs, a variable-like name and non-ASCII characters.
const FILE_NAMES = [
  "plain.txt",
  "with space & ampersand.txt",
  "100% done.txt",
  "%PATH% ^caret !bang.txt",
  "한글 😀 파일.txt",
];

for (const fileName of FILE_NAMES) {
  test.skipIf(process.platform !== "win32")(
    `the shell passes the associated file "${fileName}" as one unchanged path`,
    async () => {
      const space = await createWorkspace();
      const extension = `.${newShellTestName()}`;
      const nested = join(space.dir, "dir with space");
      await mkdir(nested);
      const file = join(nested, fileName.replace(".txt", extension));
      await writeFile(file, "x");
      const out = join(space.dir, "received.json");
      const unregister = await registerShellExtension(
        extension,
        space.command(out),
      );
      try {
        await shellOpen(file, space.dir);
        const { argv } = await readReceived(out);
        expect(argv).toHaveLength(1);
        expect(canonicalPath(argv[0] ?? "")).toBe(canonicalPath(file));
      } finally {
        await unregister();
        await rm(space.dir, {
          recursive: true,
          force: true,
        });
      }
    },
  );
}

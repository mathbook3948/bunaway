import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { deadline } from "../fixtures/deadlines.ts";
import { recycledItem } from "../fixtures/windows-recycle-bin.ts";

setDefaultTimeout(deadline("build"));

const EXPLORER_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion";
const POLICY_KEY = `${EXPLORER_KEY}\\Policies\\Explorer`;
const BIN_VOLUME_KEY = `${EXPLORER_KEY}\\Explorer\\BitBucket\\Volume`;
const MEBIBYTE = 1024 * 1024;
const REFUSED = [
  "UNSUPPORTED",
];
// A file over the bin capacity makes the shell ask whether to delete it permanently. The adapter
// keeps that warning (FOF_WANTNUKEWARNING), so with nobody to answer it the call is still pending.
const REFUSED_OR_WARNING = [
  "UNSUPPORTED",
  "waiting",
];

type RegistryValue = {
  key: string;
  name: string;
};

function reg(...args: string[]) {
  return Bun.spawnSync([
    "reg.exe",
    ...args,
  ]);
}

/** Read one DWORD value, or null when the key or the value does not exist. */
function readDword({ key, name }: RegistryValue): number | null {
  const result = reg("query", key, "/v", name);
  if (result.exitCode !== 0) {
    return null;
  }
  const match = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(result.stdout.toString());
  return match?.[1] ? Number.parseInt(match[1], 16) : null;
}

function writeDword({ key, name }: RegistryValue, value: number): void {
  const result = reg(
    "add",
    key,
    "/v",
    name,
    "/t",
    "REG_DWORD",
    "/d",
    String(value),
    "/f",
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function deleteValue({ key, name }: RegistryValue): void {
  const result = reg("delete", key, "/v", name, "/f");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

/**
 * Set a Recycle Bin setting for the duration of `run` and put the previous state back, including
 * the absence of the value. The test only touches HKCU values of the current user.
 */
async function withDword(
  value: RegistryValue,
  next: number,
  run: () => Promise<void>,
): Promise<void> {
  const previous = readDword(value);
  writeDword(value, next);
  try {
    await run();
  } finally {
    if (previous === null) {
      deleteValue(value);
    } else {
      writeDword(value, previous);
    }
  }
}

/** The `{GUID}` of the volume that holds `path`, which names the volume's Recycle Bin settings. */
function volumeGuid(path: string): string {
  const result = Bun.spawnSync([
    "mountvol.exe",
    parse(path).root,
    "/L",
  ]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const match = /Volume(\{[0-9a-f-]+\})/i.exec(result.stdout.toString());
  if (!match?.[1]) {
    throw new Error(`No volume GUID in mountvol output: ${result.stdout}`);
  }
  return match[1];
}

/**
 * Run `opener.trashFile` in a new Bun process, because the shell keeps the Recycle Bin settings it
 * first read for the life of a process. Resolves to `ok`, the error code the call failed with, or
 * `waiting` when the call was still running at the deadline, which is how a shell warning that
 * waits for a user answer looks to a session nobody can click in. The child is killed then.
 */
async function trashInFreshProcess(
  root: string,
  path: string,
): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "windows-trash-limits.fixture.ts"),
      root,
      path,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let waiting = false;
  const timer = setTimeout(() => {
    waiting = true;
    child.kill();
  }, deadline("childStep"));
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (waiting) {
      return "waiting";
    }
    expect(code, stderr + stdout).toBe(0);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a file in a directory of this test, ask Windows to recycle it while `configure` has
 * changed the bin settings, and check that nothing was lost: the call fails, the file stays where
 * it was and the bin holds no copy. `accepted` lists the outcomes of the call that keep the file.
 */
async function expectRefused(
  label: string,
  size: number,
  accepted: string[],
  configure: (volume: string, run: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const root = resolve("build", `windows-trash-limits-${crypto.randomUUID()}`);
  await mkdir(root, {
    recursive: true,
  });
  const sample = join(root, `${label}.bin`);
  await writeFile(sample, Buffer.alloc(size, 7));
  try {
    let outcome = "";
    await configure(volumeGuid(sample), async () => {
      outcome = await trashInFreshProcess(root, sample);
    });
    expect(accepted).toContain(outcome);
    expect((await stat(sample)).size).toBe(size);
    expect(await recycledItem(sample)).toBeUndefined();
  } finally {
    // If the refusal regressed and the file reached the bin, remove only this test's entry.
    const leaked = await recycledItem(sample);
    if (leaked) {
      await rm(leaked.data, {
        force: true,
      });
      await rm(leaked.info, {
        force: true,
      });
    }
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}

test.skipIf(process.platform !== "win32")(
  "Windows trashFile refuses and keeps the file when the policy turns the Recycle Bin off",
  async () => {
    await expectRefused("policy-off", 16, REFUSED, async (_volume, run) => {
      await withDword(
        {
          key: POLICY_KEY,
          name: "NoRecycleFiles",
        },
        1,
        run,
      );
    });
  },
);

test.skipIf(process.platform !== "win32")(
  "Windows trashFile refuses and keeps the file when the volume deletes files permanently",
  async () => {
    await expectRefused("volume-nuke", 16, REFUSED, async (volume, run) => {
      await withDword(
        {
          key: `${BIN_VOLUME_KEY}\\${volume}`,
          name: "NukeOnDelete",
        },
        1,
        run,
      );
    });
  },
);

test.skipIf(process.platform !== "win32")(
  "Windows trashFile refuses and keeps a file larger than the Recycle Bin capacity",
  async () => {
    await expectRefused(
      "over-capacity",
      3 * MEBIBYTE,
      REFUSED_OR_WARNING,
      async (volume, run) => {
        await withDword(
          {
            key: `${BIN_VOLUME_KEY}\\${volume}`,
            name: "MaxCapacity",
          },
          1,
          run,
        );
      },
    );
  },
);

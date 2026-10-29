import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type DeadlineName, deadline } from "../fixtures/deadlines.ts";
import { seedWindowsBuildCaches } from "./windows-project-caches.ts";

/**
 * Generates the vanilla template with the packed CLI inside a project folder whose path has a
 * space and Korean characters, builds it into a compiled EXE with `bunaway build` and starts the
 * EXE with a `LOCALAPPDATA` that has the same kind of path. A probe appended to the UI entry saves
 * and reads a message through the backend and closes the window, so exit code 0 and the message
 * file under the Unicode `LOCALAPPDATA` show that the CLI's path handling (argument splitting,
 * the ASCII-only `--compile-executable-path` workaround, file URLs) and the compiled app work
 * from such a folder.
 *
 * Not covered here: installers, signing, the dev server, 8.3 short names and paths beyond MAX_PATH.
 */
assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const helper = resolve(
  root,
  ".claude/skills/verify-bunaway/scripts/verify-bunaway.ts",
);
const home = resolve(root, `build/windows-project-path-${crypto.randomUUID()}`);
/** A user folder and a project folder name, each with a space and Korean characters. */
const PROJECT_PARENT = resolve(home, "홍 길동", "내 프로젝트");
const APP = resolve(PROJECT_PARENT, "앱 이름");
const LOCAL_APP_DATA = resolve(home, "홍 길동", "로컬 데이터");
const COMPILED_PROBE_MESSAGE = "한글 경로 확인";
const COMPILED_PROBE = `
import { client as compiledProbeClient } from "./client.ts";
void (async () => {
  await compiledProbeClient.invoke("message.save", "${COMPILED_PROBE_MESSAGE}");
  if ((await compiledProbeClient.invoke("message.read", null)) !== "${COMPILED_PROBE_MESSAGE}") {
    throw new Error("compiled path probe: message did not round-trip");
  }
  window.close();
})();
`;
const UI_ENTRIES = [
  "src/main.ts",
  "src/main.tsx",
] as const;
/** The smallest size a compiled Bun host can have; a stub or empty file is far below it. */
const MIN_COMPILED_EXE_BYTES = 10_000_000;
/** Packing the framework and a cold install take several times the generic build deadline. */
const SETUP_DEADLINE_SCALE = 3;
const REMOVE_RETRIES = 5;
const REMOVE_RETRY_DELAY_MS = 500;
const OUTPUT_TAIL_CHARS = 4_000;
const NON_ASCII = /[^ -~]/;

/** Ends a process and every child it started; a failed `taskkill` is bounded and logged. */
async function killTree(pid: number): Promise<void> {
  const killer = Bun.spawn(
    [
      "taskkill",
      "/PID",
      String(pid),
      "/T",
      "/F",
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const finished = await Promise.race([
    killer.exited.then(() => true),
    Bun.sleep(deadline("childExit")).then(() => false),
  ]);
  if (!finished) {
    killer.kill();
    console.log(`taskkill for process ${pid} did not finish`);
  }
}

/** Runs `command` within the named deadline; on timeout the whole process tree is killed. */
async function execute(
  step: string,
  command: string[],
  cwd: string,
  limit: DeadlineName,
  scale = 1,
  env?: Record<string, string | undefined>,
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    ...(env === undefined
      ? {}
      : {
          env,
        }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const finished = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const settled = await Promise.race([
    finished,
    Bun.sleep(deadline(limit) * scale).then(() => undefined),
  ]);
  if (settled === undefined) {
    await killTree(child.pid);
    throw new Error(`${step} timed out after ${deadline(limit) * scale} ms`);
  }
  const [out, err, code] = settled;
  assert.equal(
    code,
    0,
    `${step} exited with ${code}:\n${`${out}\n${err}`.slice(-OUTPUT_TAIL_CHARS)}`,
  );
  console.log(`PASS ${step}`);
}

const helperCommand = (...args: string[]) => [
  process.execPath,
  helper,
  ...args,
];

type Settings = {
  app: {
    appId: string;
  };
  build: {
    command?: string[];
  };
};

/** Replaces the `bun` program name with this run's pinned Bun, as the CLI does. */
function pinnedBun(command: string[]): string[] {
  const [program, ...rest] = command;
  assert(program !== undefined, "an empty command in bunaway.json");
  return [
    program === "bun" ? process.execPath : program,
    ...rest,
  ];
}

/** The paths this test hands to the CLI and the app have to contain what it claims to test. */
function assertUnicodePaths(): void {
  for (const path of [
    APP,
    LOCAL_APP_DATA,
  ]) {
    assert(path.includes(" "), `${path} has no space`);
    assert(NON_ASCII.test(path), `${path} has no non-ASCII character`);
  }
}

async function verify(): Promise<void> {
  assertUnicodePaths();
  const packages = resolve(home, "packages");
  await execute(
    "pack",
    helperCommand("pack", packages),
    root,
    "packagedAudit",
    SETUP_DEADLINE_SCALE,
  );
  await mkdir(PROJECT_PARENT, {
    recursive: true,
  });
  await execute(
    "create",
    helperCommand(
      "create",
      APP,
      "--packages",
      packages,
      "--template",
      "vanilla",
    ),
    root,
    "packagedAudit",
    SETUP_DEADLINE_SCALE,
  );
  const settings = JSON.parse(
    await readFile(resolve(APP, "src-bunaway/bunaway.json"), "utf8"),
  ) as Settings;
  if (settings.build.command !== undefined) {
    await execute("web-build", pinnedBun(settings.build.command), APP, "build");
  }
  const entry = UI_ENTRIES.map((name) => resolve(APP, name)).find((path) =>
    existsSync(path),
  );
  assert(entry !== undefined, `no UI entry among ${UI_ENTRIES.join(", ")}`);
  await appendFile(entry, COMPILED_PROBE);
  await seedWindowsBuildCaches(APP, root);
  await execute(
    "build",
    [
      process.execPath,
      "run",
      "build",
    ],
    APP,
    "packagedAudit",
    SETUP_DEADLINE_SCALE,
  );
  const appId = settings.app.appId;
  const executable = resolve(APP, "dist/windows-x64", `${appId}.exe`);
  const size = existsSync(executable) ? (await stat(executable)).size : 0;
  assert(
    size >= MIN_COMPILED_EXE_BYTES,
    `${executable} is missing or too small (${size} bytes)`,
  );
  await execute(
    "launch",
    [
      executable,
    ],
    home,
    "packagedAudit",
    1,
    {
      ...process.env,
      BUN_OPTIONS: undefined,
      LOCALAPPDATA: LOCAL_APP_DATA,
    },
  );
  // A second instance of the same app forwards to the running one and exits 0 without running
  // the probe, so the saved message, not the exit code alone, shows that this EXE ran it.
  const saved = resolve(
    LOCAL_APP_DATA,
    "bunaway",
    appId,
    "data/messages/current.txt",
  );
  assert(
    existsSync(saved) &&
      (await readFile(saved, "utf8")) === COMPILED_PROBE_MESSAGE,
    `the EXE exited 0 but the probe's message is not in ${saved}`,
  );
}

await mkdir(home, {
  recursive: true,
});
try {
  await verify();
} finally {
  // Only the folder this run created is removed; a handle that is still open fails the run.
  await rm(home, {
    recursive: true,
    force: true,
    maxRetries: REMOVE_RETRIES,
    retryDelay: REMOVE_RETRY_DELAY_MS,
  });
}
console.log("PASS: Windows project path verification");

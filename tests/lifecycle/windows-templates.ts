import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type DeadlineName, deadline } from "../fixtures/deadlines.ts";

/**
 * Generates every UI template with the packed CLI on Windows and drives it the way a developer's
 * first session does: `doctor`, the backend over the host process protocol, the web dev server
 * (templates that have one) and the web build that `bunaway build` runs before packaging. Each
 * template runs through the verification helper, so the helper and the template are exercised
 * together. A failing step does not stop the other templates; the run fails at the end and
 * `build/windows-templates-results.json`, which the native job uploads, lists every step.
 *
 * Not covered here: the native window and WebView2 (the other native fixtures run them), HMR edits
 * and installer packaging.
 */
assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const helper = resolve(
  root,
  ".claude/skills/verify-bunaway/scripts/verify-bunaway.ts",
);
const home = resolve(root, `build/windows-templates-${crypto.randomUUID()}`);
const report = resolve(root, "build/windows-templates-results.json");
/** `vanilla` serves static files and has no dev server, so its web step is skipped. */
const TEMPLATES = [
  "vanilla",
  "vite",
  "react",
  "vue",
  "svelte",
] as const;

type StepResult = {
  template: string;
  step: string;
  ok: boolean;
  durationMs: number;
  /** Combined output tail, kept only for a failed step. */
  output?: string | undefined;
};

const results: StepResult[] = [];
/** How much of a failed step's output the report keeps. */
const OUTPUT_TAIL_CHARS = 4_000;

/** Ends a process and every child it started; `Subprocess.kill` alone leaves a dev server behind. */
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
  await killer.exited;
}

/**
 * Ends every process whose command line mentions `directory`. The helper stops the dev server it
 * starts, but `bun run dev:web` launches Vite as a child and a parent kill can leave Vite running
 * with the project's files open, which would make the project removal fail.
 */
async function stopProcessesUnder(directory: string): Promise<void> {
  const escaped = directory.replaceAll("'", "''");
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  const cleanup = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await cleanup.exited;
}

/**
 * Runs `command` to completion. When `limit` passes the whole process tree is killed, so a hung
 * install or dev server cannot outlive the step and hold files that `rm` needs afterwards.
 */
async function execute(
  command: string[],
  cwd: string,
  limit: DeadlineName,
  scale = 1,
): Promise<{
  code: number;
  output: string;
  timedOut: boolean;
}> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killTree(child.pid);
  }, deadline(limit) * scale);
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      code,
      output: `${out}\n${err}`,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Records one step of one template; the output is kept only when the step failed. */
async function step(
  template: string,
  name: string,
  command: string[],
  cwd: string,
  limit: DeadlineName,
  scale = 1,
): Promise<boolean> {
  const started = Date.now();
  const { code, output, timedOut } = await execute(command, cwd, limit, scale);
  const ok = code === 0 && !timedOut;
  results.push({
    template,
    step: name,
    ok,
    durationMs: Date.now() - started,
    output: ok
      ? undefined
      : `${timedOut ? "timed out\n" : ""}${output.slice(-OUTPUT_TAIL_CHARS)}`,
  });
  console.log(`${ok ? "PASS" : "FAIL"} ${template} ${name}`);
  if (!ok) {
    console.log(output.slice(-OUTPUT_TAIL_CHARS));
  }
  return ok;
}

const helperCommand = (...args: string[]) => [
  process.execPath,
  helper,
  ...args,
];

/** Runs the web build the template configures, the same command `bunaway build` runs first. */
async function webBuild(template: string, app: string): Promise<boolean> {
  const settings = JSON.parse(
    await readFile(resolve(app, "src-bunaway/bunaway.json"), "utf8"),
  ) as {
    build: {
      command?: string[];
    };
  };
  const command = settings.build.command;
  if (command === undefined) {
    return true;
  }
  const [program, ...rest] = command;
  return step(
    template,
    "web-build",
    [
      program === "bun" ? process.execPath : (program ?? ""),
      ...rest,
    ],
    app,
    "build",
  );
}

await mkdir(home, {
  recursive: true,
});
const packages = resolve(home, "packages");
const packed = await step(
  "all",
  "pack",
  helperCommand("pack", packages),
  root,
  "packagedAudit",
  3,
);
if (packed) {
  for (const template of TEMPLATES) {
    const app = resolve(home, template);
    const evidence = resolve(home, `evidence-${template}`);
    try {
      const created = await step(
        template,
        "create",
        helperCommand(
          "create",
          app,
          "--packages",
          packages,
          "--template",
          template,
        ),
        root,
        "packagedAudit",
        3,
      );
      if (!created) {
        continue;
      }
      await step(
        template,
        "doctor",
        helperCommand("doctor", app),
        root,
        "toolchain",
      );
      await step(
        template,
        "backend",
        helperCommand("backend", app, "--evidence", evidence),
        root,
        "toolchain",
      );
      if (template !== "vanilla") {
        await step(
          template,
          "web",
          helperCommand("web", app, "--evidence", evidence),
          root,
          "toolchain",
        );
      }
      await webBuild(template, app);
    } finally {
      await stopProcessesUnder(app);
      // A project that cannot be removed (a handle still open) is scratch space under build/, so
      // it is reported but does not hide the step results.
      await rm(app, {
        recursive: true,
        force: true,
      }).catch((error: unknown) => {
        console.log(`could not remove ${app}: ${String(error)}`);
      });
    }
  }
}
await writeFile(report, `${JSON.stringify(results, null, 2)}\n`);
const failed = results.filter((result) => !result.ok);
assert.equal(
  failed.length,
  0,
  `Failed steps: ${failed.map((result) => `${result.template}/${result.step}`).join(", ")}`,
);
console.log("PASS: Windows template verification");

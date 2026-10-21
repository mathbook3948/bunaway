import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type DeadlineName, deadline } from "../fixtures/deadlines.ts";

/**
 * Generates every UI template with the packed CLI on Windows and drives it the way a developer's
 * first session does, in this order: the web build the template configures, `doctor`, the backend
 * over the host process protocol and the web dev server (templates that have one). Generation,
 * `doctor` and the backend run through the verification helper; the dev server is started here so
 * this file owns its whole process tree. A failing step does not stop the other templates; the run
 * fails at the end and `build/windows-templates-results.json`, which the native job uploads, lists
 * every step.
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
/** The marker the Vite dev server puts in every page it serves. */
const VITE_CLIENT_MARKER = 'src="/@vite/client"';
/** Packing the framework and a cold install take several times the generic build deadline. */
const SETUP_DEADLINE_SCALE = 3;
/** How much of a failed step's output the report keeps. */
const OUTPUT_TAIL_CHARS = 4_000;
/** Attempts and pause when removing a project whose files a stopped process still holds. */
const REMOVE_RETRIES = 5;
const REMOVE_RETRY_DELAY_MS = 500;
/** Pause between requests while the dev server starts. */
const DEV_SERVER_POLL_MS = 250;

type StepResult = {
  template: string;
  step: string;
  ok: boolean;
  durationMs: number;
  /** Combined output tail, kept only for a failed step. */
  output?: string | undefined;
};

type Outcome = {
  ok: boolean;
  output: string;
};

const results: StepResult[] = [];

/**
 * Ends a process and every child it started; `Subprocess.kill` alone leaves a dev server behind.
 * A failed `taskkill` is logged and bounded so cleanup can never hang the run.
 */
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

/**
 * Runs `command` to completion within the named deadline. On timeout the whole process tree is
 * killed and the step fails without waiting for pipes a grandchild may hold, so its output is lost.
 */
async function execute(
  command: string[],
  cwd: string,
  limit: DeadlineName,
  scale = 1,
): Promise<Outcome> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const finished = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const expired = Bun.sleep(deadline(limit) * scale).then(() => undefined);
  const settled = await Promise.race([
    finished,
    expired,
  ]);
  if (settled === undefined) {
    await killTree(child.pid);
    return {
      ok: false,
      output: `timed out after ${deadline(limit) * scale} ms`,
    };
  }
  const [out, err, code] = settled;
  return {
    ok: code === 0,
    output: `${out}\n${err}`,
  };
}

/** Records one step of one template; the output is kept only when the step failed. */
async function record(
  template: string,
  name: string,
  run: () => Promise<Outcome>,
): Promise<boolean> {
  const started = Date.now();
  let outcome: Outcome;
  try {
    outcome = await run();
  } catch (error) {
    outcome = {
      ok: false,
      output:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  }
  const tail = outcome.output.slice(-OUTPUT_TAIL_CHARS);
  results.push({
    template,
    step: name,
    ok: outcome.ok,
    durationMs: Date.now() - started,
    output: outcome.ok ? undefined : tail,
  });
  console.log(`${outcome.ok ? "PASS" : "FAIL"} ${template} ${name}`);
  if (!outcome.ok) {
    console.log(tail);
  }
  return outcome.ok;
}

const helperCommand = (...args: string[]) => [
  process.execPath,
  helper,
  ...args,
];

type Settings = {
  build: {
    command?: string[];
  };
  dev?: {
    command: string[];
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

/** Runs the web build the template configures, the same command `bunaway build` runs first. */
function webBuild(command: string[], app: string): Promise<Outcome> {
  return execute(pinnedBun(command), app, "build");
}

/** Reserves a free loopback port by binding and releasing it. */
function freePort(): number {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = reservation.port;
  void reservation.stop(true);
  assert(port !== undefined, "no free port");
  return port;
}

/**
 * Starts the template's dev server on a free port and waits for a page that carries the Vite
 * client marker. The server's whole process tree is killed afterwards on every path.
 */
async function webDevServer(settings: Settings, app: string): Promise<Outcome> {
  assert(settings.dev !== undefined, "this template has no dev server");
  const port = freePort();
  const url = `http://127.0.0.1:${port}/`;
  const server = Bun.spawn(
    [
      ...pinnedBun(settings.dev.command),
      "--port",
      String(port),
      // Fail instead of moving to the next port if another process takes this one first.
      "--strictPort",
    ],
    {
      cwd: app,
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  try {
    const deadlineAt = Date.now() + deadline("toolchain");
    while (Date.now() < deadlineAt) {
      if (server.exitCode !== null) {
        return {
          ok: false,
          output: `the dev server exited with code ${server.exitCode} before answering`,
        };
      }
      try {
        // A request that connects but never answers must not outlive the step deadline.
        const response = await fetch(url, {
          signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
        });
        const html = await response.text();
        if (response.ok) {
          return {
            ok: html.includes(VITE_CLIENT_MARKER),
            output: html,
          };
        }
      } catch {
        // The server is not listening yet; the loop is bounded by the deadline.
      }
      await Bun.sleep(DEV_SERVER_POLL_MS);
    }
    return {
      ok: false,
      output: `no response from ${url} within ${deadline("toolchain")} ms`,
    };
  } finally {
    await killTree(server.pid);
    // Let the processes release their files before the project is removed.
    await Promise.race([
      server.exited,
      Bun.sleep(deadline("childExit")),
    ]);
  }
}

/** Runs every step for one template; a failed step that later steps depend on ends the sequence. */
async function verifyTemplate(
  template: string,
  packages: string,
): Promise<void> {
  const app = resolve(home, template);
  const evidence = resolve(home, `evidence-${template}`);
  try {
    const created = await record(template, "create", () =>
      execute(
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
        SETUP_DEADLINE_SCALE,
      ),
    );
    if (!created) {
      return;
    }
    const settings = JSON.parse(
      await readFile(resolve(app, "src-bunaway/bunaway.json"), "utf8"),
    ) as Settings;
    // `doctor` runs `bunaway validate`, which needs the built frontend directory to exist.
    if (settings.build.command !== undefined) {
      const built = await record(template, "web-build", () =>
        webBuild(settings.build.command ?? [], app),
      );
      if (!built) {
        return;
      }
    }
    await record(template, "doctor", () =>
      execute(helperCommand("doctor", app), root, "build"),
    );
    await record(template, "backend", () =>
      execute(
        helperCommand("backend", app, "--evidence", evidence),
        root,
        "build",
      ),
    );
    if (template !== "vanilla") {
      await record(template, "web", () => webDevServer(settings, app));
    }
  } catch (error) {
    results.push({
      template,
      step: "run",
      ok: false,
      durationMs: 0,
      output: String(error),
    });
  } finally {
    // Removal can fail while a handle is still open; that is recorded, not hidden.
    await record(template, "remove", async () => {
      await rm(app, {
        recursive: true,
        force: true,
        // Windows can keep a handle on a just-stopped process's files for a moment.
        maxRetries: REMOVE_RETRIES,
        retryDelay: REMOVE_RETRY_DELAY_MS,
      });
      return {
        ok: true,
        output: "",
      };
    });
  }
}

await mkdir(home, {
  recursive: true,
});
try {
  const packages = resolve(home, "packages");
  const packed = await record("all", "pack", () =>
    execute(
      helperCommand("pack", packages),
      root,
      "packagedAudit",
      SETUP_DEADLINE_SCALE,
    ),
  );
  if (packed) {
    for (const template of TEMPLATES) {
      await verifyTemplate(template, packages);
    }
  }
} finally {
  await writeFile(report, `${JSON.stringify(results, null, 2)}\n`);
}
const failed = results.filter((result) => !result.ok);
assert.equal(
  failed.length,
  0,
  `Failed steps: ${failed.map((result) => `${result.template}/${result.step}`).join(", ")}`,
);
console.log("PASS: Windows template verification");

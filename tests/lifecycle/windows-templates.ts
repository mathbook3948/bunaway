import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { type DeadlineName, deadline, waitFor } from "../fixtures/deadlines.ts";
import { seedWindowsBuildCaches } from "./windows-project-caches.ts";

/**
 * Generates every UI template with the packed CLI on Windows and drives it the way a developer's
 * first session does, in this order: the web build the template configures, `doctor`, the backend
 * over the host process protocol and the web dev server (templates that have one). Generation,
 * `doctor` and the backend run through the verification helper; the dev server is started here so
 * this file owns its whole process tree. After the server answers, one source file is edited and
 * the Vite HMR WebSocket must report the change, which shows that Windows file watching sees an
 * edit made by another process. The last step builds the compiled EXE with `bunaway build` and
 * starts it: a probe appended to the UI entry saves and reads a message through the backend and then
 * closes the window, so exit code 0 shows that the EXE, its bundled backend and UI assets, the real
 * host and WebView2 all started. A failing step does not stop the other templates; the run
 * fails at the end and `build/windows-templates-results.json`, which the native job uploads, lists
 * every step.
 *
 * Not covered here: the DOM an HMR update produces and installer packaging.
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
/** The text an HMR edit adds to a source file, to find in the module the server serves next. */
const HMR_EDIT_MARKER = "bunaway-hmr-edit-marker";
/**
 * The screen source each template with a dev server is edited in, and the text appended to it.
 * The appended text is code or markup that survives the transform, since comments do not. Vue
 * takes a second `<script>` block because text after `</template>` is not valid there.
 */
const HMR_EDITS: Record<
  string,
  {
    file: string;
    appended: string;
  }
> = {
  vite: {
    file: "src/main.ts",
    appended: `\nconsole.log("${HMR_EDIT_MARKER}");\n`,
  },
  react: {
    file: "src/App.tsx",
    appended: `\nexport const hmrEditMarker = "${HMR_EDIT_MARKER}";\n`,
  },
  vue: {
    file: "src/App.vue",
    appended: `\n<script lang="ts">\nexport const hmrEditMarker = "${HMR_EDIT_MARKER}";\n</script>\n`,
  },
  svelte: {
    file: "src/App.svelte",
    appended: `\n<p>${HMR_EDIT_MARKER}</p>\n`,
  },
};
/** The UI entry each template has; the compiled-EXE probe is appended to whichever exists. */
const UI_ENTRIES = [
  "src/main.ts",
  "src/main.tsx",
] as const;
const COMPILED_PROBE_MESSAGE = "compiled template check";
/**
 * Appended to the UI entry before the compiled build. It goes through the backend (save, then
 * read) and closes the window only when the message came back, so a started host that cannot reach
 * its backend or serve its UI does not end with exit code 0.
 */
const COMPILED_PROBE = `
import { client as compiledProbeClient } from "./client.ts";
void (async () => {
  await compiledProbeClient.invoke("message.save", "${COMPILED_PROBE_MESSAGE}");
  if ((await compiledProbeClient.invoke("message.read", null)) !== "${COMPILED_PROBE_MESSAGE}") {
    throw new Error("compiled template probe: message did not round-trip");
  }
  window.close();
})();
`;
/** The smallest size a compiled Bun host can have; a stub or empty file is far below it. */
const MIN_COMPILED_EXE_BYTES = 10_000_000;
/** Packing the framework and a cold install take several times the generic build deadline. */
const SETUP_DEADLINE_SCALE = 3;
/** How much of a failed step's output the report keeps. */
const OUTPUT_TAIL_CHARS = 4_000;
/** Attempts and pause when removing a project whose files a stopped process still holds. */
const REMOVE_RETRIES = 5;
const REMOVE_RETRY_DELAY_MS = 500;
/** Pause before the HMR edit is written again when the watcher has not reported it yet. */
const HMR_EDIT_RETRY_MS = 1_000;
/** How much of the received HMR messages a failure keeps. */
const HMR_MESSAGES_TAIL_CHARS = 1_500;
/** How much of a retried attempt's error is noted in the HMR messages. */
const HMR_RETRY_NOTE_CHARS = 300;
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
  app: {
    appId: string;
  };
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
 * Fetches a dev server URL within the toolchain deadline and returns its body, so a server that
 * never answers cannot outlive the step. An error status throws with the start of the body.
 */
async function moduleText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(deadline("toolchain")),
  });
  const body = await response.text();
  assert(
    response.ok,
    `${url} answered ${response.status}: ${body.slice(0, 500)}`,
  );
  return body;
}

/**
 * Edits one source file of the running project and waits for the dev server to announce it on the
 * HMR WebSocket, then checks that the module the server serves now carries the edit. A browser
 * normally requests modules first, which registers them in the server's module graph, so the
 * module is requested once before the edit. The edit stays in the temporary project, which the
 * caller removes. Resolves with a description of what was seen; throws, with the messages
 * received, when nothing arrives in time.
 */
async function verifyHmrEdit(
  template: string,
  app: string,
  origin: string,
  server: {
    exitCode: number | null;
  },
): Promise<string> {
  const edit = HMR_EDITS[template];
  assert(edit !== undefined, `no HMR edit is defined for ${template}`);
  const moduleUrl = `${origin}/${edit.file}`;
  // The client script carries the token the server requires on an HMR connection.
  const client = await moduleText(`${origin}/@vite/client`);
  const token = /wsToken\s*=\s*["']([^"']+)["']/.exec(client)?.[1];
  if (token === undefined) {
    // Connecting without it is still tried; a refusal is then reported with this context.
    console.log(`no HMR token found in the Vite client of ${template}`);
  }
  const before = await moduleText(moduleUrl);
  assert(
    !before.includes(HMR_EDIT_MARKER),
    `${edit.file} already has the marker`,
  );
  const messages: string[] = [];
  const query = token === undefined ? "" : `?token=${token}`;
  const socket = new WebSocket(
    `${origin.replace("http", "ws")}/${query}`,
    "vite-hmr",
  );
  socket.addEventListener("message", (event) => {
    messages.push(String(event.data));
  });
  // A refused upgrade or an early close would otherwise surface only as a connect timeout.
  socket.addEventListener("error", () => {
    messages.push("websocket error");
  });
  let socketClosed = false;
  socket.addEventListener("close", (event) => {
    socketClosed = true;
    messages.push(`websocket closed with code ${event.code}`);
  });
  const hmrCheckFailed = () => {
    if (server.exitCode !== null) {
      return `the dev server exited with code ${server.exitCode} during the HMR check`;
    }
    return (
      socketClosed && "the HMR WebSocket closed before the edit was reported"
    );
  };
  try {
    await waitFor(() => messages.some((text) => text.includes('"connected"')), {
      deadline: "toolchain",
      what: "the HMR WebSocket to connect",
      intervalMs: DEV_SERVER_POLL_MS,
      failed: hmrCheckFailed,
    });
    // Only messages after the first write count; earlier ones (such as a dependency
    // re-optimization reload) say nothing about the edit.
    const sinceEdit = messages.length;
    const original = await readFile(resolve(app, edit.file), "utf8");
    await waitFor(
      async () => {
        // The file watcher may still be finishing its first scan when the edit lands and miss it,
        // so the same edit is written again until a message arrives.
        try {
          await writeFile(resolve(app, edit.file), original + edit.appended);
          const announced = messages
            .slice(sinceEdit)
            .some(
              (text) =>
                text.includes('"type":"update"') ||
                text.includes('"type":"full-reload"'),
            );
          // A reload that did not come from this edit must not end the wait before the server
          // serves the edit, so both the message and the served module have to agree.
          return (
            announced && (await moduleText(moduleUrl)).includes(HMR_EDIT_MARKER)
          );
        } catch (error) {
          // A watcher, scanner or the repeated write can hold the file or make one transform fail
          // for a moment on Windows; the next attempt retries, and the deadline error lists it.
          messages.push(
            `retry after: ${error instanceof Error ? error.message : String(error)}`.slice(
              0,
              HMR_RETRY_NOTE_CHARS,
            ),
          );
          return false;
        }
      },
      {
        deadline: "toolchain",
        what: `an HMR update after editing ${edit.file}`,
        intervalMs: HMR_EDIT_RETRY_MS,
        failed: hmrCheckFailed,
      },
    );
    return `HMR reported the edit of ${edit.file}`;
  } catch (error) {
    // The messages are limited so the error text itself is not crowded out of the report.
    const received = messages.join("\n").slice(-HMR_MESSAGES_TAIL_CHARS);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nHMR messages:\n${received}`,
      {
        cause: error,
      },
    );
  } finally {
    socket.close();
  }
}

/**
 * Starts the template's dev server on a free port, waits for a page that carries the Vite client
 * marker and then checks that an edit reaches the HMR WebSocket. The server's whole process tree
 * is killed afterwards on every path.
 */
async function webDevServer(
  settings: Settings,
  app: string,
  template: string,
): Promise<Outcome> {
  assert(settings.dev !== undefined, "this template has no dev server");
  const port = freePort();
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/`;
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
    let served = false;
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
          if (!html.includes(VITE_CLIENT_MARKER)) {
            return {
              ok: false,
              output: html,
            };
          }
          served = true;
          break;
        }
      } catch {
        // The server is not listening yet; the loop is bounded by the deadline.
      }
      await Bun.sleep(DEV_SERVER_POLL_MS);
    }
    if (served) {
      // Outside the polling loop: a failed edit check must not be taken for a server not yet up.
      return {
        ok: true,
        output: await verifyHmrEdit(template, app, origin, server),
      };
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

/**
 * Builds the generated app into a compiled EXE with `bunaway build`, then starts it from the
 * package directory. The probe appended to the UI entry (see `COMPILED_PROBE`) closes the window
 * after a backend round trip, which makes the EXE exit with code 0. A launch that outlives its
 * deadline is killed with its process tree. The message the probe saved is removed from the user
 * data directory the app wrote it to.
 */
async function compiledExe(app: string, appId: string): Promise<Outcome> {
  const entry = UI_ENTRIES.map((name) => resolve(app, name)).find((path) =>
    existsSync(path),
  );
  assert(entry !== undefined, `no UI entry among ${UI_ENTRIES.join(", ")}`);
  await appendFile(entry, COMPILED_PROBE);
  await seedWindowsBuildCaches(app, root);
  const built = await execute(
    [
      process.execPath,
      "run",
      "build",
    ],
    app,
    "packagedAudit",
    SETUP_DEADLINE_SCALE,
  );
  if (!built.ok) {
    return built;
  }
  const packageRoot = resolve(app, "dist/windows-x64");
  const executable = resolve(packageRoot, `${appId}.exe`);
  const size = existsSync(executable) ? (await stat(executable)).size : 0;
  assert(
    size >= MIN_COMPILED_EXE_BYTES,
    `${executable} is missing or too small (${size} bytes)`,
  );
  assert(
    existsSync(resolve(packageRoot, "manifest.json")),
    "the package has no manifest.json",
  );
  const userData = resolve(process.env.LOCALAPPDATA ?? "", "bunaway", appId);
  try {
    return await execute(
      [
        executable,
      ],
      home,
      "packagedAudit",
    );
  } finally {
    await rm(userData, {
      recursive: true,
      force: true,
      maxRetries: REMOVE_RETRIES,
      retryDelay: REMOVE_RETRY_DELAY_MS,
    });
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
      await record(template, "web", () =>
        webDevServer(settings, app, template),
      );
    }
    // Last, because it edits the UI entry the earlier steps serve.
    await record(template, "compiled-exe", () =>
      compiledExe(app, settings.app.appId),
    );
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

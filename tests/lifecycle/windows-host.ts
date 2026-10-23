// Windows product host integration runner: mise run host:windows builds the package first.
// Drives the real Bun entrypoint end-to-end: per-view WebView2 windows,
// per-view policy and native file checks, session revocation, window-close and
// renderer-failure isolation, and process cleanup.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validateValue } from "@bunaway/protocol";
import { windowsLaunchEnvironment } from "#cli/windows-dev-launch";
import { buildHostFixture } from "#native/windows/bun/package";
import { validationCases } from "../protocol/validation-cases.ts";
import { assertReport, readReport } from "./reports.ts";
import {
  closeAllWindows,
  rendererPids,
  watch,
} from "./windows-host-processes.ts";

const original = resolve(
  process.argv[process.argv.indexOf("--package") + 1] ?? "",
);
assert.ok(process.argv.includes("--package"), "--package is required");
const packagePath = join(dirname(original), "Bun 호스트 한글 package");
await cp(original, packagePath, {
  recursive: true,
  force: true,
});
const cwd = join(dirname(original), "hostile-host-cwd");
await mkdir(cwd, {
  recursive: true,
});
await writeFile(join(cwd, ".env"), "BUNAWAY_HOSTILE=from-dotenv\n");
await writeFile(join(cwd, "bunfig.toml"), 'preload = ["./hostile.ts"]\n');
await writeFile(join(cwd, "hostile.ts"), 'throw new Error("hostile preload");');

const localAppData = process.env.LOCALAPPDATA;
assert.ok(localAppData, "LOCALAPPDATA is required");
const dataRoot = join(localAppData, "bunaway", "tests.bunaway.host");
const results: {
  name: string;
  durationMs: number;
}[] = [];

/** Recreates the app-selected storage fixtures. */
async function resetData() {
  // Retry folder cleanup if the OS has not released a runtime file lock yet.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dataRoot, {
        recursive: true,
        force: true,
      });
      break;
    } catch (cause) {
      if (attempt >= 20) {
        throw cause;
      }
      await Bun.sleep(250);
    }
  }
  await mkdir(join(dataRoot, "data", "notes"), {
    recursive: true,
  });
  await writeFile(join(dataRoot, "data", "notes", "public.txt"), "shared-note");
  await mkdir(join(dataRoot, "data", "secrets"), {
    recursive: true,
  });
  await writeFile(
    join(dataRoot, "data", "secrets", "x.txt"),
    "app-selected-secret",
  );
}

type LogEntry = {
  event: string;
  [key: string]: unknown;
};
/** Reads host-log records and skips malformed lines, including an incomplete trailing write. */
async function hostLog(): Promise<LogEntry[]> {
  const path = join(dataRoot, "logs", "host.log");
  if (!existsSync(path)) {
    return [];
  }
  const text = await readFile(path, "utf-8");
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as {
          event?: string;
          [key: string]: unknown;
        };
        return parsed.event
          ? [
              parsed as LogEntry,
            ]
          : [];
      } catch {
        return [];
      }
    });
}
/** Polls for a host event or report; probes return null while the condition is pending. */
async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeout = 90000,
): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) {
      return value;
    }
    if (performance.now() > deadline) {
      throw new Error("Timed out waiting for host.");
    }
    await Bun.sleep(100);
  }
}
async function waitLog(match: (entry: LogEntry) => boolean, timeout = 90000) {
  return waitFor(async () => (await hostLog()).find(match) ?? null, timeout);
}
async function reportFile(name: string) {
  return waitFor(() => readReport(join(dataRoot, "temp", name)));
}

/** Starts the packaged host under hostile cwd and environment settings. */
function launch() {
  const command = [
    join(packagePath, "tests.bunaway.host.exe"),
  ];
  const hostileEnvironment = {
    PATH: `${process.env.SystemRoot}\\System32`,
    SystemRoot: process.env.SystemRoot,
    LOCALAPPDATA: localAppData,
    BUN_OPTIONS: "--preload ./hostile.ts",
    BUNAWAY_HOSTILE: "from-parent",
  };
  const child = Bun.spawn(command, {
    cwd,
    env: windowsLaunchEnvironment({
      ...process.env,
      ...hostileEnvironment,
    }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  void new Response(child.stderr).text().then((errors) => {
    if (errors) {
      console.error(errors);
    }
  });
  return child;
}
async function test(name: string, body: () => Promise<void>) {
  const start = performance.now();
  try {
    await body();
  } catch (cause) {
    throw new Error(`${name} failed`, {
      cause,
    });
  }
  results.push({
    name,
    durationMs: Math.round(performance.now() - start),
  });
  console.log(`PASS ${name}`);
}
const contextsOf = (log: LogEntry[], viewId: string) =>
  new Set(
    log
      .filter((e) => e.event === "session-open" && e.viewId === viewId)
      .map((e) => e.context),
  );

try {
  await test("TypeScript and native validators agree on shared regression inputs", async () => {
    const validator = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "windows-bun-process.ts"),
        "--validate",
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = new Response(validator.stdout).text();
    const errors = new Response(validator.stderr).text();
    for (const { schema, value } of validationCases) {
      validator.stdin.write(
        `${JSON.stringify({
          schema,
          value,
        })}\n`,
      );
    }
    validator.stdin.end();
    assert.equal(await validator.exited, 0);
    const answers = (await output)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(answers.length, validationCases.length);
    for (const [
      i,
      { name, schema, value, accepted },
    ] of validationCases.entries()) {
      let tsAccepted = true;
      try {
        validateValue(schema, value);
      } catch {
        tsAccepted = false;
      }
      assert.equal(tsAccepted, accepted, `TypeScript: ${name}`);
      assert.equal(answers[i], accepted, `native: ${name}`);
    }
    assert.equal(await errors, "");
  });

  await test("the app window runs the full host suite on one backend", async () => {
    await resetData();
    const child = launch();
    try {
      // Require the actual session of the app's view.
      await waitLog(
        (entry) => entry.event === "session-open" && entry.viewId === "main",
      );

      const log1 = await hostLog();
      const count = (
        event: string,
        extra: (e: LogEntry) => boolean = () => true,
      ) => log1.filter((entry) => entry.event === event && extra(entry)).length;
      assert.ok(count("host-started") === 1, "one backend for the window");
      assert.ok(count("webview-ready", (e) => e.view === "main") >= 1);
      assert.ok(count("session-open", (e) => e.viewId === "main") >= 1);
      // test.changed and memo.saved are allowed for the main view and must never be delivered to a
      // session outside it.
      const mainCtxs = contextsOf(log1, "main");
      for (const entry of log1.filter(
        (e) =>
          e.event === "web-delivered" &&
          e.kind === "event" &&
          (e.name === "test.changed" || e.name === "memo.saved"),
      )) {
        assert.ok(
          mainCtxs.has(entry.context),
          `${entry.name} delivered outside the main view`,
        );
      }

      // The main view finishes its suite, then navigates to page2.
      const report = await reportFile("report.json");
      assertReport(report, [
        "denied command",
        "denied event listen",
        "forged context rejected",
        "malformed message rejected",
      ]);
      const report2 = await reportFile("report2.json");
      const report3 = await reportFile("report3.json");
      for (const r of [
        ...report2.results,
        ...report3.results,
      ]) {
        assert.equal(r.ok, true, r.name);
      }

      const log = await hostLog();
      const count2 = (
        event: string,
        extra: (e: LogEntry) => boolean = () => true,
      ) => log.filter((entry) => entry.event === event && extra(entry)).length;
      assert.ok(count2("backend-ready") >= 1);
      assert.ok(
        count2(
          "revoke",
          (e) => e.reason === "navigation" && e.view === "main",
        ) >= 1,
      );
      assert.ok(count2("navigation-blocked", (e) => e.view === "main") >= 1);
      assert.ok(
        count2(
          "web-resource-blocked",
          (e) =>
            e.view === "main" &&
            e.uri === "https://example.org/" &&
            e.reason === "frame-navigation",
        ) >= 1,
        "remote iframe navigation must be canceled for the main view",
      );
      // Same-turn SDK cancellation can precede Host dispatch. The native suite
      // checks queued Host cancellation independently of process scheduling.
      // The child-frame message must never reach the backend.
      assert.equal(
        JSON.stringify(log).includes("iframe-1"),
        false,
        "iframe message leaked",
      );

      const note = await readFile(
        join(dataRoot, "data", "notes", "a.txt"),
        "utf-8",
      );
      assert.equal(note, "hello 파일");
      assert.equal(
        await readFile(join(dataRoot, "data", "secrets", "x.txt"), "utf-8"),
        "app-selected-secret",
      );
      const appLogText = await readFile(
        join(dataRoot, "logs", "app.log"),
        "utf-8",
      );
      assert.ok(appLogText.includes("page-log-테스트"));
      assert.ok(
        appLogText.includes('"source":"view:main"'),
        "view label missing on view log entries",
      );

      // Closing the window must shut the backend down and drain the Job Object cleanly.
      const started = log.find((e) => e.event === "host-started");
      assert.ok(started, "host-started missing");
      const childPid = started.pid as number;
      assert.equal(
        childPid,
        child.pid,
        "Bun entrypoint owns all UI windows in the same process",
      );
      const exited = await watch([
        childPid,
      ]);
      await closeAllWindows(child.pid);
      assert.equal(
        await child.exited,
        0,
        "WM_CLOSE shutdown must exit cleanly",
      );
      const stopped = (await hostLog()).find((e) => e.event === "host-stopped");
      assert.ok(stopped, "host-stopped missing");
      assert.equal(stopped.activeProcesses, 0);
      assert.equal(stopped.forced, false);
      await exited();
    } finally {
      if (!child.killed) {
        child.kill();
      }
      await child.exited;
    }
  });

  for (const phase of [
    "write",
    "read",
  ]) {
    await test(`memo sample ${phase} in a new host and Bun process (legacy config)`, async () => {
      // The legacy single-window declaration must keep working: a fresh app.json
      // without the windows array opens exactly one view.
      const config = {
        appId: "tests.bunaway.host",
        view: "main",
        home: `https://app.bunaway.local/memo.html?test=${phase}`,
        title: "bunaway host test",
        window: {
          width: 1024,
          height: 768,
        },
      };
      await buildHostFixture(packagePath, config);
      const previousCount = (await hostLog()).length;
      const child = launch();
      try {
        const report = await reportFile(`${phase}.json`);
        assert.ok(report.results.length > 0);
        for (const result of report.results) {
          assert.equal(result.ok, true, result.name);
        }
        const phaseLog = (await hostLog()).slice(previousCount);
        assert.equal(
          phaseLog.filter((e) => e.event === "session-open").length,
          1,
          "legacy config opened more than one view",
        );
        if (phase === "read") {
          const pids = await rendererPids(dataRoot, "main", true);
          assert.ok(pids.length > 0, "test app renderer missing");
          const beforeCrash = (await hostLog()).length;
          await rm(join(dataRoot, "temp", "read.json"));
          for (const pid of pids) {
            const killer = Bun.spawn(
              [
                "taskkill",
                "/F",
                "/PID",
                String(pid),
              ],
              {
                stdout: "pipe",
                stderr: "pipe",
              },
            );
            assert.equal(
              await killer.exited,
              0,
              "test renderer termination failed",
            );
          }
          await waitFor(
            async () =>
              (await hostLog())
                .slice(beforeCrash)
                .find(
                  (entry) =>
                    entry.event === "webview-process-failed" &&
                    entry.view === "main",
                ) ?? null,
          );
          const restored = await reportFile("read.json");
          for (const result of restored.results) {
            assert.equal(
              result.ok,
              true,
              `renderer recreation: ${result.name}`,
            );
          }
          const recovery = (await hostLog()).slice(beforeCrash);
          assert.ok(
            recovery.some(
              (entry) =>
                entry.event === "revoke" && entry.reason === "process-failed",
            ),
          );
          assert.ok(recovery.some((entry) => entry.event === "session-open"));
          assert.equal(
            recovery.some((entry) => entry.event === "host-started"),
            false,
            "renderer failure restarted Bun",
          );
        }
        const started = (await hostLog())
          .slice(previousCount)
          .find((entry) => entry.event === "host-started");
        assert.ok(started);
        const exited = await watch([
          started.pid as number,
        ]);
        await closeAllWindows(child.pid);
        assert.equal(await child.exited, 0);
        await exited();
        const stopped = (await hostLog())
          .slice(previousCount)
          .find((entry) => entry.event === "host-stopped");
        assert.equal(stopped?.activeProcesses, 0);
        assert.equal(stopped?.forced, false);
      } finally {
        if (!child.killed) {
          child.kill();
        }
        await child.exited;
      }
    });
  }

  await test("killing the Bun entrypoint removes its WebView descendants", async () => {
    await resetData();
    const child = launch();
    try {
      const started = await waitLog((e) => e.event === "host-started");
      const childPid = started.pid as number;
      assert.equal(childPid, child.pid);
      const browser = await waitLog(
        (entry) => entry.event === "webview-ready" && entry.view === "main",
      );
      const renderers = await rendererPids(dataRoot, "main", true);
      const targets = [
        childPid,
        browser.browserPid as number,
        ...renderers,
      ];
      const exited = await watch(targets);
      child.kill();
      assert.notEqual(await child.exited, 0);
      await exited();
    } finally {
      if (!child.killed) {
        child.kill();
      }
      await child.exited;
    }
  });
} finally {
  const summary = {
    host: "windows-bun-ffi",
    suites: "product-host",
    results,
    generatedAt: new Date().toISOString(),
  };
  const out = join(resolve("build"), "windows-host-results.json");
  await mkdir(dirname(out), {
    recursive: true,
  });
  await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Wrote ${out}`);
}
console.log("windows-host: all checks passed");

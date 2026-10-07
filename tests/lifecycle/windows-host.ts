// Windows product host integration runner: mise run host:windows builds the package first.
// Drives the real Bun entrypoint end-to-end: per-view WebView2 windows,
// per-view policy/storage scope enforcement, session revocation, window-close and
// renderer-failure isolation, and process cleanup.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { windowsLaunchEnvironment } from "../../packages/cli/src/launch.ts";
import { validateValue } from "../../packages/protocol/src/index.ts";
import { validationCases } from "../protocol/validation-cases.ts";
import { assertReport, readReport } from "./reports.ts";

const original = resolve(process.argv[process.argv.indexOf("--package") + 1] ?? "");
assert.ok(process.argv.includes("--package"), "--package is required");
const packagePath = join(dirname(original), "Bun 호스트 한글 package");
await cp(original, packagePath, { recursive: true, force: true });
const cwd = join(dirname(original), "hostile-host-cwd");
await mkdir(cwd, { recursive: true });
await writeFile(join(cwd, ".env"), "BUNAWAY_HOSTILE=from-dotenv\n");
await writeFile(join(cwd, "bunfig.toml"), 'preload = ["./hostile.ts"]\n');
await writeFile(join(cwd, "hostile.ts"), 'throw new Error("hostile preload");');

const localAppData = process.env.LOCALAPPDATA;
assert.ok(localAppData, "LOCALAPPDATA is required");
const dataRoot = join(localAppData, "bunaway", "tests.bunaway.host");
const results: { name: string; durationMs: number }[] = [];

// The host maps each view id to a user-data directory through viewDirName.
const viewDir = (viewId: string) =>
  `v${[...viewId].map((c) => (/[a-z0-9]/.test(c) ? c : `-${c.charCodeAt(0).toString(16).padStart(2, "0")}`)).join("")}`;

async function resetData() {
  // Retry folder cleanup if the OS has not released a runtime file lock yet.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dataRoot, { recursive: true, force: true });
      break;
    } catch (cause) {
      if (attempt >= 20) throw cause;
      await Bun.sleep(250);
    }
  }
  await mkdir(join(dataRoot, "data", "notes"), { recursive: true });
  await writeFile(join(dataRoot, "data", "notes", "public.txt"), "shared-note");
  await mkdir(join(dataRoot, "data", "secrets"), { recursive: true });
  await writeFile(join(dataRoot, "data", "secrets", "x.txt"), "out-of-scope-secret");
  await symlink(
    join(dataRoot, "data", "secrets"),
    join(dataRoot, "data", "notes", "internal-link"),
    "junction",
  );
  const outside = join(dataRoot, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "junction-target-secret");
  const mklink = Bun.spawn(
    ["cmd", "/c", "mklink", "/J", join(dataRoot, "data", "notes", "link"), outside],
    { stdout: "pipe", stderr: "pipe" },
  );
  assert.equal(await mklink.exited, 0, "junction setup failed");
}

type LogEntry = { event: string; [key: string]: unknown };
async function hostLog(): Promise<LogEntry[]> {
  const path = join(dataRoot, "logs", "host.log");
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf-8");
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as { event?: string; [key: string]: unknown };
        return parsed.event ? [parsed as LogEntry] : [];
      } catch {
        return [];
      }
    });
}
async function waitFor<T>(probe: () => Promise<T | null>, timeout = 90000): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (performance.now() > deadline) throw new Error("Timed out waiting for host.");
    await Bun.sleep(100);
  }
}
async function waitLog(match: (entry: LogEntry) => boolean, timeout = 90000) {
  return waitFor(async () => (await hostLog()).find(match) ?? null, timeout);
}
async function reportFile(name: string) {
  return waitFor(() => readReport(join(dataRoot, "temp", name)));
}

function launch() {
  const command = [
    join(packagePath, "runtime/bun.exe"),
    "--no-env-file",
    "--no-install",
    `--config=${join(packagePath, "assets/bunfig.toml")}`,
    `--tsconfig-override=${join(packagePath, "assets/tsconfig.json")}`,
    join(packagePath, "assets/boot.js"),
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
    env: windowsLaunchEnvironment({ ...process.env, ...hostileEnvironment }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  void new Response(child.stderr).text().then((errors) => {
    if (errors) console.error(errors);
  });
  return child;
}
async function rendererPids(viewId: string, legacyProfile = false) {
  // Select only renderers belonging to this view's WebView user-data directory.
  const inventory = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-Command",
      "@(Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:BUNAWAY_TEST_WEB_DATA) -and $_.CommandLine.Contains('--type=renderer') } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress",
    ],
    {
      env: {
        ...process.env,
        BUNAWAY_TEST_WEB_DATA: legacyProfile
          ? join(dataRoot, "webview")
          : join(dataRoot, "webview", viewDir(viewId)),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const pidsText = await new Response(inventory.stdout).text();
  assert.equal(await inventory.exited, 0, await new Response(inventory.stderr).text());
  const parsed = JSON.parse(pidsText || "[]") as number[] | number;
  return Array.isArray(parsed) ? parsed : [parsed];
}
// taskkill delivers WM_CLOSE to only one top-level window per call. A real
// multi-window app needs WM_CLOSE on every window, like a session logoff does.
async function closeAllWindows(pid: number) {
  const script = `
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  public static List<IntPtr> WindowsOf(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
}
'@
Add-Type -TypeDefinition $src
foreach ($h in [Win32]::WindowsOf([uint32]$env:BUNAWAY_CLOSE_PID)) {
  [void][Win32]::PostMessageW($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
}
`;
  const poster = Bun.spawn(["powershell", "-NoProfile", "-Command", script], {
    env: { ...process.env, BUNAWAY_CLOSE_PID: String(pid) },
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(await poster.exited, 0, await new Response(poster.stderr).text());
}
async function watch(pids: number[]) {
  const watcher = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "windows-bun-process.ts"),
      "--watch",
      ...pids.map(String),
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = watcher.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  assert.equal(new TextDecoder().decode(first.value), "watch-ready\n");
  return async () => {
    assert.equal(await watcher.exited, 0, "Captured OS process handles must signal exit");
    assert.equal(await new Response(watcher.stderr).text(), "");
  };
}
async function test(name: string, body: () => Promise<void>) {
  const start = performance.now();
  try {
    await body();
  } catch (cause) {
    throw new Error(`${name} failed`, { cause });
  }
  results.push({ name, durationMs: Math.round(performance.now() - start) });
  console.log(`PASS ${name}`);
}
const contextsOf = (log: LogEntry[], viewId: string) =>
  new Set(
    log.filter((e) => e.event === "session-open" && e.viewId === viewId).map((e) => e.context),
  );

try {
  await test("TypeScript and native validators agree on shared regression inputs", async () => {
    const validator = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, "windows-bun-process.ts"), "--validate"],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = new Response(validator.stdout).text();
    const errors = new Response(validator.stderr).text();
    for (const { schema, value } of validationCases)
      validator.stdin.write(`${JSON.stringify({ schema, value })}\n`);
    validator.stdin.end();
    assert.equal(await validator.exited, 0);
    const answers = (await output)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(answers.length, validationCases.length);
    for (const [i, { name, schema, value, accepted }] of validationCases.entries()) {
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

  await test("multi-view windows share one backend with per-view policy", async () => {
    await resetData();
    const child = launch();
    try {
      // The writable editor view saves first; the read-only reader view waits on
      // the allowed memo.saved event inside its checks.
      const editorReport = await reportFile("editor.json");
      for (const r of editorReport.results) assert.equal(r.ok, true, r.name);
      const readerReport = await reportFile("reader.json");
      // Diagnostic packets may be dropped at capacity. The page checks the
      // actual permission errors and reports them through an allowed command.
      assertReport(readerReport, [
        "save denied for read-only view",
        "unlisted event listen denied",
        "allowed command denied by read-only storage grant",
        "log.write denied for this view",
      ]);
      // Document loading is independent per view; require every actual session,
      // rather than infer main readiness from the faster reader's report.
      await waitLog((entry) => entry.event === "session-open" && entry.viewId === "main");

      const log1 = await hostLog();
      const count = (event: string, extra: (e: LogEntry) => boolean = () => true) =>
        log1.filter((entry) => entry.event === event && extra(entry)).length;
      assert.ok(count("host-started") === 1, "one backend for all windows");
      assert.ok(count("webview-ready", (e) => e.view === "main") >= 1);
      assert.ok(count("webview-ready", (e) => e.view === "editor") >= 1);
      assert.ok(count("webview-ready", (e) => e.view === "reader") >= 1);
      assert.ok(count("session-open", (e) => e.viewId === "main") >= 1);
      assert.ok(count("session-open", (e) => e.viewId === "editor") >= 1);
      assert.ok(count("session-open", (e) => e.viewId === "reader") >= 1);
      // The denied write must not exist.
      assert.equal(existsSync(join(dataRoot, "data", "notes", "reader.txt")), false);
      // test.changed is only allowed for the main view: event deliveries must
      // never reach editor/reader sessions.
      const mainCtxs = contextsOf(log1, "main");
      for (const entry of log1.filter(
        (e) => e.event === "web-delivered" && e.kind === "event" && e.name === "test.changed",
      )) {
        assert.ok(mainCtxs.has(entry.context), "test.changed left the main view");
      }
      const readerCtxs = contextsOf(log1, "reader");
      const editorCtxs = contextsOf(log1, "editor");
      const savedDeliveries = log1.filter(
        (e) => e.event === "web-delivered" && e.kind === "event" && e.name === "memo.saved",
      );
      // memo.saved is allowed for editor and reader; both subscribed views must
      // have received the broadcast by the time reader reported.
      for (const ctxs of [editorCtxs, readerCtxs])
        assert.ok(
          savedDeliveries.some((e) => ctxs.has(e.context)),
          "memo.saved missed an allowed view",
        );
      for (const entry of savedDeliveries)
        assert.ok(
          mainCtxs.has(entry.context) ||
            editorCtxs.has(entry.context) ||
            readerCtxs.has(entry.context),
          "memo.saved delivered outside declared views",
        );
      // The reader view closed its own window after reporting: sibling views and
      // the backend keep running. Its pending invoke (leaving-1) settles after
      // the revoke — the backend drops the reply for the dead session and the
      // host must never deliver anything to the revoked context again.
      await waitLog((e) => e.event === "view-window-closed" && e.view === "reader");
      assert.equal(child.exitCode, null, "host exited while sibling windows are open");
      const readerCtx = [...contextsOf(await hostLog(), "reader")].pop();
      assert.ok(readerCtx, "reader session-open context missing");
      const afterClose = await hostLog();
      const revokeIndex = afterClose.findIndex(
        (e) => e.event === "revoke" && e.context === readerCtx,
      );
      assert.ok(revokeIndex >= 0, "reader revoke missing");
      assert.equal(
        afterClose
          .slice(revokeIndex + 1)
          .some((e) => e.event === "web-delivered" && e.context === readerCtx),
        false,
        "revoked session still received deliveries",
      );

      // Kill the editor view's renderer processes only. The view must revoke its
      // session and recover alone; other views and Bun must keep running.
      // Wait for main's intentional navigation first so its unrelated revoke
      // cannot be mistaken for propagation from the editor crash.
      await reportFile("report3.json");
      const pids = await rendererPids("editor");
      assert.ok(pids.length > 0, "editor renderer missing");
      const beforeCrash = (await hostLog()).length;
      await rm(join(dataRoot, "temp", "editor.json"));
      for (const pid of pids) {
        const killer = Bun.spawn(["taskkill", "/F", "/PID", String(pid)], {
          stdout: "pipe",
          stderr: "pipe",
        });
        assert.equal(await killer.exited, 0, "editor renderer termination failed");
      }
      await waitLog((e) => e.event === "webview-process-failed" && e.view === "editor", 30000);
      const recovered = await reportFile("editor.json");
      for (const r of recovered.results) assert.equal(r.ok, true, `editor recovery: ${r.name}`);
      const recovery = (await hostLog()).slice(beforeCrash);
      assert.ok(
        recovery.some(
          (e) => e.event === "revoke" && e.reason === "process-failed" && e.view === "editor",
        ),
        "editor session not revoked on renderer failure",
      );
      assert.ok(
        recovery.some((e) => e.event === "session-open" && e.viewId === "editor"),
        "editor did not reopen its session",
      );
      assert.equal(
        recovery.some((e) => e.event === "host-started"),
        false,
        "renderer failure restarted Bun",
      );
      assert.equal(
        recovery.some((e) => e.event === "revoke" && e.view !== "editor"),
        false,
        "renderer failure touched another view's session",
      );
      assert.equal(child.exitCode, null, "host exited on single-view renderer failure");

      // The main view finishes its suite, then navigates to page2: that view's
      // revoke/reopen must not touch other views.
      const report = await reportFile("report.json");
      assertReport(report, [
        "denied command",
        "denied event listen",
        "forged context rejected",
        "malformed message rejected",
      ]);
      const report2 = await reportFile("report2.json");
      const report3 = await reportFile("report3.json");
      for (const r of [...report2.results, ...report3.results]) assert.equal(r.ok, true, r.name);

      const log = await hostLog();
      const count2 = (event: string, extra: (e: LogEntry) => boolean = () => true) =>
        log.filter((entry) => entry.event === event && extra(entry)).length;
      assert.ok(count2("backend-ready") >= 1);
      assert.ok(count2("revoke", (e) => e.reason === "navigation" && e.view === "main") >= 1);
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
      assert.equal(JSON.stringify(log).includes("iframe-1"), false, "iframe message leaked");

      const note = await readFile(join(dataRoot, "data", "notes", "a.txt"), "utf-8");
      assert.equal(note, "hello 파일");
      assert.equal(
        await readFile(join(dataRoot, "data", "secrets", "x.txt"), "utf-8"),
        "out-of-scope-secret",
      );
      const appLogText = await readFile(join(dataRoot, "logs", "app.log"), "utf-8");
      assert.ok(appLogText.includes("page-log-테스트"));
      assert.ok(
        appLogText.includes('"source":"view:main"'),
        "view label missing on view log entries",
      );
      assert.equal(
        await readFile(join(dataRoot, "outside", "secret.txt"), "utf-8"),
        "junction-target-secret",
      );

      // Closing the last windows must shut the shared backend down and drain
      // the Job Object cleanly.
      const started = log.find((e) => e.event === "host-started");
      assert.ok(started, "host-started missing");
      const childPid = started.pid as number;
      assert.equal(childPid, child.pid, "Bun entrypoint owns all UI windows in the same process");
      const exited = await watch([childPid]);
      await closeAllWindows(child.pid);
      assert.equal(await child.exited, 0, "WM_CLOSE shutdown must exit cleanly");
      const stopped = (await hostLog()).find((e) => e.event === "host-stopped");
      assert.ok(stopped, "host-stopped missing");
      assert.equal(stopped.activeProcesses, 0);
      assert.equal(stopped.forced, false);
      await exited();
    } finally {
      if (!child.killed) child.kill();
      await child.exited;
    }
  });

  for (const phase of ["write", "read"])
    await test(`memo sample ${phase} in a new host and Bun process (legacy config)`, async () => {
      const configPath = join(packagePath, "assets", "app.json");
      // The legacy single-window declaration must keep working: a fresh app.json
      // without the windows array opens exactly one view.
      const config = {
        appId: "tests.bunaway.host",
        view: "main",
        home: `https://app.bunaway.local/memo.html?test=${phase}`,
        title: "bunaway host test",
        window: { width: 1024, height: 768 },
      };
      const text = `${JSON.stringify(config, null, 2)}\n`;
      await writeFile(configPath, text);
      const manifestPath = join(packagePath, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
      manifest.assets["assets/app.json"] = new Bun.CryptoHasher("sha256")
        .update(text)
        .digest("hex");
      await writeFile(manifestPath, JSON.stringify(manifest));
      const previousCount = (await hostLog()).length;
      const child = launch();
      try {
        const report = await reportFile(`${phase}.json`);
        assert.ok(report.results.length > 0);
        for (const result of report.results) assert.equal(result.ok, true, result.name);
        const phaseLog = (await hostLog()).slice(previousCount);
        assert.equal(
          phaseLog.filter((e) => e.event === "session-open").length,
          1,
          "legacy config opened more than one view",
        );
        if (phase === "read") {
          const pids = await rendererPids("main", true);
          assert.ok(pids.length > 0, "test app renderer missing");
          const beforeCrash = (await hostLog()).length;
          await rm(join(dataRoot, "temp", "read.json"));
          for (const pid of pids) {
            const killer = Bun.spawn(["taskkill", "/F", "/PID", String(pid)], {
              stdout: "pipe",
              stderr: "pipe",
            });
            assert.equal(await killer.exited, 0, "test renderer termination failed");
          }
          await waitFor(
            async () =>
              (await hostLog())
                .slice(beforeCrash)
                .find(
                  (entry) => entry.event === "webview-process-failed" && entry.view === "main",
                ) ?? null,
          );
          const restored = await reportFile("read.json");
          for (const result of restored.results)
            assert.equal(result.ok, true, `renderer recreation: ${result.name}`);
          const recovery = (await hostLog()).slice(beforeCrash);
          assert.ok(
            recovery.some((entry) => entry.event === "revoke" && entry.reason === "process-failed"),
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
        const exited = await watch([started.pid as number]);
        await closeAllWindows(child.pid);
        assert.equal(await child.exited, 0);
        await exited();
        const stopped = (await hostLog())
          .slice(previousCount)
          .find((entry) => entry.event === "host-stopped");
        assert.equal(stopped?.activeProcesses, 0);
        assert.equal(stopped?.forced, false);
      } finally {
        if (!child.killed) child.kill();
        await child.exited;
      }
    });

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
      const renderers = await rendererPids("main");
      const targets = [childPid, browser.browserPid as number, ...renderers];
      const exited = await watch(targets);
      child.kill();
      assert.notEqual(await child.exited, 0);
      await exited();
    } finally {
      if (!child.killed) child.kill();
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
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Wrote ${out}`);
}
console.log("windows-host: all checks passed");

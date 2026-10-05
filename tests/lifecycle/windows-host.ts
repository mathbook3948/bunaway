// Windows product host integration runner: mise run host:windows builds the package first.
// Drives the real host end-to-end: packaged Bun backend, WebView2 boundary, policy,
// storage scope enforcement, session revocation on navigation, and process cleanup.
import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateValue } from "../../packages/protocol/src/index.ts";
import { validationCases } from "../protocol/validation-cases.ts";

const original = resolve(process.argv[process.argv.indexOf("--package") + 1] ?? "");
assert.ok(process.argv.includes("--package"), "--package is required");
const packagePath = join(dirname(original), "C 호스트 한글 package");
await cp(original, packagePath, { recursive: true, force: true });
const host = join(packagePath, "bunaway-host.exe");
const cwd = join(dirname(original), "hostile-host-cwd");
await mkdir(cwd, { recursive: true });
await writeFile(join(cwd, ".env"), "BUNAWAY_HOSTILE=from-dotenv\n");
await writeFile(join(cwd, "bunfig.toml"), 'preload = ["./hostile.ts"]\n');
await writeFile(join(cwd, "hostile.ts"), 'throw new Error("hostile preload");');

const localAppData = process.env.LOCALAPPDATA;
assert.ok(localAppData, "LOCALAPPDATA is required");
const dataRoot = join(localAppData, "bunaway", "tests.bunaway.host");
const results: { name: string; durationMs: number }[] = [];

async function resetData() {
  // WebView2 renderer processes can hold the user-data folder briefly after the
  // host exits; they live outside the Job Object so their handles drain late.
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
  return waitFor(async () => {
    const path = join(dataRoot, "temp", name);
    if (!existsSync(path)) return null;
    return JSON.parse(await readFile(path, "utf-8")) as {
      page: string;
      results: { name: string; ok: boolean; error?: string }[];
    };
  });
}

function launch() {
  const child = Bun.spawn([host], {
    cwd,
    env: {
      PATH: `${process.env.SystemRoot}\\System32`,
      SystemRoot: process.env.SystemRoot,
      LOCALAPPDATA: localAppData,
      BUN_OPTIONS: "--preload ./hostile.ts",
      BUNAWAY_HOSTILE: "from-parent",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  return child;
}
async function watch(pids: number[]) {
  const watcher = Bun.spawn([host, "--watch", ...pids.map(String)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
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

try {
  await test("TypeScript and native validators agree on shared regression inputs", async () => {
    const validator = Bun.spawn([host, "--validate"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
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

  await test("WebView boundary, policy, storage scope and Bun cleanup", async () => {
    await resetData();
    const child = launch();
    try {
      const report = await reportFile("report.json");
      const failed = report.results.filter((r) => !r.ok);
      assert.equal(failed.length, 0, `page failures: ${JSON.stringify(failed)}`);
      const report2 = await reportFile("report2.json");
      const report3 = await reportFile("report3.json");
      for (const r of [...report2.results, ...report3.results]) assert.equal(r.ok, true, r.name);

      const log = await hostLog();
      const count = (event: string, extra: (e: LogEntry) => boolean = () => true) =>
        log.filter((entry) => entry.event === event && extra(entry)).length;
      assert.ok(count("host-started") >= 1);
      assert.ok(count("backend-ready") >= 1);
      assert.ok(count("webview-ready") >= 1);
      assert.ok(count("session-open") >= 2, "index + page2 sessions");
      assert.ok(count("revoke", (e) => e.reason === "navigation") >= 1);
      assert.ok(count("navigation-blocked") >= 1);
      assert.ok(
        count(
          "web-resource-blocked",
          (e) => e.uri === "https://example.org/" && e.reason === "frame-navigation",
        ) >= 1,
        "remote iframe navigation must be canceled",
      );
      assert.ok(count("permission-denied", (e) => e.kind === "command") >= 1);
      assert.ok(count("permission-denied", (e) => e.kind === "event") >= 1);
      assert.ok(count("web-message-rejected", (e) => e.reason === "malformed") >= 2);
      assert.ok(count("web-message-rejected", (e) => e.reason === "INVALID_ARGUMENT") >= 1);
      // TIMEOUT is asserted by the page; either core or native deadline may win.
      assert.ok(count("host-request-denied") >= 1, "scope escape denial");

      assert.ok(count("host-cancel") >= 1, "runtime forwarded Host API cancellation");
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
      assert.equal(
        await readFile(join(dataRoot, "outside", "secret.txt"), "utf-8"),
        "junction-target-secret",
      );

      const started = log.find((e) => e.event === "host-started");
      assert.ok(started, "host-started missing");
      const childPid = started.childPid as number;
      const exited = await watch([childPid]);
      const taskkill = Bun.spawn(["taskkill", "/PID", String(child.pid)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      assert.equal(await taskkill.exited, 0);
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
    await test(`memo sample ${phase} in a new host and Bun process`, async () => {
      const configPath = join(packagePath, "assets", "app.json");
      const config = JSON.parse(await readFile(configPath, "utf-8"));
      config.home = `https://app.bunaway.local/memo.html?test=${phase}`;
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
        if (phase === "read") {
          // Select only renderers belonging to this test app's WebView user-data directory.
          const inventory = Bun.spawn(
            [
              "powershell",
              "-NoProfile",
              "-Command",
              "@(Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:BUNAWAY_TEST_WEB_DATA) -and $_.CommandLine.Contains('--type=renderer') } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress",
            ],
            {
              env: { ...process.env, BUNAWAY_TEST_WEB_DATA: join(dataRoot, "webview") },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const pidsText = await new Response(inventory.stdout).text();
          assert.equal(await inventory.exited, 0, await new Response(inventory.stderr).text());
          const parsed = JSON.parse(pidsText) as number[] | number;
          const pids = Array.isArray(parsed) ? parsed : [parsed];
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
                .find((entry) => entry.event === "webview-process-failed") ?? null,
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
        const exited = await watch([started.childPid as number]);
        const taskkill = Bun.spawn(["taskkill", "/PID", String(child.pid)], {
          stdout: "pipe",
          stderr: "pipe",
        });
        assert.equal(await taskkill.exited, 0);
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

  await test("killing the host still removes bundled Bun via the Job Object", async () => {
    await resetData();
    const child = launch();
    try {
      const started = await waitLog((e) => e.event === "host-started");
      const childPid = started.childPid as number;
      const exited = await watch([childPid]);
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
    host: "windows",
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

// Standalone integration runner: native/macos/host/run.sh builds the package first.
// Drives the real ObjC++ host end-to-end: packaged Bun backend, WKWebView
// boundary, policy, storage scope enforcement, session revocation on
// navigation, renderer recovery, and process cleanup (guard watchdog).
// Platform deltas: junction -> symlink, taskkill -> SIGTERM (graceful) /
// SIGKILL (ungraceful), msedgewebview2 renderer inventory -> WebContent
// delta snapshot, LOCALAPPDATA -> HOME/Library/Application Support.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { release } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { validateValue } from "../../packages/protocol/src/index.ts";
import { validationCases } from "../protocol/validation-cases.ts";

const original = resolve(process.argv[process.argv.indexOf("--package") + 1] ?? "");
assert.ok(process.argv.includes("--package"), "--package is required");
const inPlace = process.env.BUNAWAY_PACKAGE_IN_PLACE === "1";
const buildRoot = resolve(import.meta.dir, "../../build");
const workspace = await resolveTestOutput(
  process.env.BUNAWAY_TEST_WORKSPACE ??
    (inPlace ? join(buildRoot, "macos-host-in-place") : dirname(original)),
);
// BUNAWAY_PACKAGE_IN_PLACE=1 runs the package where it sits — e.g. inside a
// signed .app for App Sandbox runs — while the default copy keeps the
// hostile-name path coverage.
const packagePath = inPlace ? original : join(workspace, "C 호스트 한글 package");
// BUNAWAY_HOST_EXEC overrides the host binary: under App Sandbox the binary
// must exec from inside the .app while --package points at Contents/Resources.
const host = process.env.BUNAWAY_HOST_EXEC
  ? resolve(process.env.BUNAWAY_HOST_EXEC)
  : join(packagePath, "bunaway-host");
const nativeTests = resolve(
  process.env.BUNAWAY_NATIVE_TEST_EXEC ?? join(buildRoot, "macos-host", "host-native-tests"),
);
function enclosingApp(path: string): string | undefined {
  for (let current = path; current !== dirname(current); current = dirname(current)) {
    if (basename(current).toLowerCase().endsWith(".app")) return current;
  }
}
async function resolveTestOutput(path: string) {
  const components = sep === "\\" ? path.split(/[\\/]/) : path.split(sep);
  assert.ok(
    !components.includes(".."),
    `test output must not contain parent-directory components: ${path}`,
  );
  const output = resolve(path);
  assert.equal(enclosingApp(output), undefined, `test output must be outside .app: ${path}`);
  // Resolve existing ancestors too, so a workspace symlink cannot write into the bundle.
  let ancestor = output;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  assert.equal(
    enclosingApp(await realpath(ancestor)),
    undefined,
    `test output resolves inside .app: ${path}`,
  );
  return output;
}
const app = inPlace ? enclosingApp(await realpath(host)) : undefined;
const packageApp = inPlace ? enclosingApp(await realpath(original)) : undefined;
assert.equal(
  packageApp,
  app,
  "in-place package and host must be in the same .app (or both outside)",
);
const identity = process.env.BUNAWAY_TEST_SIGN_IDENTITY;
function codesign(args: string[]) {
  const result = Bun.spawnSync(["/usr/bin/codesign", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(result.exitCode, 0, result.stderr.toString());
}
function verifyApp() {
  if (app) codesign(["--verify", "--deep", "--strict", app]);
}
function sealApp() {
  if (app) {
    assert.ok(identity);
    codesign([
      "--force",
      "--sign",
      identity,
      "--preserve-metadata=identifier,entitlements,requirements,flags,runtime",
      app,
    ]);
    verifyApp();
  }
}
if (app) {
  assert.ok(identity, "BUNAWAY_TEST_SIGN_IDENTITY is required for a mutable signed test fixture");
  verifyApp();
}
assert.ok(
  existsSync(nativeTests),
  `native tests not found: ${nativeTests}; run native/macos/host/run.sh first`,
);
const cwd = join(workspace, "hostile-host-cwd");
await resolveTestOutput(cwd);

// Hermetic HOME: the host resolves its data root under it. BUNAWAY_DATA_ROOT
// overrides that location — under App Sandbox HOME is rewritten to the app
// container, so callers point this at
// ~/Library/Containers/<bundle-id>/Data/Library/Application Support/bunaway/<appId>.
const sandboxHome = join(workspace, "host-home");
await resolveTestOutput(sandboxHome);
const dataRoot = await resolveTestOutput(
  process.env.BUNAWAY_DATA_ROOT ??
    join(sandboxHome, "Library/Application Support/bunaway", "tests.bunaway.host"),
);
await mkdir(workspace, { recursive: true });
if (packagePath !== original) await cp(original, packagePath, { recursive: true, force: true });
await mkdir(cwd, { recursive: true });
await writeFile(join(cwd, ".env"), "BUNAWAY_HOSTILE=from-dotenv\n");
await writeFile(join(cwd, "bunfig.toml"), 'preload = ["./hostile.ts"]\n');
await writeFile(join(cwd, "hostile.ts"), 'throw new Error("hostile preload");');
await mkdir(sandboxHome, { recursive: true });
const results: { name: string; ok: boolean; durationMs: number; error?: string }[] = [];
const diagnostics = join(workspace, "macos-host-diagnostics");
await rm(diagnostics, { recursive: true, force: true });
await mkdir(diagnostics, { recursive: true });
let launchCount = 0;
const assets = join(packagePath, "assets");
const assetMode = (await stat(assets)).mode & 0o777;
const savedResources = app
  ? await Promise.all(
      ["assets/app.json", "assets/policy.json", "manifest.json"].map(async (path) => ({
        path: join(packagePath, path),
        bytes: await readFile(join(packagePath, path)),
      })),
    )
  : [];
const assetsTmp = join(assets, "tmp");
const savedTmp = join(diagnostics, "original-assets-tmp");
const hadTmp = app && existsSync(assetsTmp);
if (hadTmp) await cp(assetsTmp, savedTmp, { recursive: true });

async function resetData() {
  // WebContent renderers may hold the data folder briefly after the host exits;
  // they live outside the Bun process group so their handles drain late.
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
  );
  const outside = join(dataRoot, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "junction-target-secret");
  await symlink(outside, join(dataRoot, "data", "notes", "link"));
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

async function updateAsset(name: string, text: string) {
  await writeFile(join(packagePath, name), text);
  const manifestPath = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  manifest.assets[name] = new Bun.CryptoHasher("sha256").update(text).digest("hex");
  await writeFile(manifestPath, JSON.stringify(manifest));
}

// WebContent renderers are spawned by launchd, not by our host: inventory is a
// delta over the baseline snapshot taken at driver start.
async function webContentPids(): Promise<number[]> {
  const probe = Bun.spawn(["/usr/bin/pgrep", "-f", "com.apple.WebKit.WebContent"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(probe.stdout).text();
  await probe.exited;
  return text
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}
const webContentBaseline = new Set(await webContentPids());
async function newWebContentPids(): Promise<number[]> {
  const current = await webContentPids();
  return current.filter((pid) => !webContentBaseline.has(pid));
}

function launch(extraEnv: Record<string, string> = {}) {
  sealApp();
  const child = Bun.spawn([host, "--package", packagePath], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: sandboxHome,
      BUN_OPTIONS: "--preload ./hostile.ts",
      BUNAWAY_HOSTILE: "from-parent",
      ...extraEnv,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: Bun.file(join(diagnostics, `host-${++launchCount}.stderr.log`)),
  });
  return child;
}
async function gracefulStop(child: ReturnType<typeof Bun.spawn>) {
  // SIGTERM maps to WM_CLOSE: the host closes the session and exits 0.
  process.kill(child.pid, "SIGTERM");
  assert.equal(await child.exited, 0, "graceful shutdown must exit cleanly");
}
async function watch(pids: (number | string)[]) {
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
    assert.equal(await watcher.exited, 0, "watched processes must signal exit");
    assert.equal(await new Response(watcher.stderr).text(), "");
  };
}
async function test(name: string, body: () => Promise<void>) {
  const start = performance.now();
  const testIndex = results.length + 1;
  try {
    try {
      await body();
    } finally {
      const snapshot = join(diagnostics, `test-${testIndex}`);
      await mkdir(snapshot, { recursive: true });
      for (const dir of ["logs", "temp"]) {
        const source = join(dataRoot, dir);
        if (existsSync(source))
          await cp(source, join(snapshot, dir), {
            recursive: true,
            filter: async (path) => {
              const entry = await lstat(path);
              return entry.isDirectory() || entry.isFile();
            },
          });
      }
    }
  } catch (cause) {
    results.push({
      name,
      ok: false,
      durationMs: Math.round(performance.now() - start),
      error: String(cause),
    });
    throw new Error(`${name} failed`, { cause });
  }
  results.push({ name, ok: true, durationMs: Math.round(performance.now() - start) });
  console.log(`PASS ${name}`);
}

try {
  await test("native FIFO, scheme handler and resource-filter regressions", async () => {
    const native = Bun.spawn([nativeTests, workspace], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });
    const output = new Response(native.stdout).text();
    const errors = new Response(native.stderr).text();
    const exitCode = await native.exited;
    await writeFile(join(diagnostics, "native.stdout.log"), await output);
    await writeFile(join(diagnostics, "native.stderr.log"), await errors);
    assert.equal(exitCode, 0, await errors);
    assert.ok((await output).includes("PASS scheme handler"));
  });

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
      assert.ok(count("web-resource-blocked") >= 1, "remote iframe must be blocked");
      assert.ok(count("permission-denied", (e) => e.kind === "command") >= 1);
      assert.ok(count("permission-denied", (e) => e.kind === "event") >= 1);
      assert.ok(count("web-message-rejected", (e) => e.reason === "malformed") >= 2);
      assert.ok(count("web-message-rejected", (e) => e.reason === "INVALID_ARGUMENT") >= 1);
      // TIMEOUT is asserted by the page; either core or native deadline may win.
      assert.ok(count("host-request-denied") >= 1, "scope escape denial");

      // Same-turn SDK cancellation can precede Host dispatch. The delayed
      // suite below checks native Host cancellation after a backend barrier.
      // The child-frame message must never reach the backend.
      assert.equal(JSON.stringify(log).includes("iframe-1"), false, "iframe message leaked");
      assert.ok(count("frame-message-ignored") >= 1, "iframe message was seen and dropped");

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
      await gracefulStop(child);
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

  await test("cancel arriving first blocks the late host result", async () => {
    // The UI's backend round trip lets Host dispatch precede cancellation;
    // delayed workers keep the native request pending until cancel arrives.
    await resetData();
    const configText = await readFile(join(packagePath, "assets/app.json"), "utf-8");
    const config = JSON.parse(configText);
    const home = new URL(config.home);
    home.searchParams.set("hostCancelBarrier", "1");
    config.home = home.href;
    await updateAsset("assets/app.json", JSON.stringify(config));
    let child: ReturnType<typeof launch> | undefined;
    try {
      child = launch({ BUNAWAY_HOST_OP_DELAY_MS: "500" });
      const report = await reportFile("report.json");
      const failed = report.results.filter((r) => !r.ok);
      assert.equal(failed.length, 0, `page failures: ${JSON.stringify(failed)}`);
      const log = await hostLog();
      const cancels = log.filter((e) => e.event === "host-cancel");
      assert.ok(cancels.length >= 1, "host-cancel missing with delayed ops");
      const blocked = new Set(
        log
          .filter(
            (e) => e.event === "host-request-cancelled" || e.event === "host-response-discarded",
          )
          .map((e) => e.requestId as string),
      );
      assert.ok(blocked.size >= 1, "no host request was cancelled or had its result discarded");
      assert.ok(
        log.some(
          (e) =>
            e.event === "host-request" &&
            e.operation === "storage.readText" &&
            blocked.has(e.requestId as string),
        ),
        "cancelled read must have reached the native Host",
      );
      const responded = new Set(
        log.filter((e) => e.event === "host-response").map((e) => e.requestId as string),
      );
      for (const id of blocked) assert.ok(!responded.has(id), `late result escaped for ${id}`);
      await gracefulStop(child);
    } finally {
      if (child) {
        if (!child.killed) child.kill();
        await child.exited;
      }
      await updateAsset("assets/app.json", configText);
    }
  });

  await test("real script, image and fetch requests obey destination origins before first load", async () => {
    await resetData();
    await mkdir(join(dataRoot, "temp"), { recursive: true });
    const fifo = Bun.spawn(["/usr/bin/mkfifo", join(dataRoot, "temp", "pipe")]);
    assert.equal(await fifo.exited, 0);
    const allowedRequests: string[] = [];
    const blockedRequests: string[] = [];
    const serve = (requests: string[]) =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname;
          requests.push(path);
          const headers = { "Access-Control-Allow-Origin": "*" };
          if (path === "/script")
            return new Response("globalThis.bunawayResourceLoaded = true;", {
              headers: { ...headers, "Content-Type": "application/javascript" },
            });
          if (path === "/img")
            return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', {
              headers: { ...headers, "Content-Type": "image/svg+xml" },
            });
          return new Response("resource-ok", { headers });
        },
      });
    const allowed = serve(allowedRequests);
    const blocked = serve(blockedRequests);
    const configText = await readFile(join(packagePath, "assets/app.json"), "utf-8");
    const policyText = await readFile(join(packagePath, "assets/policy.json"), "utf-8");
    let child: ReturnType<typeof launch> | undefined;
    try {
      const allowedOrigin = `http://127.0.0.1:${allowed.port}`;
      const params = new URLSearchParams({
        allowed: allowedOrigin,
        blocked: `http://127.0.0.1:${blocked.port}`,
      });
      const config = JSON.parse(configText);
      config.home = `https://app.bunaway.local:8443/security.html?${params}`;
      const policy = JSON.parse(policyText);
      policy.views[0].origins = ["https://app.bunaway.local:8443", allowedOrigin];
      await updateAsset("assets/app.json", JSON.stringify(config));
      await updateAsset("assets/policy.json", JSON.stringify(policy));
      child = launch();
      const report = await reportFile("security.json");
      assert.equal(report.results.length, 8);
      for (const result of report.results) assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(allowedRequests.sort(), ["/fetch", "/img", "/script"]);
      assert.deepEqual(blockedRequests, [], "blocked resources reached the server");
      const log = await hostLog();
      const readyIndex = log.findIndex((entry) => entry.event === "webview-ready");
      const navigationIndex = log.findIndex((entry) => entry.event === "navigation");
      assert.ok(
        readyIndex >= 0 && navigationIndex > readyIndex,
        "navigation preceded rule installation",
      );
      process.kill(child.pid, "SIGTERM");
      assert.equal(
        await Promise.race([child.exited, Bun.sleep(5000).then(() => "timeout")]),
        0,
        "FIFO rejection must not stall graceful shutdown",
      );
      assert.equal(
        (await hostLog()).find((entry) => entry.event === "host-stopped")?.forced,
        false,
      );
    } finally {
      if (child) {
        if (!child.killed) child.kill("SIGKILL");
        await child.exited;
      }
      allowed.stop(true);
      blocked.stop(true);
      await updateAsset("assets/app.json", configText);
      await updateAsset("assets/policy.json", policyText);
    }
  });

  for (const phase of ["write", "read"])
    await test(`memo sample ${phase} in a new host and Bun process`, async () => {
      const configPath = join(packagePath, "assets", "app.json");
      const config = JSON.parse(await readFile(configPath, "utf-8"));
      config.home = `https://app.bunaway.local/memo.html?test=${phase}&browserStorage=ephemeral`;
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
          // WebContent renderers of this app's webview are the post-launch delta.
          const pids = await waitFor(async () => {
            const fresh = await newWebContentPids();
            return fresh.length ? fresh : null;
          });
          const beforeCrash = (await hostLog()).length;
          await rm(join(dataRoot, "temp", "read.json"));
          for (const pid of pids) {
            const killer = Bun.spawn(["/bin/kill", "-9", String(pid)], {
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
        await gracefulStop(child);
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

  await test("killing the host still removes bundled Bun via the guard", async () => {
    await resetData();
    const child = launch();
    try {
      const started = await waitLog((e) => e.event === "host-started");
      const childPid = started.childPid as number;
      const guardPid = started.guardPid as number;
      // Wait for ready so the kill cannot land inside the spawn->guard window.
      await waitLog((e) => e.event === "backend-ready");
      const exited = await watch([childPid, guardPid, `g${childPid}`]);
      process.kill(child.pid, "SIGKILL");
      assert.notEqual(await child.exited, 0);
      await exited();
    } finally {
      if (!child.killed) child.kill();
      await child.exited;
    }
  });

  await test("runtime starts with read-only assets and no bundled tmp directory", async () => {
    await resetData();
    const assets = join(packagePath, "assets");
    await rm(join(assets, "tmp"), { recursive: true, force: true });
    await chmod(assets, 0o555);
    let child: ReturnType<typeof launch> | undefined;
    try {
      child = launch();
      await waitLog((entry) => entry.event === "backend-ready");
      assert.equal(existsSync(join(assets, "tmp")), false);
      await gracefulStop(child);
    } finally {
      if (child) {
        if (!child.killed) child.kill();
        await child.exited;
      }
      await chmod(assets, 0o755);
    }
  });
} finally {
  if (app) {
    await chmod(assets, 0o755);
    for (const { path, bytes } of savedResources) await writeFile(path, bytes);
    await rm(assetsTmp, { recursive: true, force: true });
    if (hadTmp) await cp(savedTmp, assetsTmp, { recursive: true });
    await chmod(assets, assetMode);
    sealApp();
  }
  const summary = {
    host: "macos",
    osRelease: release(),
    architecture: process.arch,
    suites: "product-host",
    results,
    generatedAt: new Date().toISOString(),
  };
  const out = join(workspace, "macos-host-results.json");
  await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Wrote ${out}`);
}
console.log("macos-host: all checks passed");

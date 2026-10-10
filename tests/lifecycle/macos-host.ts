// Standalone integration runner: native/macos/host/run.sh builds the package first.
// Drives the real ObjC++ host end-to-end: packaged Bun backend, WKWebView
// boundary, policy, unsupported native plugin rejection, session revocation on
// navigation, renderer recovery, and process cleanup (guard watchdog).
// Platform deltas: junction -> symlink, taskkill -> SIGTERM for graceful shutdown
// or SIGKILL for forced exit, WebView2 renderer inventory -> WebContent snapshot,
// LOCALAPPDATA -> HOME/Library/Application Support.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { release } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { validateValue } from "@bunaway/protocol";
import { validationCases } from "../protocol/validation-cases.ts";
import { listWebContentPids, terminateRenderers } from "./macos-renderer.ts";
import { readReport } from "./reports.ts";

const original = resolve(
  process.argv[process.argv.indexOf("--package") + 1] ?? "",
);
assert.ok(process.argv.includes("--package"), "--package is required");
const inPlace = process.env.BUNAWAY_PACKAGE_IN_PLACE === "1";
const buildRoot = resolve(import.meta.dir, "../../build");
const workspace = await resolveTestOutput(
  process.env.BUNAWAY_TEST_WORKSPACE ??
    (inPlace ? join(buildRoot, "macos-host-in-place") : dirname(original)),
);
// BUNAWAY_PACKAGE_IN_PLACE=1 runs the package where it sits, such as inside a
// signed .app for App Sandbox runs, while the default copy keeps the
// hostile-name path coverage.
const packagePath = inPlace
  ? original
  : join(workspace, "C 호스트 한글 package");
// BUNAWAY_HOST_EXEC overrides the host binary: under App Sandbox the binary
// must exec from inside the .app while --package points at Contents/Resources.
const host = process.env.BUNAWAY_HOST_EXEC
  ? resolve(process.env.BUNAWAY_HOST_EXEC)
  : join(packagePath, "bunaway-host");
const nativeTests = resolve(
  process.env.BUNAWAY_NATIVE_TEST_EXEC ??
    join(buildRoot, "macos-host", "host-native-tests"),
);
function enclosingApp(path: string): string | undefined {
  for (
    let current = path;
    current !== dirname(current);
    current = dirname(current)
  ) {
    if (basename(current).toLowerCase().endsWith(".app")) {
      return current;
    }
  }
}
/** Rejects output paths that could place test data inside a signed .app bundle. */
async function resolveTestOutput(path: string) {
  const components = sep === "\\" ? path.split(/[\\/]/) : path.split(sep);
  assert.ok(
    !components.includes(".."),
    `test output must not contain parent-directory components: ${path}`,
  );
  const output = resolve(path);
  assert.equal(
    enclosingApp(output),
    undefined,
    `test output must be outside .app: ${path}`,
  );
  assert.equal(
    enclosingApp(await canonicalPath(output)),
    undefined,
    `test output resolves inside .app: ${path}`,
  );
  return output;
}
async function canonicalPath(output: string) {
  // Resolve through the nearest existing ancestor so new output paths also respect symlinks.
  let ancestor = output;
  while (!existsSync(ancestor)) {
    ancestor = dirname(ancestor);
  }
  return resolve(await realpath(ancestor), relative(ancestor, output));
}
function containsPath(root: string, path: string) {
  const suffix = relative(root, path);
  return (
    suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
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
  const result = Bun.spawnSync(
    [
      "/usr/bin/codesign",
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString());
}
function verifyApp() {
  if (app) {
    codesign([
      "--verify",
      "--deep",
      "--strict",
      app,
    ]);
  }
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
const cwd = join(workspace, "hostile-host-cwd");
await resolveTestOutput(cwd);

// Hermetic HOME: the host resolves its data root under it. BUNAWAY_DATA_ROOT
// overrides that location. Under App Sandbox HOME is rewritten to the app
// container, so callers point this at
// ~/Library/Containers/<bundle-id>/Data/Library/Application Support/bunaway/<appId>.
const sandboxHome = join(workspace, "host-home");
await resolveTestOutput(sandboxHome);
const dataRoot = await resolveTestOutput(
  process.env.BUNAWAY_DATA_ROOT ??
    join(
      sandboxHome,
      "Library/Application Support/bunaway",
      "tests.bunaway.host",
    ),
);
const diagnostics = await resolveTestOutput(
  join(workspace, "macos-host-diagnostics"),
);
const out = join(workspace, "macos-host-results.json");
const protectedPaths = await Promise.all(
  [
    original,
    packagePath,
    host,
    nativeTests,
    workspace,
    cwd,
    sandboxHome,
    ...(app
      ? [
          app,
        ]
      : []),
  ].map(canonicalPath),
);
/** Ensures a recursive cleanup root cannot contain the package or other preserved paths. */
async function assertDeletionOutput(path: string, keep: string[] = []) {
  await resolveTestOutput(path);
  const canonical = await canonicalPath(path);
  for (const target of [
    ...protectedPaths,
    ...(await Promise.all(keep.map(canonicalPath))),
  ]) {
    assert.ok(
      !containsPath(canonical, target),
      `test deletion root contains protected path: ${path}`,
    );
  }
}
/** Ensures an output path is absent or a regular file, never a symlink. */
async function assertOutputFile(path: string) {
  await resolveTestOutput(path);
  const entry = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "ENOENT") {
      throw cause;
    }
  });
  assert.ok(
    !entry || entry.isFile(),
    `test output must be a regular file, not a symlink: ${path}`,
  );
}
/** Replaces a checked output file atomically so report readers cannot observe partial contents. */
async function writeTestOutput(path: string, text: string) {
  await assertOutputFile(path);
  const staging = await mkdtemp(join(dirname(path), ".bunaway-test-output-"));
  try {
    // Publish only after the complete file is written.
    const staged = join(staging, "output");
    await writeFile(staged, text, {
      flag: "wx",
    });
    await assertOutputFile(path);
    await rename(staged, path);
  } finally {
    await rm(staging, {
      recursive: true,
      force: true,
    });
  }
}
await assertDeletionOutput(dataRoot, [
  diagnostics,
]);
await assertDeletionOutput(diagnostics, [
  dataRoot,
]);
const scratchFiles = [
  join(cwd, ".env"),
  join(cwd, "bunfig.toml"),
  join(cwd, "hostile.ts"),
];
for (const path of [
  ...scratchFiles,
  out,
]) {
  await assertOutputFile(path);
}
if (app) {
  assert.ok(
    identity,
    "BUNAWAY_TEST_SIGN_IDENTITY is required for a mutable signed test fixture",
  );
  verifyApp();
}
assert.ok(
  existsSync(nativeTests),
  `native tests not found: ${nativeTests}; run native/macos/host/run.sh first`,
);
await mkdir(workspace, {
  recursive: true,
});
if (packagePath !== original) {
  await cp(original, packagePath, {
    recursive: true,
    force: true,
  });
}
await mkdir(cwd, {
  recursive: true,
});
await writeTestOutput(join(cwd, ".env"), "BUNAWAY_HOSTILE=from-dotenv\n");
await writeTestOutput(join(cwd, "bunfig.toml"), 'preload = ["./hostile.ts"]\n');
await writeTestOutput(
  join(cwd, "hostile.ts"),
  'throw new Error("hostile preload");',
);
await mkdir(sandboxHome, {
  recursive: true,
});
const results: {
  name: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}[] = [];
await assertDeletionOutput(diagnostics, [
  dataRoot,
]);
await rm(diagnostics, {
  recursive: true,
  force: true,
});
await mkdir(diagnostics, {
  recursive: true,
});
let launchCount = 0;
const assets = join(packagePath, "assets");
const assetMode = (await stat(assets)).mode & 0o777;
const savedResources = app
  ? await Promise.all(
      [
        "assets/app.json",
        "assets/policy.json",
        "manifest.json",
      ].map(async (path) => ({
        path: join(packagePath, path),
        bytes: await readFile(join(packagePath, path)),
      })),
    )
  : [];
// In-place runs mutate a signed bundle, so preserve original resource bytes for cleanup.
const assetsTmp = join(assets, "tmp");
const savedTmp = join(diagnostics, "original-assets-tmp");
const hadTmp = app && existsSync(assetsTmp);
if (hadTmp) {
  await cp(assetsTmp, savedTmp, {
    recursive: true,
    verbatimSymlinks: true,
  });
}

/** Rebuilds isolated app data and the symlink fixtures used by storage-boundary checks. */
async function resetData() {
  // WebContent renderers may hold the data folder briefly after the host exits;
  // they live outside the Bun process group so their handles drain late.
  for (let attempt = 0; ; attempt++) {
    try {
      await assertDeletionOutput(dataRoot, [
        diagnostics,
      ]);
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
  await mkdir(join(dataRoot, "data", "secrets"), {
    recursive: true,
  });
  await writeTestOutput(
    join(dataRoot, "data", "secrets", "x.txt"),
    "out-of-scope-secret",
  );
  await symlink(
    join(dataRoot, "data", "secrets"),
    join(dataRoot, "data", "notes", "internal-link"),
  );
  const outside = join(dataRoot, "outside");
  await mkdir(outside, {
    recursive: true,
  });
  await writeTestOutput(join(outside, "secret.txt"), "junction-target-secret");
  await symlink(outside, join(dataRoot, "data", "notes", "link"));
}

type LogEntry = {
  event: string;
  [key: string]: unknown;
};
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
/** Polls until a probe returns a value; null means the expected state is not ready yet. */
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

async function updateAsset(name: string, text: string) {
  await writeFile(join(packagePath, name), text);
  const manifestPath = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  // The host verifies every packaged asset against this digest before it starts.
  manifest.assets[name] = new Bun.CryptoHasher("sha256")
    .update(text)
    .digest("hex");
  await writeFile(manifestPath, JSON.stringify(manifest));
}

// WebContent renderers are spawned by launchd, not by our host: inventory is the
// current user's delta over the baseline snapshot taken at driver start.
const webContentBaseline = new Set(await listWebContentPids());
async function newWebContentPids(): Promise<number[]> {
  const current = await listWebContentPids();
  return current.filter((pid) => !webContentBaseline.has(pid));
}

function launch(
  extraEnv: Record<string, string> = {},
  arguments_: string[] = [],
) {
  // Re-sign mutable in-place bundles and give the host a controlled environment for each run.
  sealApp();
  const child = Bun.spawn(
    [
      host,
      "--package",
      packagePath,
      ...arguments_,
    ],
    {
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
    },
  );
  return child;
}
async function gracefulStop(child: ReturnType<typeof Bun.spawn>) {
  // SIGTERM asks the host to close its session and exit cleanly.
  process.kill(child.pid, "SIGTERM");
  assert.equal(await child.exited, 0, "graceful shutdown must exit cleanly");
}
/** Starts a watcher and returns a function that waits for all targets to exit. */
async function watch(pids: (number | string)[]) {
  const watcher = Bun.spawn(
    [
      host,
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
  // Do not treat watcher startup delay as evidence that a target has exited.
  const first = await reader.read();
  reader.releaseLock();
  assert.equal(new TextDecoder().decode(first.value), "watch-ready\n");
  return async () => {
    assert.equal(await watcher.exited, 0, "watched processes must signal exit");
    assert.equal(await new Response(watcher.stderr).text(), "");
  };
}
/** Records each case and snapshots logs and reports even when its assertion fails. */
async function test(name: string, body: () => Promise<void>) {
  const start = performance.now();
  const testIndex = results.length + 1;
  try {
    try {
      await body();
    } finally {
      const snapshot = join(diagnostics, `test-${testIndex}`);
      await mkdir(snapshot, {
        recursive: true,
      });
      for (const dir of [
        "logs",
        "temp",
      ]) {
        const source = join(dataRoot, dir);
        if (existsSync(source)) {
          await cp(source, join(snapshot, dir), {
            recursive: true,
            filter: async (path) => {
              const entry = await lstat(path);
              // Diagnostics must not copy symlinks that lead outside the captured tree.
              return entry.isDirectory() || entry.isFile();
            },
          });
        }
      }
    }
  } catch (cause) {
    results.push({
      name,
      ok: false,
      durationMs: Math.round(performance.now() - start),
      error: String(cause),
    });
    throw new Error(`${name} failed`, {
      cause,
    });
  }
  results.push({
    name,
    ok: true,
    durationMs: Math.round(performance.now() - start),
  });
  console.log(`PASS ${name}`);
}

try {
  await test("native Bun integrity, FIFO, scheme handler and resource-filter regressions", async () => {
    const native = Bun.spawn(
      [
        nativeTests,
        workspace,
        original,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    const output = new Response(native.stdout).text();
    const errors = new Response(native.stderr).text();
    const exitCode = await native.exited;
    await writeTestOutput(join(diagnostics, "native.stdout.log"), await output);
    await writeTestOutput(join(diagnostics, "native.stderr.log"), await errors);
    assert.equal(exitCode, 0, await errors);
    assert.ok((await output).includes("PASS scheme handler"));
  });

  await test("TypeScript and native validators agree on shared regression inputs", async () => {
    const validator = Bun.spawn(
      [
        host,
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

  await test("WebView boundary, command policy and Bun cleanup without native plugins", async () => {
    await resetData();
    const child = launch();
    try {
      const report = await reportFile("report.json");
      const failed = report.results.filter((r) => !r.ok);
      assert.equal(
        failed.length,
        0,
        `page failures: ${JSON.stringify(failed)}`,
      );
      const report2 = await reportFile("report2.json");
      const report3 = await reportFile("report3.json");
      for (const r of [
        ...report2.results,
        ...report3.results,
      ]) {
        assert.equal(r.ok, true, r.name);
      }

      const log = await hostLog();
      const count = (
        event: string,
        extra: (e: LogEntry) => boolean = () => true,
      ) => log.filter((entry) => entry.event === event && extra(entry)).length;
      assert.ok(count("host-started") >= 1);
      assert.ok(count("backend-ready") >= 1);
      assert.ok(count("webview-ready") >= 1);
      assert.ok(count("session-open") >= 2, "index + page2 sessions");
      assert.ok(count("revoke", (e) => e.reason === "navigation") >= 1);
      assert.ok(count("navigation-blocked") >= 1);
      assert.ok(
        count("web-resource-blocked") >= 1,
        "remote iframe must be blocked",
      );
      assert.ok(count("permission-denied", (e) => e.kind === "command") >= 1);
      assert.ok(count("permission-denied", (e) => e.kind === "event") >= 1);
      assert.ok(
        count("web-message-rejected", (e) => e.reason === "malformed") >= 2,
      );
      assert.ok(
        count("web-message-rejected", (e) => e.reason === "INVALID_ARGUMENT") >=
          1,
      );
      // TIMEOUT is asserted by the page; either core or native deadline may win.
      assert.ok(
        report.results.some(
          (r) => r.name === "unregistered native plugin command is denied",
        ),
      );

      // The child-frame message must never reach the backend.
      assert.equal(
        JSON.stringify(log).includes("iframe-1"),
        false,
        "iframe message leaked",
      );
      assert.ok(
        count("frame-message-ignored") >= 1,
        "iframe message was seen and dropped",
      );

      assert.equal(
        await readFile(join(dataRoot, "data", "secrets", "x.txt"), "utf-8"),
        "out-of-scope-secret",
      );
      assert.equal(existsSync(join(dataRoot, "logs", "app.log")), false);
      assert.equal(
        await readFile(join(dataRoot, "outside", "secret.txt"), "utf-8"),
        "junction-target-secret",
      );

      const started = log.find((e) => e.event === "host-started");
      assert.ok(started, "host-started missing");
      const childPid = started.childPid as number;
      const exited = await watch([
        childPid,
      ]);
      await gracefulStop(child);
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

  await test("native plugin permissions fail before backend startup", async () => {
    await resetData();
    const policyText = await readFile(
      join(packagePath, "assets/policy.json"),
      "utf-8",
    );
    const policy = JSON.parse(policyText);
    policy.backend.permissions = [
      "log:write",
    ];
    await updateAsset("assets/policy.json", JSON.stringify(policy));
    let child: ReturnType<typeof launch> | undefined;
    try {
      child = launch();
      assert.notEqual(
        await Promise.race([
          child.exited,
          Bun.sleep(10000).then(() => "timeout"),
        ]),
        "timeout",
      );
      assert.notEqual(child.exitCode, 0);
      assert.match(
        await readFile(
          join(diagnostics, `host-${launchCount}.stderr.log`),
          "utf8",
        ),
        /Native plugins currently require the Windows app runtime/,
      );
      assert.equal(
        (await hostLog()).some((entry) => entry.event === "host-started"),
        false,
      );
    } finally {
      if (child) {
        if (!child.killed) {
          child.kill();
        }
        await child.exited;
      }
      await updateAsset("assets/policy.json", policyText);
    }
  });

  await test("real script, image and fetch requests obey destination origins before first load", async () => {
    await resetData();
    const allowedRequests: string[] = [];
    const blockedRequests: string[] = [];
    const serve = (requests: string[]) =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname;
          requests.push(path);
          const headers = {
            "Access-Control-Allow-Origin": "*",
          };
          if (path === "/script") {
            return new Response("globalThis.bunawayResourceLoaded = true;", {
              headers: {
                ...headers,
                "Content-Type": "application/javascript",
              },
            });
          }
          if (path === "/img") {
            return new Response(
              '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
              {
                headers: {
                  ...headers,
                  "Content-Type": "image/svg+xml",
                },
              },
            );
          }
          return new Response("resource-ok", {
            headers,
          });
        },
      });
    const allowed = serve(allowedRequests);
    const blocked = serve(blockedRequests);
    const configText = await readFile(
      join(packagePath, "assets/app.json"),
      "utf-8",
    );
    const policyText = await readFile(
      join(packagePath, "assets/policy.json"),
      "utf-8",
    );
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
      policy.views[0].origins = [
        "https://app.bunaway.local:8443",
        allowedOrigin,
      ];
      await updateAsset("assets/app.json", JSON.stringify(config));
      await updateAsset("assets/policy.json", JSON.stringify(policy));
      child = launch();
      const report = await reportFile("security.json");
      assert.equal(report.results.length, 6);
      for (const result of report.results) {
        assert.equal(result.ok, true, JSON.stringify(result));
      }
      assert.deepEqual(allowedRequests.sort(), [
        "/fetch",
        "/img",
        "/script",
      ]);
      assert.deepEqual(
        blockedRequests,
        [],
        "blocked resources reached the server",
      );
      const log = await hostLog();
      const readyIndex = log.findIndex(
        (entry) => entry.event === "webview-ready",
      );
      const navigationIndex = log.findIndex(
        (entry) => entry.event === "navigation",
      );
      assert.ok(
        readyIndex >= 0 && navigationIndex > readyIndex,
        "navigation preceded rule installation",
      );
      process.kill(child.pid, "SIGTERM");
      assert.equal(
        await Promise.race([
          child.exited,
          Bun.sleep(5000).then(() => "timeout"),
        ]),
        0,
        "resource checks must not stall graceful shutdown",
      );
      assert.equal(
        (await hostLog()).find((entry) => entry.event === "host-stopped")
          ?.forced,
        false,
      );
    } finally {
      if (child) {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        await child.exited;
      }
      allowed.stop(true);
      blocked.stop(true);
      await updateAsset("assets/app.json", configText);
      await updateAsset("assets/policy.json", policyText);
    }
  });

  await test("loopback development page uses the SDK bridge and websocket updates without restarting the host", async () => {
    await resetData();
    const entry = join(diagnostics, "development-page.ts");
    await writeFile(
      entry,
      `
      import { createClient, createWebViewTransport } from ${JSON.stringify(Bun.resolveSync("@bunaway/client", import.meta.dir))};
      const client = createClient({ transport: createWebViewTransport(window.chrome.webview), hello: { kind: 'hello', protocol: { major: 1, minor: 0 }, features: [], buildId: 'development-page' } });
      await client.ready;
      const echo = await client.invoke('test.echo', { message: 'development bridge' });
      const socket = new WebSocket(location.origin.replace('http', 'ws') + '/hmr');
      socket.onmessage = async (event) => {
        document.body.textContent = event.data;
        await client.invoke('test.report', { file: 'development.json', report: { page: 'development', results: [{ name: 'bridge', ok: echo.message === 'development bridge' }, { name: event.data, ok: true }] } });
      };
    `,
    );
    const bundle = await Bun.build({
      entrypoints: [
        entry,
      ],
      target: "browser",
    });
    assert(bundle.success && bundle.outputs[0], bundle.logs.join("\n"));
    const script = await bundle.outputs[0].text();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (path === "/hmr" && server.upgrade(request)) {
          return;
        }
        if (path === "/main.js") {
          return new Response(script, {
            headers: {
              "Content-Type": "application/javascript",
            },
          });
        }
        return new Response('<script type="module" src="/main.js"></script>', {
          headers: {
            "Content-Type": "text/html",
          },
        });
      },
      websocket: {
        open(socket) {
          socket.subscribe("hmr");
          socket.send("first");
        },
        message() {},
      },
    });
    const url = `http://127.0.0.1:${server.port}/`;
    const configText = await readFile(
      join(packagePath, "assets/app.json"),
      "utf8",
    );
    const policyText = await readFile(
      join(packagePath, "assets/policy.json"),
      "utf8",
    );
    let child: ReturnType<typeof launch> | undefined;
    try {
      const config = JSON.parse(configText);
      const policy = JSON.parse(policyText);
      config.home = url;
      config.development = {
        url,
      };
      policy.views[0].origins = [
        new URL(url).origin,
      ];
      await updateAsset("assets/app.json", JSON.stringify(config));
      await updateAsset("assets/policy.json", JSON.stringify(policy));
      const unflagged = launch();
      assert.notEqual(
        await unflagged.exited,
        0,
        "Development artifacts require --dev-url.",
      );
      child = launch({}, [
        "--dev-url",
        url,
      ]);
      const first = await reportFile("development.json");
      assert.deepEqual(first.results, [
        {
          name: "bridge",
          ok: true,
        },
        {
          name: "first",
          ok: true,
        },
      ]);
      server.publish("hmr", "updated");
      await waitFor(async () =>
        (await readReport(join(dataRoot, "temp/development.json")))?.results[1]
          ?.name === "updated"
          ? true
          : null,
      );
      const sessions = (await hostLog()).filter(
        (entry) => entry.event === "session-open",
      );
      assert.equal(
        sessions.length,
        1,
        "UI update restarted the bridge session.",
      );
      assert.equal(sessions[0]?.origin, new URL(url).origin);
      await gracefulStop(child);
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child?.exited;
      server.stop(true);
      await updateAsset("assets/app.json", configText);
      await updateAsset("assets/policy.json", policyText);
    }
  });

  await test("renderer recreation restores command and event sessions without restarting Bun", async () => {
    await resetData();
    const configPath = join(packagePath, "assets", "app.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.home = "https://app.bunaway.local/index.html?nativePlugins=0";
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
      const report = await reportFile("report3.json");
      assert.ok(report.results.length > 0);
      for (const result of report.results) {
        assert.equal(result.ok, true, result.name);
      }
      {
        // WebContent renderers of this app's webview are the post-launch delta.
        const pids = await waitFor(async () => {
          const fresh = await newWebContentPids();
          return fresh.length ? fresh : null;
        });
        const beforeCrash = (await hostLog()).length;
        await rm(join(dataRoot, "temp", "report3.json"));
        terminateRenderers(pids);
        await waitFor(
          async () =>
            (await hostLog())
              .slice(beforeCrash)
              .find((entry) => entry.event === "webview-process-failed") ??
            null,
        );
        const restored = await reportFile("report3.json");
        for (const result of restored.results) {
          assert.equal(result.ok, true, `renderer recreation: ${result.name}`);
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
        started.childPid as number,
      ]);
      await gracefulStop(child);
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

  await test("killing the host still removes bundled Bun via the guard", async () => {
    await resetData();
    const child = launch();
    try {
      const started = await waitLog((e) => e.event === "host-started");
      const childPid = started.childPid as number;
      const guardPid = started.guardPid as number;
      // Wait for ready so the kill cannot land inside the spawn->guard window.
      await waitLog((e) => e.event === "backend-ready");
      const exited = await watch([
        childPid,
        guardPid,
        `g${childPid}`,
      ]);
      process.kill(child.pid, "SIGKILL");
      assert.notEqual(await child.exited, 0);
      await exited();
    } finally {
      if (!child.killed) {
        child.kill();
      }
      await child.exited;
    }
  });

  await test("runtime starts with read-only assets and no bundled tmp directory", async () => {
    await resetData();
    const assets = join(packagePath, "assets");
    await rm(join(assets, "tmp"), {
      recursive: true,
      force: true,
    });
    await chmod(assets, 0o555);
    let child: ReturnType<typeof launch> | undefined;
    try {
      child = launch();
      await waitLog((entry) => entry.event === "backend-ready");
      assert.equal(existsSync(join(assets, "tmp")), false);
      await gracefulStop(child);
    } finally {
      if (child) {
        if (!child.killed) {
          child.kill();
        }
        await child.exited;
      }
      await chmod(assets, 0o755);
    }
  });
} finally {
  if (app) {
    // Restore signed bundle contents before resealing, including when an earlier assertion failed.
    await chmod(assets, 0o755);
    for (const { path, bytes } of savedResources) {
      await writeFile(path, bytes);
    }
    await rm(assetsTmp, {
      recursive: true,
      force: true,
    });
    if (hadTmp) {
      await cp(savedTmp, assetsTmp, {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
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
  await writeTestOutput(out, `${JSON.stringify(summary, null, 2)}\n`);
  verifyApp();
  console.log(`Wrote ${out}`);
}
console.log("macos-host: all checks passed");

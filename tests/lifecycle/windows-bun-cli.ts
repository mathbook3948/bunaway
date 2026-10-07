import { dlopen } from "bun:ffi";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createProject } from "../cli/project.ts";
import { verifyWindowsLaunch, windowsLaunchEnvironment } from "../../packages/cli/src/launch.ts";
import { findIscc, must } from "../../packages/packaging/src/channels/windows/common.ts";
import { recordPackagedHashes } from "../../packages/packaging/src/channels/windows/manifest.ts";
import type { PackageReport } from "../../packages/packaging/src/contract.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const home = resolve(root, `build/windows-bun-cli-${crypto.randomUUID()}`);
const launchMarker = resolve(home, "launch-marker.txt");
await mkdir(home, { recursive: true });
await createProject(resolve(home, "created"));
const project = resolve(home, "moved app 한글");
await rename(resolve(home, "created"), project);
async function command(args: string[], cwd = project) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = new Response(child.stdout).text();
  const err = new Response(child.stderr).text();
  assert.equal(await child.exited, 0, await err);
  return out;
}
await command(["install"]);
const snapshot = resolve(project, "node_modules/@bunaway/cli");
const cache = resolve(snapshot, "runtime/bun-bundle/vendor");
await mkdir(cache, { recursive: true });
for (const name of ["bun-windows-x64-baseline.zip", "bun-windows-x64-baseline", "LICENSE.bun"])
  await cp(resolve(root, "runtime/bun-bundle/vendor", name), resolve(cache, name), {
    recursive: true,
  });
const sdk = resolve(snapshot, "native/windows/bun/vendor");
await mkdir(sdk, { recursive: true });
await cp(
  resolve(root, "native/windows/bun/vendor/webview2-1.0.4129.50.nupkg"),
  resolve(sdk, "webview2-1.0.4129.50.nupkg"),
);
assert(
  !existsSync(resolve(snapshot, "native/windows/host")) &&
    !existsSync(resolve(snapshot, "native/windows/probe")),
  "Windows package must not include the old host or process probe",
);
await appendFile(
  resolve(project, "src-bunaway/app.ts"),
  `\nawait Bun.write(${JSON.stringify(launchMarker)}, "started");\n` +
    'const fixtureChild = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); console.log(JSON.stringify({ event: "fixture-child", pid: fixtureChild.pid }));\n',
);
// A user entry named boot.ts must coexist with the framework's bootstrap.
await writeFile(resolve(project, "src-bunaway/boot.ts"), 'export { default } from "./app.ts";\n');
const configPath = resolve(project, "src-bunaway/bunaway.json");
const projectConfig = JSON.parse(await readFile(configPath, "utf8"));
await writeFile(
  configPath,
  JSON.stringify({
    ...projectConfig,
    build: { ...projectConfig.build, app: "src-bunaway/boot.ts" },
  }),
);
await appendFile(
  resolve(project, "src/main.ts"),
  '\nawait client.invoke("message.save", "CLI FFI 한글"); if (await client.invoke("message.read", null) !== "CLI FFI 한글") throw new Error("CLI storage roundtrip failed"); window.close();\n',
);
await command(["run", "typecheck"]);
console.log(await command(["run", "build"]));
const packageRoot = resolve(project, "dist/windows-x64");
assert(!existsSync(resolve(packageRoot, "bunaway-host.exe")));
assert(!existsSync(resolve(packageRoot, "assets/backend.js")));
assert(!existsSync(resolve(packageRoot, "licenses/LICENSE.nlohmann-json")));
await verifyWindowsLaunch(packageRoot);
const api = dlopen("kernel32.dll", {
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
  WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
  CloseHandle: { args: ["u64"], returns: "i32" },
});
const child = Bun.spawn(
  [
    resolve(packageRoot, "runtime/bun.exe"),
    "--no-env-file",
    "--no-install",
    `--config=${resolve(packageRoot, "assets/bunfig.toml")}`,
    `--tsconfig-override=${resolve(packageRoot, "assets/tsconfig.json")}`,
    resolve(packageRoot, "assets/boot.js"),
  ],
  {
    cwd: home,
    env: windowsLaunchEnvironment({
      ...process.env,
      BUN_OPTIONS: "--preload ./hostile.ts",
      BUNAWAY_HOSTILE: "pollution",
    }),
    stdout: "pipe",
    stderr: "pipe",
  },
);
let handle = 0n;
let buffer = "";
const decoder = new TextDecoder();
const output = child.stdout.pipeTo(
  new WritableStream({
    write(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.event === "fixture-child") {
          handle = api.symbols.OpenProcess(0x100000, 0, event.pid);
          assert(handle);
        }
      }
    },
  }),
);
const errors = new Response(child.stderr).text();
const deadline = setTimeout(() => child.kill(), 90000);
try {
  assert.equal(await child.exited, 0, await errors);
  await output;
  assert(handle, "App module child was not observed");
  // The parent exit notification can precede the Job's child termination signal.
  assert.equal(
    api.symbols.WaitForSingleObject(handle, 5000),
    0,
    "App Job must reap descendants spawned during module import",
  );
  const config = JSON.parse(await readFile(resolve(packageRoot, "assets/app.json"), "utf8"));
  assert.equal(
    await readFile(
      resolve(process.env.LOCALAPPDATA ?? "", "bunaway", config.appId, "data/messages/current.txt"),
      "utf8",
    ),
    "CLI FFI 한글",
  );
  const boot = resolve(packageRoot, "assets/app.js");
  const original = await readFile(boot);
  await writeFile(boot, "throw new Error('tampered')");
  await assert.rejects(verifyWindowsLaunch(packageRoot), /Hash mismatch/);
  await writeFile(boot, original);
  async function launch(directory: string) {
    await rm(launchMarker, { force: true });
    const launcher = Bun.spawn(
      [
        resolve(
          process.env.SystemRoot ?? "C:/Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve(directory, "launch.ps1"),
        "-Wait",
      ],
      {
        cwd: home,
        env: {
          ...process.env,
          BUN_OPTIONS: "--preload ./hostile.ts",
          BUNAWAY_HOSTILE: "pollution",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = new Response(launcher.stdout).text();
    const stderr = new Response(launcher.stderr).text();
    const timeout = setTimeout(() => launcher.kill(), 60000);
    try {
      return { code: await launcher.exited, stdout: await stdout, stderr: await stderr };
    } finally {
      clearTimeout(timeout);
    }
  }
  const unsignedLaunch = await launch(packageRoot);
  assert.equal(unsignedLaunch.code, 0, unsignedLaunch.stderr);
  assert.equal(await readFile(launchMarker, "utf8"), "started");

  const packagedRoot = resolve(home, "packaged app 한글");
  await cp(packageRoot, packagedRoot, { recursive: true });
  const upstream = JSON.parse(await readFile(resolve(packageRoot, "manifest.json"), "utf8"));
  // A PE overlay changes the bytes while preserving execution, without a test certificate.
  // This exercises the post-signing digest contract, not Authenticode trust.
  const packagedBun = resolve(packagedRoot, "runtime/bun.exe");
  await appendFile(packagedBun, "bunaway signing-byte-change fixture");
  const packaged = await recordPackagedHashes(packagedRoot);
  assert.equal(packaged.bun.executableSha256, upstream.bun.executableSha256);
  assert.notEqual(packaged.bun.packagedSha256, upstream.bun.executableSha256);
  await verifyWindowsLaunch(packageRoot);
  await verifyWindowsLaunch(packagedRoot);
  const packagedLaunch = await launch(packagedRoot);
  assert.equal(packagedLaunch.code, 0, packagedLaunch.stderr);
  assert.equal(await readFile(launchMarker, "utf8"), "started");
  await appendFile(packagedBun, "tampered after packaging");
  await assert.rejects(verifyWindowsLaunch(packagedRoot), /Hash mismatch/);
  const tamperedLaunch = await launch(packagedRoot);
  assert.notEqual(tamperedLaunch.code, 0);
  assert.match(tamperedLaunch.stderr, /Package hash mismatch/);
  assert(!existsSync(launchMarker), "Tampered runtime must be rejected before app import");
  if (await findIscc()) {
    await writeFile(
      configPath,
      JSON.stringify({
        ...JSON.parse(await readFile(configPath, "utf8")),
        bundle: {
          identifier: `test.bunaway.${crypto.randomUUID()}`,
          channels: {
            "win-direct": { webView2: "check", startMenuShortcut: false, desktopShortcut: false },
          },
        },
      }),
    );
    console.log(await command(["run", "package", "win-direct"]));
    const report = JSON.parse(
      await readFile(resolve(packageRoot, "packaged/win-direct-report.json"), "utf8"),
    ) as PackageReport;
    assert(report.ok && report.usable);
    const installer = report.artifacts.find((artifact) => artifact.kind === "installer");
    assert(installer);
    const installed = resolve(home, "installed app 한글");
    const uninstaller = resolve(installed, "unins000.exe");
    const silent = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"];
    try {
      await must(installer.path, ["/SP-", ...silent, `/DIR=${installed}`]);
      const installedLaunch = await launch(installed);
      assert.equal(installedLaunch.code, 0, installedLaunch.stderr);
      assert.equal(await readFile(launchMarker, "utf8"), "started");
      await verifyWindowsLaunch(packageRoot);
    } finally {
      if (existsSync(uninstaller)) {
        await must(uninstaller, silent);
        for (let retry = 0; retry < 100 && existsSync(uninstaller); retry++) await Bun.sleep(50);
        assert(!existsSync(uninstaller), "Fixture uninstaller did not finish");
      }
    }
    assert.equal(
      await readFile(
        resolve(
          process.env.LOCALAPPDATA ?? "",
          "bunaway",
          config.appId,
          "data/messages/current.txt",
        ),
        "utf8",
      ),
      "CLI FFI 한글",
    );
    console.log(
      "PASS Windows Bun FFI CLI installer, installed launcher, uninstall and data preservation",
    );
  } else {
    console.log("SKIP Windows Bun FFI installer: Inno Setup is unavailable");
  }
  // Serve the real SDK UI over HTTP; dev owns that server and cleans it up when the window closes.
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const devPort = reservation.port;
  reservation.stop(true);
  const devUrl = `http://127.0.0.1:${devPort}/`;
  const requested = resolve(project, "development-page-requested.txt");
  await writeFile(
    resolve(project, "development-server.ts"),
    `
    import { resolve } from 'node:path';
    Bun.serve({ hostname: '127.0.0.1', port: ${devPort}, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/main.js') await Bun.write(${JSON.stringify(requested)}, 'requested');
      if (!['/', '/index.html', '/main.js', '/style.css'].includes(path)) return new Response('', {status:404});
      return new Response(Bun.file(resolve('dist/windows-x64/assets/web', path === '/' ? 'index.html' : path.slice(1))));
    }});
  `,
  );
  const previousConfig = await readFile(configPath, "utf8");
  await writeFile(
    configPath,
    JSON.stringify({
      ...JSON.parse(previousConfig),
      dev: { command: ["bun", "development-server.ts"], url: devUrl },
    }),
  );
  const development = Bun.spawn([process.execPath, "run", "dev"], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  const devOutput = new Response(development.stdout).text();
  const devErrors = new Response(development.stderr).text();
  const devDeadline = setTimeout(() => development.kill(), 90000);
  try {
    assert.equal(await development.exited, 0, await devErrors);
    assert.match(await devOutput, /Frontend server ready/);
    assert.equal(
      await readFile(requested, "utf8"),
      "requested",
      "WebView did not load the HTTP SDK UI.",
    );
    const devApp = JSON.parse(
      await readFile(resolve(project, ".bunaway/windows-x64/assets/app.json"), "utf8"),
    );
    assert.equal(devApp.home, devUrl);
    assert.deepEqual(devApp.development, { url: devUrl });
    await assert.rejects(
      fetch(devUrl, { signal: AbortSignal.timeout(1000) }),
      "Dev server survived window close.",
    );
  } finally {
    clearTimeout(devDeadline);
    if (development.exitCode === null) development.kill();
    await development.exited;
    await writeFile(configPath, previousConfig);
  }
  console.log(
    "PASS loopback development server, real WebView SDK/storage roundtrip and server teardown",
  );
  console.log(
    "PASS moved project uses its own Windows Bun/FFI snapshot, real SDK/storage, sanitized launch, post-signing digests, tamper rejection and Job cleanup",
  );
} finally {
  clearTimeout(deadline);
  if (handle) assert(api.symbols.CloseHandle(handle));
  api.close();
}

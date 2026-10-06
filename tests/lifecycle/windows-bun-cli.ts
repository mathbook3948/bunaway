import assert from "node:assert/strict";
import { dlopen } from "bun:ffi";
import { cp, mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createProject } from "../../packages/cli/src/create.ts";
import { verifyWindowsLaunch, windowsLaunchEnvironment } from "../../packages/cli/src/launch.ts";

assert.equal(process.platform, "win32");
const root = resolve(import.meta.dir, "../..");
const home = resolve(root, `build/windows-bun-cli-${crypto.randomUUID()}`);
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
const snapshot = resolve(project, "vendor/bunaway");
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
  "Windows snapshot must not include the old host or process probe",
);
await appendFile(
  resolve(project, "src/backend/app.ts"),
  '\nconst fixtureChild = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); console.log(JSON.stringify({ event: "fixture-child", pid: fixtureChild.pid }));\n',
);
// A user entry named boot.ts must coexist with the framework's bootstrap.
await writeFile(resolve(project, "src/backend/boot.ts"), 'export { default } from "./app.ts";\n');
const configPath = resolve(project, "bunaway.json");
const projectConfig = JSON.parse(await readFile(configPath, "utf8"));
await writeFile(
  configPath,
  JSON.stringify({ ...projectConfig, windowsApp: "src/backend/boot.ts" }),
);
await appendFile(
  resolve(project, "src/web/main.ts"),
  '\nawait client.ready; await client.invoke("message.save", "CLI FFI 한글"); if (await client.invoke("message.read", null) !== "CLI FFI 한글") throw new Error("CLI storage roundtrip failed"); window.close();\n',
);
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
  assert.equal(
    api.symbols.WaitForSingleObject(handle, 0),
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
  const launcher = Bun.spawn(
    ["pwsh", "-NoProfile", "-File", resolve(packageRoot, "launch.ps1"), "-Wait"],
    {
      cwd: home,
      env: { ...process.env, BUN_OPTIONS: "--preload ./hostile.ts", BUNAWAY_HOSTILE: "pollution" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const launcherOutput = new Response(launcher.stdout).text();
  const launcherErrors = new Response(launcher.stderr).text();
  const launcherTimeout = setTimeout(() => launcher.kill(), 60000);
  try {
    assert.equal(await launcher.exited, 0, await launcherErrors);
    await launcherOutput;
  } finally {
    clearTimeout(launcherTimeout);
  }
  console.log(
    "PASS moved project uses its own Windows Bun/FFI snapshot, real SDK/storage, sanitized launch, pre-execution hashes and Job cleanup",
  );
} finally {
  clearTimeout(deadline);
  if (handle) assert(api.symbols.CloseHandle(handle));
  api.close();
}

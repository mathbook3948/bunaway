import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleWindowsHost } from "../../packages/cli/src/assets.ts";
import { hash, writeJson } from "../../packages/cli/src/files.ts";

test.skipIf(process.platform !== "win32")(
  "Windows PowerShell launcher verifies UTF-8 asset paths before starting Bun",
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bunaway-launcher-"));
    try {
      await mkdir(resolve(root, "runtime"));
      await mkdir(resolve(root, "assets"));
      await cp(process.execPath, resolve(root, "runtime/bun.exe"));
      const assets: Record<string, string> = {};
      for (const [name, text] of Object.entries({
        "한글-😀.txt": "launcher verified",
        "boot.js":
          'await Bun.write(new URL("../started.txt", import.meta.url), await Bun.file(new URL("./한글-😀.txt", import.meta.url)).text()); await Bun.write(new URL("../launch.json", import.meta.url), Buffer.from(process.argv[3], "base64"));',
        "bunfig.toml": "env = false\n",
        "tsconfig.json": "{}",
      })) {
        const path = resolve(root, "assets", name);
        await writeFile(path, text);
        assets[`assets/${name}`] = await hash(path);
      }
      await writeJson(resolve(root, "manifest.json"), { assets });
      const launcher = await readFile(
        resolve(import.meta.dir, "../../native/windows/bun/launch.ps1"),
        "utf8",
      );
      await writeFile(
        resolve(root, "launch.ps1"),
        launcher.replace("__BUN_SHA256__", await hash(process.execPath)),
      );
      for (const argv of [
        [],
        ["한글 파일.txt", "memo://open?id=42&mode=edit"],
        ["--", "-draft.txt", "-Wait", "-Verbose", "-Debug", "-ErrorAction", "Stop"],
        ['a"b', "C:\\tail\\", ""],
      ]) {
        const child = Bun.spawn(
          [
            resolve(
              process.env.SystemRoot ?? "C:/Windows",
              "System32/WindowsPowerShell/v1.0/powershell.exe",
            ),
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            resolve(root, "launch.ps1"),
            "-Wait",
            ...argv,
          ],
          // Let Windows PowerShell use its own modules, not an inherited pwsh module path.
          { stdout: "pipe", stderr: "pipe", env: { ...process.env, PSModulePath: undefined } },
        );
        const output = new Response(child.stdout).text();
        const errors = new Response(child.stderr).text();
        const timeout = setTimeout(() => child.kill(), 20000);
        try {
          expect(await child.exited, await errors).toBe(0);
          await output;
          expect(await readFile(resolve(root, "started.txt"), "utf8")).toBe("launcher verified");
          expect(JSON.parse(await readFile(resolve(root, "launch.json"), "utf8"))).toEqual({
            argv,
            cwd: process.cwd(),
          });
        } finally {
          clearTimeout(timeout);
          if (child.exitCode === null) child.kill();
          await child.exited;
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

test("Windows app entry names cannot collide with the host or break shared bundle imports", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-windows-assets-"));
  const host = resolve(import.meta.dir, "../../native/windows/bun");
  const protocol = resolve(import.meta.dir, "../../packages/protocol/src/index.ts");
  try {
    for (const name of ["boot.ts", "app.ts", "ui.ts"]) {
      const entry = resolve(root, name);
      const destination = resolve(root, `out-${name}`);
      await mkdir(destination);
      await writeFile(
        entry,
        `import { BunawayError } from ${JSON.stringify(protocol)}; export default { commands: {}, events: {}, name: ${JSON.stringify(name)}, error: new BunawayError({ code: "CANCELLED", message: "test" }) };`,
      );
      await bundleWindowsHost(host, destination, entry);
      const outputs = await readdir(destination);
      for (const expected of ["boot.js", "app.js", "ui.js", "host-operations.js"])
        expect(outputs).toContain(expected);
      expect(outputs.some((output) => output.startsWith("chunk-"))).toBe(true);
      const app = (await import(pathToFileURL(resolve(destination, "app.js")).href)).default;
      expect(app.name).toBe(name);
      expect(app.error.code).toBe("CANCELLED");
      expect(await readFile(resolve(destination, "boot.js"), "utf8")).toContain(
        "verifyWindowsPackage",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

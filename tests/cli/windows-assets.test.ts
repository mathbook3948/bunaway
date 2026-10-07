import { expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
        "boot.js": `import { readLaunchArguments } from ${JSON.stringify(new URL("../../native/windows/bun/instance.ts", import.meta.url).href)}; if (process.argv[2] !== "--launch-stdin") throw new Error("Missing stdin launch flag"); await Bun.write(new URL("../started.txt", import.meta.url), await Bun.file(new URL("./한글-😀.txt", import.meta.url)).text()); await Bun.write(new URL("../launch.json", import.meta.url), JSON.stringify(await readLaunchArguments(Bun.stdin.stream())));`,
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
        ...[128, 256].map((count) =>
          Array.from({ length: count }, (_, index) => `${"가".repeat(70)}${index}.txt`),
        ),
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
    await mkdir(resolve(root, "modules"));
    await writeFile(
      resolve(root, "modules/plugin-table.ts"),
      'export const userTable = "app table";',
    );
    for (const name of ["boot.ts", "app.ts", "ui.ts", "plugin-table.ts"]) {
      const entry = resolve(root, name);
      const destination = resolve(root, `out-${name}`);
      await mkdir(destination);
      await writeFile(
        entry,
        `import { BunawayError } from ${JSON.stringify(protocol)}; import { userTable } from "./modules/plugin-table.ts"; export default { commands: {}, events: {}, name: ${JSON.stringify(name)}, userTable, error: new BunawayError({ code: "CANCELLED", message: "test" }) };`,
      );
      await bundleWindowsHost(host, destination, entry);
      const outputs = await readdir(destination);
      for (const expected of ["boot.js", "app.js", "ui.js", "host-operations.js"])
        expect(outputs).toContain(expected);
      expect(outputs.some((output) => output.startsWith("chunk-"))).toBe(true);
      const app = (await import(pathToFileURL(resolve(destination, "app.js")).href)).default;
      expect(app.name).toBe(name);
      expect(app.userTable).toBe("app table");
      expect(app.error.code).toBe("CANCELLED");
      expect(await readFile(resolve(destination, "boot.js"), "utf8")).toContain(
        "verifyWindowsPackage",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development Windows bundles map exceptions to the original TypeScript file and line", async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-debug-assets-")));
  const host = resolve(import.meta.dir, "../../native/windows/bun");
  const entry = resolve(root, "src-bunaway/app.ts");
  const source =
    'export default {\n  run() {\n    throw new Error("source-map-check");\n  },\n};\n';
  try {
    await mkdir(resolve(root, "src-bunaway"));
    await writeFile(entry, source);
    for (const development of [false, true]) {
      const packageRoot = resolve(root, development ? ".bunaway/windows-x64" : "dist/windows-x64");
      const staging = `${packageRoot}.building`;
      await mkdir(resolve(staging, "assets"), { recursive: true });
      await bundleWindowsHost(host, resolve(staging, "assets"), entry, undefined, development);
      await rename(staging, packageRoot);
      const destination = resolve(packageRoot, "assets");
      for (const name of await readdir(destination)) {
        if (!name.endsWith(".js")) continue;
        const text = await readFile(resolve(destination, name), "utf8");
        expect(text.includes("sourceMappingURL=data:"), name).toBe(development);
        if (name === "app.js" && development) {
          const encoded = text.match(
            /sourceMappingURL=data:application\/json;base64,([^\s]+)/,
          )?.[1];
          expect(encoded).toBeDefined();
          const map = JSON.parse(Buffer.from(encoded ?? "", "base64").toString());
          expect(map.sourcesContent).toContain(source);
          expect(map.sources).toContain(entry.replaceAll("\\", "/"));
        }
      }
      const runner = resolve(destination, "run.ts");
      await writeFile(
        runner,
        'import app from "./app.js"; try { app.run(); } catch (error) { console.log(JSON.stringify(error.stack)); throw error; }',
      );
      const child = Bun.spawn([process.execPath, runner], {
        cwd: packageRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stack = new Response(child.stdout).json();
      const errors = new Response(child.stderr).text();
      expect(await child.exited).not.toBe(0);
      const output = await errors;
      expect(output).toContain("source-map-check");
      expect(output).toContain(development ? `${entry}:3:` : "app.js:");
      expect(await stack).toContain(development ? `${entry}:3:` : "app.js:");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

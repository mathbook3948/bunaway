import { expect, test } from "bun:test";
import {
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
import { webAsset } from "../../native/windows/bun/web-assets.ts";
import { bundleWindowsHost } from "../../packages/cli/src/assets.ts";

test("embedded web responses preserve MIME, Unicode paths, HEAD and ranges without exposing host assets", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-web-assets-"));
  try {
    await mkdir(resolve(root, "web"));
    await writeFile(resolve(root, "web/index.html"), "<h1>hello</h1>");
    await writeFile(resolve(root, "web/한글 😀.txt"), "0123456789");
    await writeFile(resolve(root, "policy.json"), "private");
    const url = "https://app.bunaway.local/";
    const text = `${url}${encodeURIComponent("한글 😀.txt")}?v=1`;
    expect(webAsset(root, url, "GET").headers).toContain(
      "Content-Type: text/html",
    );
    expect(webAsset(root, text, "GET").body.toString()).toBe("0123456789");
    expect(webAsset(root, text, "HEAD").body.length).toBe(0);
    expect(webAsset(root, text, "HEAD").headers).toContain(
      "Content-Length: 10",
    );
    expect(webAsset(root, text, "GET", "bytes=2-4").body.toString()).toBe(
      "234",
    );
    expect(webAsset(root, text, "GET", "bytes=-3").body.toString()).toBe("789");
    expect(webAsset(root, text, "GET", "bytes=20-").status).toBe(416);
    expect(webAsset(root, text, "POST").status).toBe(405);
    for (const path of [
      "missing",
      "policy.json",
      "..%2fpolicy.json",
      "..%5cpolicy.json",
      "%00",
    ]) {
      expect(webAsset(root, url + path, "GET").status).toBe(404);
    }
    expect(webAsset(root, "https://other.local/index.html", "GET").status).toBe(
      403,
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("Windows app entry names cannot collide with the host or break shared bundle imports", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "bunaway-windows-assets-"));
  const host = resolve(import.meta.dir, "../../native/windows/bun");
  const protocol = resolve(
    import.meta.dir,
    "../../packages/protocol/src/index.ts",
  );
  try {
    await mkdir(resolve(root, "modules"));
    await writeFile(
      resolve(root, "modules/plugin-table.ts"),
      'export const userTable = "app table";',
    );
    for (const name of [
      "boot.ts",
      "app.ts",
      "ui.ts",
      "plugin-table.ts",
    ]) {
      const entry = resolve(root, name);
      const destination = resolve(root, `out-${name}`);
      await mkdir(destination);
      await writeFile(
        entry,
        `import { BunawayError } from ${JSON.stringify(protocol)}; import { userTable } from "./modules/plugin-table.ts"; export default { commands: {}, events: {}, name: ${JSON.stringify(name)}, userTable, error: new BunawayError({ code: "CANCELLED", message: "test" }) };`,
      );
      await bundleWindowsHost(host, destination, entry);
      const outputs = await readdir(destination);
      for (const expected of [
        "boot.js",
        "app.js",
        "ui.js",
        "host-operations.js",
      ]) {
        expect(outputs).toContain(expected);
      }
      expect(outputs.some((output) => output.startsWith("chunk-"))).toBe(true);
      const app = (
        await import(pathToFileURL(resolve(destination, "app.js")).href)
      ).default;
      expect(app.name).toBe(name);
      expect(app.userTable).toBe("app table");
      expect(app.error.code).toBe("CANCELLED");
      expect(await readFile(resolve(destination, "boot.js"), "utf8")).toContain(
        "verifyWindowsPackage",
      );
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test("development Windows bundles map exceptions to the original TypeScript file and line", async () => {
  const root = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-debug-assets-")),
  );
  const host = resolve(import.meta.dir, "../../native/windows/bun");
  const entry = resolve(root, "src-bunaway/app.ts");
  const source =
    'export default {\n  run() {\n    throw new Error("source-map-check");\n  },\n};\n';
  try {
    await mkdir(resolve(root, "src-bunaway"));
    await writeFile(entry, source);
    for (const development of [
      false,
      true,
    ]) {
      const packageRoot = resolve(
        root,
        development ? ".bunaway/windows-x64" : "dist/windows-x64",
      );
      const staging = `${packageRoot}.building`;
      await mkdir(resolve(staging, "assets"), {
        recursive: true,
      });
      await bundleWindowsHost(
        host,
        resolve(staging, "assets"),
        entry,
        undefined,
        development,
      );
      await rename(staging, packageRoot);
      const destination = resolve(packageRoot, "assets");
      for (const name of await readdir(destination)) {
        if (!name.endsWith(".js")) {
          continue;
        }
        const text = await readFile(resolve(destination, name), "utf8");
        expect(text.includes("sourceMappingURL=data:"), name).toBe(development);
        if (name === "app.js" && development) {
          const encoded = text.match(
            /sourceMappingURL=data:application\/json;base64,([^\s]+)/,
          )?.[1];
          expect(encoded).toBeDefined();
          const map = JSON.parse(
            Buffer.from(encoded ?? "", "base64").toString(),
          );
          expect(map.sourcesContent).toContain(source);
          expect(map.sources).toContain(entry.replaceAll("\\", "/"));
        }
      }
      const runner = resolve(destination, "run.ts");
      await writeFile(
        runner,
        'import app from "./app.js"; try { app.run(); } catch (error) { console.log(JSON.stringify(error.stack)); throw error; }',
      );
      const child = Bun.spawn(
        [
          process.execPath,
          runner,
        ],
        {
          cwd: packageRoot,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stack = new Response(child.stdout).json();
      const errors = new Response(child.stderr).text();
      expect(await child.exited).not.toBe(0);
      const output = await errors;
      expect(output).toContain("source-map-check");
      expect(output).toContain(development ? `${entry}:3:` : "app.js:");
      expect(await stack).toContain(development ? `${entry}:3:` : "app.js:");
    }
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

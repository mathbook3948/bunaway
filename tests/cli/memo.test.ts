import { expect, test } from "bun:test";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { bundleAssets } from "../../packages/cli/src/build.ts";
import { validateProject } from "../../packages/cli/src/config.ts";
import { packageDirectory } from "./project.ts";
import { verifyViteDevelopment } from "./vite.ts";

test("memo example installs and bundles as a standalone CLI app with one view", async () => {
  const root = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-memo-")),
  );
  try {
    const project = resolve(root, "examples/memo");
    await cp(await packageDirectory(), resolve(root, "build/framework"), {
      recursive: true,
    });
    await cp(resolve(import.meta.dir, "../../examples/memo"), project, {
      recursive: true,
      filter: (source) =>
        !/[\\/](node_modules|\.bunaway|dist|web-dist|bun\.lock)([\\/]|$)/.test(
          source,
        ),
    });
    // Keep package downloads inside this temporary project tree for cleanup.
    const command = async (args: string[]) => {
      const child = Bun.spawn(
        [
          process.execPath,
          ...args,
        ],
        {
          cwd: project,
          env: {
            ...process.env,
            BUN_INSTALL_CACHE_DIR: resolve(root, "install-cache"),
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const errors = new Response(child.stderr).text();
      expect(await child.exited, await errors).toBe(0);
    };
    for (const args of [
      [
        "install",
      ],
      [
        resolve(import.meta.dir, "build.fixture.ts"),
        project,
      ],
      [
        "run",
        "bunaway",
        "validate",
      ],
    ]) {
      await command(args);
    }
    const definition = await validateProject(project);
    expect(definition.app.view).toBe("main");
    expect(definition.app.home).toBe("https://app.bunaway.local/index.html");
    expect(definition.policy.views.map((view) => view.id)).toEqual([
      "main",
    ]);
    expect(definition.policy.views[0]?.commands).toEqual([
      "memo.save",
      "memo.read",
    ]);
    await verifyViteDevelopment(definition);
    for (const windows of [
      false,
      true,
    ]) {
      const assets = resolve(
        root,
        windows ? "windows-assets" : "backend-assets",
      );
      await bundleAssets(definition, assets, windows);
      expect((await readdir(resolve(assets, "web"))).sort()).toEqual([
        "assets",
        "index.html",
      ]);
      const html = await readFile(resolve(assets, "web/index.html"), "utf8");
      expect(html).toContain("style-src 'self'");
      expect(html).not.toContain("unsafe-inline");
      expect(html).not.toContain("ws://");
      expect(html).not.toContain("/@vite/client");
      const entry = html.match(/src="\.\/([^"]+\.js)"/)?.[1];
      if (!entry) {
        throw new Error("Missing production UI entry.");
      }
      const frontend = await readFile(resolve(assets, "web", entry), "utf8");
      expect(frontend).not.toContain("test.report");
      expect(frontend).not.toContain("searchParams");
      if (windows) {
        const app = await import(resolve(assets, "app.js"));
        expect(Object.keys(app.default.commands).sort()).toEqual([
          "memo.read",
          "memo.save",
        ]);
      }
    }
    await command([
      "install",
      "--linker",
      "isolated",
      "--force",
    ]);
    await command([
      resolve(import.meta.dir, "build.fixture.ts"),
      project,
    ]);
    await command([
      "run",
      "bunaway",
      "validate",
    ]);
    await bundleAssets(
      await validateProject(project),
      resolve(root, "isolated-assets"),
      true,
    );
    const clientEntry = resolve(
      project,
      "node_modules/@bunaway/client/src/index.ts",
    );
    await writeFile(
      clientEntry,
      `${await readFile(clientEntry, "utf8")}\nexport const foreign = true;\n`,
    );
    await expect(validateProject(project)).rejects.toThrow(
      "Incompatible SDK resolution",
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}, 60000);

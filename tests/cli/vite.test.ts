import { expect, test } from "bun:test";
import {
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
import { hash, json, writeJson } from "../../packages/cli/src/files.ts";
import { main } from "../../packages/cli/src/main.ts";
import { templateNames } from "../../packages/cli/src/templates.ts";
import { packageDirectory } from "./project.ts";
import { verifyViteDevelopment } from "./vite.ts";

test("packed CLI creates independent templates and a Vite app with HMR and local assets", async () => {
  const root = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-vite-")),
  );
  try {
    const project = resolve(root, "Vite app");
    const packages = await packageDirectory();
    const unpack = Bun.spawn(
      [
        "tar",
        "-xzf",
        resolve(packages, "bunaway-cli-0.0.0.tgz"),
        "-C",
        root,
      ],
      {
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    expect(await unpack.exited, await new Response(unpack.stderr).text()).toBe(
      0,
    );
    // Unselected template files must never leak into the generated app.
    const artifact = resolve(root, "package");
    const inventoryPath = resolve(artifact, "artifact.files.json");
    const inventory = (await json(inventoryPath)) as Record<string, string>;
    for (const template of templateNames) {
      const name = `packages/cli/templates/${template}/${template}-only.txt`;
      await writeFile(resolve(artifact, name), template);
      inventory[name] = await hash(resolve(artifact, name));
    }
    await writeJson(inventoryPath, inventory);
    for (const [template, directory] of [
      [
        "vanilla",
        resolve(root, "Vanilla app"),
      ],
      [
        "vite",
        project,
      ],
      [
        "react",
        resolve(root, "React app"),
      ],
      [
        "vue",
        resolve(root, "Vue app"),
      ],
      [
        "svelte",
        resolve(root, "Svelte app"),
      ],
    ] as const) {
      const create = Bun.spawn(
        [
          process.execPath,
          resolve(artifact, "packages/cli/dist/distribution-main.js"),
          "create",
          directory,
          "--template",
          template,
          "--package-dir",
          packages,
        ],
        {
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      expect(
        await create.exited,
        await new Response(create.stderr).text(),
      ).toBe(0);
      expect(
        await Bun.file(resolve(directory, `${template}-only.txt`)).text(),
      ).toBe(template);
      for (const other of templateNames.filter((name) => name !== template)) {
        expect(
          await Bun.file(resolve(directory, `${other}-only.txt`)).exists(),
        ).toBe(false);
      }
      expect(await Bun.file(resolve(directory, ".gitignore")).exists()).toBe(
        true,
      );
      expect(
        await Bun.file(resolve(directory, ".gitattributes")).exists(),
      ).toBe(true);
      expect(
        await Bun.file(resolve(directory, "src-bunaway/app.ts")).text(),
      ).toContain("defineApp");
      expect(
        await Bun.file(
          resolve(directory, "src-bunaway/message/module.ts"),
        ).text(),
      ).toContain("defineModule");
      expect(
        await Bun.file(resolve(directory, "src-bunaway/src/app.ts")).exists(),
      ).toBe(false);
      expect(
        await Bun.file(resolve(directory, "src-bunaway/src/index.ts")).exists(),
      ).toBe(false);
    }
    for (const args of [
      [
        "install",
      ],
      [
        "run",
        "typecheck",
      ],
    ]) {
      const child = Bun.spawn(
        [
          process.execPath,
          ...args,
        ],
        {
          cwd: project,
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      expect(await child.exited, await new Response(child.stderr).text()).toBe(
        0,
      );
    }
    expect(await Bun.file(resolve(project, "index.html")).exists()).toBe(true);
    expect(await Bun.file(resolve(project, "src/index.html")).exists()).toBe(
      false,
    );
    // Development works before a frontend production build exists.
    const development = await validateProject(project, {
      development: true,
    });
    expect(
      await Bun.file(resolve(project, "web-dist/index.html")).exists(),
    ).toBe(false);
    await verifyViteDevelopment(development, "vite");
    const scripts = (await Bun.file(resolve(project, "package.json")).json())
      .scripts;
    expect(scripts.dev).toBe("bunaway dev");
    expect(scripts.build).toBe("bunaway build");
    expect(scripts.package).toBe("bunaway package");
    expect(development.buildCommand).toEqual([
      "bun",
      "run",
      "build:web",
    ]);
    for (const args of [
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
      const child = Bun.spawn(
        [
          process.execPath,
          ...args,
        ],
        {
          cwd: project,
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      expect(await child.exited, await new Response(child.stderr).text()).toBe(
        0,
      );
    }
    // Packaging with --build must regenerate an existing frontend output.
    const counter = resolve(project, "src/counter.ts");
    await writeFile(
      counter,
      (await readFile(counter, "utf8")).replace("Count is", "Latest count is"),
    );
    const packaged = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "build.fixture.ts"),
        project,
        "package",
        "win-direct",
        "--build",
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const packageOutput = new Response(packaged.stdout).text();
    const packageErrors = new Response(packaged.stderr).text();
    expect(
      await packaged.exited,
      `${await packageOutput}\n${await packageErrors}`,
    ).toBe(0);
    expect((await packageOutput).match(/Building frontend:/g)?.length).toBe(1);
    const production = await validateProject(project);
    expect(production.app.home).toBe("https://app.bunaway.local/index.html");
    expect(production.policy.views[0]?.origins).toEqual([
      "https://app.bunaway.local",
    ]);
    for (const windows of [
      false,
      true,
    ]) {
      const assets = resolve(
        root,
        windows ? "windows-assets" : "backend-assets",
      );
      await bundleAssets(production, assets, windows);
      const html = (
        await readFile(resolve(assets, "web/index.html"), "utf8")
      ).replaceAll("&#39;", "'");
      expect(html).not.toContain("/@vite/client");
      expect(html).not.toContain("unsafe-inline");
      expect(html).not.toContain("ws://");
      expect(html).toContain("default-src 'self'");
      expect(html).toContain("Vite + TS");
      const entry = html.match(/src="\.\/([^"]+\.js)"/)?.[1];
      if (!entry) {
        throw new Error("Missing packaged UI entry.");
      }
      expect(await Bun.file(resolve(assets, "web", entry)).exists()).toBe(true);
      const script = await readFile(resolve(assets, "web", entry), "utf8");
      expect(script).toContain("Latest count is");
      expect(script).toContain("Explore Vite");
      expect(script).not.toContain("data:image/");
      expect(await Bun.file(resolve(assets, "web/icons.svg")).exists()).toBe(
        true,
      );
      expect(await Bun.file(resolve(assets, "web/favicon.svg")).exists()).toBe(
        true,
      );
      expect(
        await readFile(resolve(assets, "web/LICENSE.vite.txt"), "utf8"),
      ).toContain("MIT License");
    }
    const built = resolve(project, "dist/windows-x64");
    const manifest = (await json(resolve(built, "manifest.json"))) as {
      assets: Record<string, string>;
      host: {
        kind: string;
        executable: string;
      };
    };
    expect(manifest.host.kind).toBe("bun-compiled");
    expect(
      await Bun.file(resolve(built, manifest.host.executable)).exists(),
    ).toBe(true);
    expect(await readdir(built)).not.toContain("assets");
    expect(
      Object.keys(manifest.assets).some((name) => name.startsWith("assets/")),
    ).toBe(false);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
}, 60000);

test("create rejects invalid template options before writing a project", async () => {
  for (const args of [
    [
      "--template",
      "unknown",
    ],
    [
      "--template",
    ],
    [
      "--template",
      "vite",
      "--template",
      "vanilla",
    ],
    [
      "--package-dir",
      "--template",
      "vite",
    ],
  ]) {
    await expect(
      main([
        "create",
        "unused-project",
        ...args,
      ]),
    ).rejects.toThrow("Usage");
  }
});

import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { bundleAssets } from "../../packages/cli/src/build.ts";
import { validateProject } from "../../packages/cli/src/config.ts";
import { main } from "../../packages/cli/src/main.ts";
import { packageDirectory } from "./project.ts";
import { verifyViteDevelopment } from "./vite.ts";

test("Vite template generates a relocatable app with HMR and local production assets", async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-vite-")));
  try {
    const project = resolve(root, "Vite app");
    const packages = await packageDirectory();
    const unpack = Bun.spawn(
      ["tar", "-xzf", resolve(packages, "bunaway-cli-0.0.0.tgz"), "-C", root],
      {
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    expect(await unpack.exited, await new Response(unpack.stderr).text()).toBe(0);
    const create = Bun.spawn(
      [
        process.execPath,
        resolve(root, "package/packages/cli/dist/distribution-main.js"),
        "create",
        project,
        "--template",
        "vite",
        "--package-dir",
        packages,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    expect(await create.exited, await new Response(create.stderr).text()).toBe(0);
    for (const args of [["install"], ["run", "typecheck"]]) {
      const child = Bun.spawn([process.execPath, ...args], {
        cwd: project,
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    }
    expect(await Bun.file(resolve(project, "index.html")).exists()).toBe(true);
    expect(await Bun.file(resolve(project, "src/index.html")).exists()).toBe(false);
    // Development works before a frontend production build exists.
    const development = await validateProject(project, { development: true });
    expect(await Bun.file(resolve(project, "web-dist/index.html")).exists()).toBe(false);
    await verifyViteDevelopment(development, "vite");
    for (const args of [
      ["run", "build"],
      ["run", "bunaway", "validate"],
    ]) {
      const child = Bun.spawn([process.execPath, ...args], {
        cwd: project,
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    }
    const production = await validateProject(project);
    expect(production.app.home).toBe("https://app.bunaway.local/index.html");
    expect(production.policy.views[0]?.origins).toEqual(["https://app.bunaway.local"]);
    for (const windows of [false, true]) {
      const assets = resolve(root, windows ? "windows-assets" : "backend-assets");
      await bundleAssets(production, assets, windows);
      const html = (await readFile(resolve(assets, "web/index.html"), "utf8")).replaceAll(
        "&#39;",
        "'",
      );
      expect(html).not.toContain("/@vite/client");
      expect(html).not.toContain("unsafe-inline");
      expect(html).not.toContain("ws://");
      expect(html).toContain("default-src 'self'");
      expect(html).toContain("Vite + TS");
      const entry = html.match(/src="\.\/([^"]+\.js)"/)?.[1];
      if (!entry) throw new Error("Missing packaged UI entry.");
      expect(await Bun.file(resolve(assets, "web", entry)).exists()).toBe(true);
      const script = await readFile(resolve(assets, "web", entry), "utf8");
      expect(script).toContain("Count is");
      expect(script).toContain("Explore Vite");
      expect(script).not.toContain("data:image/");
      expect(await Bun.file(resolve(assets, "web/icons.svg")).exists()).toBe(true);
      expect(await Bun.file(resolve(assets, "web/favicon.svg")).exists()).toBe(true);
      expect(await readFile(resolve(assets, "web/LICENSE.vite.txt"), "utf8")).toContain(
        "MIT License",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test("create rejects invalid template options before writing a project", async () => {
  for (const args of [
    ["--template", "unknown"],
    ["--template"],
    ["--template", "vite", "--template", "vanilla"],
    ["--package-dir", "--template", "vite"],
  ])
    await expect(main(["create", "unused-project", ...args])).rejects.toThrow("Usage");
});

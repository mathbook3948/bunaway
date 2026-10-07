import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { bundleAssets } from "../../packages/cli/src/build.ts";
import { validateProject } from "../../packages/cli/src/config.ts";
import { createProject } from "../../packages/cli/src/create.ts";
import { packageDirectory } from "./project.ts";
import { verifyViteDevelopment } from "./vite.ts";

for (const template of ["react", "vue", "svelte"] as const)
  test(`${template} template installs, checks components, serves HMR and packages local production assets`, async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), `bunaway-${template}-`)));
    try {
      const project = await createProject(resolve(root, `${template} app`), {
        template,
        packageDirectory: await packageDirectory(),
      });
      for (const args of [["install"], ["run", "typecheck"]]) {
        const child = Bun.spawn([process.execPath, ...args], {
          cwd: project,
          stdout: "ignore",
          stderr: "pipe",
        });
        const errors = new Response(child.stderr).text();
        expect(await child.exited, await errors).toBe(0);
      }
      const development = await validateProject(project, { development: true });
      expect(await Bun.file(resolve(project, "web-dist/index.html")).exists()).toBe(false);
      await verifyViteDevelopment(development, template);
      for (const args of [
        ["run", "build"],
        ["run", "bunaway", "validate"],
      ]) {
        const child = Bun.spawn([process.execPath, ...args], {
          cwd: project,
          stdout: "ignore",
          stderr: "pipe",
        });
        const errors = new Response(child.stderr).text();
        expect(await child.exited, await errors).toBe(0);
      }
      const production = await validateProject(project);
      expect(production.policy.views[0]?.origins).toEqual(["https://app.bunaway.local"]);
      for (const windows of [false, true]) {
        const assets = resolve(root, windows ? "windows-assets" : "backend-assets");
        await bundleAssets(production, assets, windows);
        const html = (await readFile(resolve(assets, "web/index.html"), "utf8")).replaceAll(
          "&#39;",
          "'",
        );
        expect(html).toContain("script-src 'self'");
        for (const forbidden of ["unsafe-inline", "ws://", "/@vite/client", "@react-refresh"])
          expect(html).not.toContain(forbidden);
        const entry = html.match(/src="\.\/([^"]+\.js)"/)?.[1];
        if (!entry) throw new Error("Missing packaged UI entry.");
        const script = await readFile(resolve(assets, "web", entry), "utf8");
        expect(script).toContain("Count is");
        expect(script).toContain("Explore Vite");
        expect(script).not.toContain("data:image/");
        expect(script).not.toContain("messages/current.txt");
        for (const path of ["icons.svg", "favicon.svg", "LICENSE.vite.txt"])
          expect(await Bun.file(resolve(assets, "web", path)).exists()).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);

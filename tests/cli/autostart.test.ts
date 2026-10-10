import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pluginImportsSource } from "#cli/app-modules";
import { validateProject } from "#cli/config";
import { packageFilename } from "#cli/distribution";
import { writeJson } from "#cli/files";
import { installedPlugins, writePluginManifest } from "#cli/plugins";
import { loadPluginCatalog } from "#native/host-api/bun/plugin-catalog";
import { pluginRegistry } from "#native/host-api/bun/plugins";
import { createProject, packageDirectory } from "./project.ts";

test("isolated autostart package ships the I/O adapter but keeps FFI out of the browser", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-autostart-install-")),
  );
  try {
    const artifacts = await packageDirectory();
    const project = await createProject(resolve(home, "app"));
    const path = resolve(project, "package.json");
    const manifest = (await Bun.file(path).json()) as {
      dependencies: Record<string, string>;
    };
    delete manifest.dependencies["@bunaway/plugin-storage"];
    manifest.dependencies["@bunaway/plugin-autostart"] =
      `file:${resolve(artifacts, packageFilename("@bunaway/plugin-autostart", "0.0.0"))}`;
    await writeJson(path, manifest);
    const install = Bun.spawn(
      [
        process.execPath,
        "install",
        "--linker",
        "isolated",
      ],
      {
        cwd: project,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = new Response(install.stdout).text();
    const stderr = new Response(install.stderr).text();
    expect(await install.exited, `${await stdout}\n${await stderr}`).toBe(0);
    await writeFile(
      resolve(project, "src-bunaway/app.ts"),
      `import { defineApp } from "@bunaway/backend";
import { autostartPlugin } from "@bunaway/plugin-autostart";
export default defineApp({ modules: [], plugins: [autostartPlugin] });
`,
    );
    await writeJson(resolve(project, "src-bunaway/policy.json"), {
      version: 1,
      views: [
        {
          id: "main",
          origins: [
            "https://app.bunaway.local",
          ],
          commands: [],
          events: [],
          host: {
            permissions: [
              "autostart:read",
              "autostart:configure",
            ],
          },
        },
      ],
      backend: {
        permissions: [],
      },
    });
    const valid = await validateProject(project);
    const plugins = await installedPlugins(project, "0.0.0");
    expect(plugins.map(({ packageName }) => packageName)).toEqual([
      "@bunaway/plugin-autostart",
    ]);
    expect(plugins[0]?.targets.windows?.execution).toBe("io");
    expect(valid.nativePlugins?.map(({ name }) => name)).toEqual([
      "autostart",
    ]);
    const assets = resolve(home, "generated");
    await writePluginManifest(assets, plugins);
    await writeFile(
      resolve(assets, "plugin-imports.js"),
      pluginImportsSource(plugins),
    );
    const imports = (
      await import(pathToFileURL(resolve(assets, "plugin-imports.js")).href)
    ).pluginImports;
    const catalog = await loadPluginCatalog(assets, imports);
    const app = (
      await import(pathToFileURL(resolve(project, "src-bunaway/app.ts")).href)
    ).default;
    const registry = pluginRegistry(app.plugins ?? [], catalog);
    registry.validatePolicy(valid.policy);
    expect(registry.operation("autostart.enable").permission).toBe(
      "autostart:configure",
    );
    expect(registry.operation("autostart.getStatus").permission).toBe(
      "autostart:read",
    );
    const browserEntry = resolve(project, "autostart-browser.ts");
    await writeFile(
      browserEntry,
      `import { getAutostartStatus } from "@bunaway/plugin-autostart";
void getAutostartStatus();
`,
    );
    const browser = await Bun.build({
      entrypoints: [
        browserEntry,
      ],
      target: "browser",
      metafile: true,
    });
    expect(browser.success).toBe(true);
    expect(
      Object.keys(browser.metafile?.inputs ?? {}).some((path) =>
        /(?:plugins[\\/]autostart[\\/]src[\\/](?:windows|registry|launch)\.ts|bun:ffi)/.test(
          path,
        ),
      ),
    ).toBe(false);
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 60_000);

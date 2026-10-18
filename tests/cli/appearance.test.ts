import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pluginImportsSource } from "#cli/app-modules";
import { bundleAssets } from "#cli/build";
import { validateProject } from "#cli/config";
import { packageFilename } from "#cli/distribution";
import { writeJson } from "#cli/files";
import { installedPlugins, writePluginManifest } from "#cli/plugins";
import { loadPluginCatalog } from "#native/host-api/bun/plugin-catalog";
import { pluginRegistry } from "#native/host-api/bun/plugins";
import { createProject, packageDirectory } from "./project.ts";
import { deadline } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("build"));

test("isolated appearance package ships Windows and macOS UI adapters but keeps FFI out of the browser", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-appearance-install-")),
  );
  try {
    const artifacts = await packageDirectory();
    const project = await createProject(resolve(home, "app"));
    const path = resolve(project, "package.json");
    const manifest = (await Bun.file(path).json()) as {
      dependencies: Record<string, string>;
    };
    delete manifest.dependencies["@bunaway/plugin-storage"];
    manifest.dependencies["@bunaway/plugin-appearance"] =
      `file:${resolve(artifacts, packageFilename("@bunaway/plugin-appearance", "0.0.0"))}`;
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
import appearance from "@bunaway/plugin-appearance";
export default defineApp({ modules: [], plugins: [appearance] });
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
              "appearance.getPreferences",
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
      "@bunaway/plugin-appearance",
    ]);
    expect(plugins[0]?.targets.windows?.thread).toBe("ui");
    expect(plugins[0]?.targets.macos?.thread).toBe("ui");
    expect(valid.nativePlugins?.map(({ name }) => name)).toEqual([
      "appearance",
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
    expect(registry.operation("appearance.getPreferences").name).toBe(
      "appearance.getPreferences",
    );
    const browserEntry = resolve(project, "appearance-browser.ts");
    await writeFile(
      browserEntry,
      `import appearance from "@bunaway/plugin-appearance";
void appearance.getPreferences();
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
    // Build through the installed CLI's explicit source inventory, not the repository checkout.
    const hostAssets = resolve(home, "windows-host");
    await bundleAssets(valid, hostAssets, true);
    expect(await Bun.file(resolve(hostAssets, "ui.js")).exists()).toBe(true);
    expect(
      Object.keys(browser.metafile?.inputs ?? {}).some((path) =>
        /(?:plugins[\\/]appearance[\\/]src[\\/]platforms[\\/]|bun:ffi)/.test(
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
});

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

test("isolated image package ships the I/O adapter but keeps FFI out of the browser", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-image-install-")),
  );
  try {
    const artifacts = await packageDirectory();
    const project = await createProject(resolve(home, "app"));
    const path = resolve(project, "package.json");
    const manifest = (await Bun.file(path).json()) as {
      dependencies: Record<string, string>;
    };
    delete manifest.dependencies["@bunaway/plugin-storage"];
    manifest.dependencies["@bunaway/plugin-image"] =
      `file:${resolve(artifacts, packageFilename("@bunaway/plugin-image", "0.0.0"))}`;
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
import image from "@bunaway/plugin-image";
export default defineApp({ modules: [], plugins: [image] });
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
              "image.getInfo",
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
      "@bunaway/plugin-image",
    ]);
    expect(plugins[0]?.targets.windows?.thread).toBe("ui");
    expect(plugins[0]?.targets.macos?.thread).toBe("worker");
    expect(valid.nativePlugins?.map(({ name }) => name)).toEqual([
      "image",
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
    expect(registry.operation("image.getInfo").name).toBe("image.getInfo");
    const native = resolve(
      project,
      "node_modules/@bunaway/plugin-image/dist/native/macos.js",
    );
    const output = await Bun.file(native).text();
    expect(output).toContain("CGImageSourceCreateWithData");
    expect(output).not.toContain("CoInitializeEx");
    const windowsOutput = await Bun.file(
      resolve(
        project,
        "node_modules/@bunaway/plugin-image/dist/native/windows.js",
      ),
    ).text();
    expect(windowsOutput).toContain("CoInitializeEx");
    expect(windowsOutput).not.toContain("CGImageSourceCreateWithData");
    const declaration = await Bun.file(
      resolve(project, "node_modules/@bunaway/plugin-image/dist/index.js"),
    ).text();
    expect(declaration).not.toContain("bun:ffi");
    if (process.platform === "darwin" && process.arch === "arm64") {
      const consumer = resolve(project, "native-consumer.ts");
      await writeFile(
        consumer,
        `import image from "@bunaway/plugin-image/native/macos";
import { verifyMacosImage } from ${JSON.stringify(resolve(import.meta.dir, "../fixtures/macos-image.ts"))};
await verifyMacosImage(image._definition.nativePlatforms.macos.create);
`,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          consumer,
        ],
        {
          cwd: project,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const result = new Response(child.stdout).text();
      const diagnostic = new Response(child.stderr).text();
      expect(await child.exited, `${await result}\n${await diagnostic}`).toBe(
        0,
      );
    }
    const browserEntry = resolve(project, "image-browser.ts");
    await writeFile(
      browserEntry,
      `import image from "@bunaway/plugin-image";
void image.getInfo({ id: "00000000-0000-4000-8000-000000000000" });
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
        /(?:plugins[\\/]image[\\/]src[\\/](?:wic|image-io|image-io-bindings|platforms[\\/](?:windows|macos))\.ts|bun:ffi)/.test(
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

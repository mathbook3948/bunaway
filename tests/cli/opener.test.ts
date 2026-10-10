import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPluginCatalog } from "#native/host-api/bun/plugin-catalog";
import {
  operations,
  permissionMatcher,
  pluginRegistry,
} from "#native/host-api/bun/plugins";
import { pluginImportsSource } from "#cli/app-modules";
import { validateProject } from "#cli/config";
import { packageFilename } from "#cli/distribution";
import { writeJson } from "#cli/files";
import { installedPlugins, writePluginManifest } from "#cli/plugins";
import { createProject, packageDirectory } from "./project.ts";
import { verifyWindowsOpenerFiles } from "./windows-opener-files.ts";

/** Runs an install/build subprocess and reports its captured output on failure. */
async function command(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      ...args,
    ],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`${await stdout}\n${await stderr}`);
  }
}

test("installed opener package validates and loads through the generated Windows catalog", async () => {
  const home = await realpath(
    await mkdtemp(resolve(tmpdir(), "bunaway-opener-install-")),
  );
  try {
    const artifacts = await packageDirectory();
    const project = await createProject(resolve(home, "app"));
    const packagePath = resolve(project, "package.json");
    const manifest = (await Bun.file(packagePath).json()) as {
      dependencies: Record<string, string>;
    };
    delete manifest.dependencies["@bunaway/plugin-storage"];
    manifest.dependencies["@bunaway/plugin-opener"] = `file:${resolve(
      artifacts,
      packageFilename("@bunaway/plugin-opener", "0.0.0"),
    )}`;
    manifest.dependencies["@bunaway/plugin"] = `file:${resolve(
      artifacts,
      packageFilename("@bunaway/plugin", "0.0.0"),
    )}`;
    await writeJson(packagePath, manifest);
    await command(project, [
      "install",
      "--linker",
      "isolated",
    ]);

    await writeFile(
      resolve(project, "src-bunaway/app.ts"),
      `import { defineApp } from "@bunaway/backend";
import { openerPlugin } from "@bunaway/plugin-opener";
export default defineApp({ modules: [], plugins: [openerPlugin] });
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
              "opener:openUrl",
              {
                identifier: "opener:openFile",
                allow: [
                  {
                    path: "C:\\한글 값.txt",
                  },
                ],
              },
              {
                identifier: "opener:revealFile",
                allow: [
                  {
                    path: "C:\\한글 값.txt",
                  },
                ],
              },
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
      "@bunaway/plugin-opener",
    ]);
    expect(plugins[0]?.targets.windows?.execution).toBe("io");
    expect(plugins[0]?.authorization).toBeDefined();
    expect(valid.nativePlugins?.map(({ name }) => name)).toEqual([
      "opener",
    ]);

    const assets = resolve(home, "generated");
    await writePluginManifest(assets, plugins);
    await writeFile(
      resolve(assets, "plugin-imports.js"),
      pluginImportsSource(plugins),
    );
    const packagedPlugins = await loadPluginCatalog(
      assets,
      (await import(pathToFileURL(resolve(assets, "plugin-imports.js")).href))
        .pluginImports,
    );
    const app = (
      await import(pathToFileURL(resolve(project, "src-bunaway/app.ts")).href)
    ).default;
    const registry = pluginRegistry(app.plugins ?? [], packagedPlugins);
    registry.validatePolicy(valid.policy);
    expect(registry.operation("opener.openUrl").permission).toBe(
      "opener:openUrl",
    );
    const matches = await permissionMatcher(app.plugins ?? [], packagedPlugins);
    for (const action of [
      "openFile",
      "revealFile",
    ]) {
      const call = {
        operation: `opener.${action}`,
        payload: {
          path: "C:/한글 값.txt",
        },
      };
      expect(
        registry.allowed(
          valid.policy.views[0]?.host ?? {
            permissions: [],
          },
          call,
          matches,
        ),
      ).toBe(true);
      expect(
        registry.allowed(
          valid.policy.views[0]?.host ?? {
            permissions: [],
          },
          {
            ...call,
            payload: {
              path: "C:/other.txt",
            },
          },
          matches,
        ),
      ).toBe(false);
    }

    const browserEntry = resolve(project, "opener-browser.ts");
    await writeFile(
      browserEntry,
      `import { openFile, openUrl, revealFile } from "@bunaway/plugin-opener";
void openUrl("https://example.com/");
void openFile("C:/file.txt");
void revealFile("C:/file.txt");
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
        /(?:plugins[\\/]opener[\\/]src[\\/](?:windows|shell)\.ts|bun:ffi)/.test(
          path,
        ),
      ),
    ).toBe(false);

    // UI dispatch must not initialize the opener DLLs, even when the package is
    // registered. This also runs on Linux to catch accidental UI placement.
    const uiAdapters = await operations(
      app.plugins ?? [],
      project,
      "ui",
      undefined,
      packagedPlugins,
    );
    try {
      await expect(
        uiAdapters.executeUI(
          "opener.openFile",
          {
            path: "C:/file.txt",
          },
          "backend",
          {
            requestId: "wrong-worker",
            permissions: {
              permissions: [],
            },
          },
        ),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED",
      });
    } finally {
      await uiAdapters.dispose();
    }

    if (process.platform === "win32") {
      const appPlugins = app.plugins ?? [];
      const adapters = await operations(
        appPlugins,
        project,
        "io",
        undefined,
        packagedPlugins,
      );
      try {
        expect(() =>
          adapters.execute(
            "opener.openFile",
            {
              path: "relative.txt",
            },
            "backend",
          ),
        ).toThrow(
          expect.objectContaining({
            code: "INVALID_ARGUMENT",
          }),
        );
      } finally {
        await adapters.dispose();
      }
      if (process.env.BUNAWAY_OPENER_FILES_TEST === "1") {
        await verifyWindowsOpenerFiles(project, assets);
      }
    }
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 60_000);

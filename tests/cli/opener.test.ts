import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  operations,
  pluginRegistry,
} from "../../native/windows/bun/plugins.ts";
import { packageFilename } from "../../packages/cli/src/distribution.ts";
import {
  installedPlugins,
  pluginTableSource,
} from "../../packages/cli/src/plugins.ts";
import { validateProject } from "../../packages/cli/src/config.ts";
import { writeJson } from "../../packages/cli/src/files.ts";
import { createProject, packageDirectory } from "./project.ts";

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
    expect(plugins[0]?.targets.windows?.execution).toBe("ui");
    expect(valid.nativePlugins?.map(({ name }) => name)).toEqual([
      "opener",
    ]);

    const generated = resolve(home, "generated/plugin-table.ts");
    await mkdir(dirname(generated), {
      recursive: true,
    });
    await writeFile(generated, pluginTableSource(plugins));
    const { packagedPlugins } = await import(pathToFileURL(generated).href);
    const app = (
      await import(pathToFileURL(resolve(project, "src-bunaway/app.ts")).href)
    ).default;
    const registry = pluginRegistry(app.plugins ?? [], packagedPlugins);
    registry.validatePolicy(valid.policy);
    expect(registry.operation("opener.openUrl").permission).toBe(
      "opener:openUrl",
    );

    const browserEntry = resolve(project, "opener-browser.ts");
    await writeFile(
      browserEntry,
      `import { openUrl } from "@bunaway/plugin-opener";
void openUrl("https://example.com/");
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

    if (process.platform === "win32") {
      const appPlugins = app.plugins ?? [];
      const adapters = await operations(
        appPlugins,
        project,
        "ui",
        undefined,
        packagedPlugins,
      );
      try {
        await expect(
          adapters.executeUI(
            "opener.openUrl",
            {
              url: "https://example.com/",
            },
            "view:main",
            {
              requestId: "denied",
              permissions: {
                permissions: [],
              },
            },
          ),
        ).rejects.toMatchObject({
          code: "PERMISSION_DENIED",
        });
      } finally {
        await adapters.dispose();
      }
    }
  } finally {
    await rm(home, {
      recursive: true,
      force: true,
    });
  }
}, 60_000);

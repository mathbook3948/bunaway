import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appModules } from "#cli/app-modules";
import { writeJson } from "#cli/files";
import { installedPlugins, writePluginManifest } from "#cli/plugins";
import type { ManifestPlugin } from "@bunaway/runtime-bun/app-manifest";

/**
 * Bundle native workers with the fixture app's installed plugins.
 * Supplying an entrypoint builds the shared UI and host-operation workers.
 */
export async function bundleNativeWorker(
  name: string,
  destination: string,
  entrypoint?: string,
) {
  const plugins = await installedPlugins(
    resolve(import.meta.dir, "desktop/host"),
    "0.0.0",
  );
  await writePluginManifest(destination, plugins);
  const result = await Bun.build({
    entrypoints: [
      "bunaway-generated/plugin-imports.ts",
      ...(entrypoint
        ? [
            entrypoint,
            ...[
              "ui",
              "host-operations",
            ].map((worker) =>
              resolve(import.meta.dir, `../../native/windows/bun/${worker}.ts`),
            ),
          ]
        : [
            resolve(import.meta.dir, `../../native/windows/bun/${name}.ts`),
          ]),
    ],
    target: "bun",
    splitting: true,
    naming: "[name].[ext]",
    plugins: [
      appModules({
        plugins,
      }),
    ],
  });
  if (!result.success) {
    throw new Error(result.logs.map(String).join("\n"));
  }
  await mkdir(destination, {
    recursive: true,
  });
  for (const artifact of result.outputs) {
    await writeFile(
      resolve(destination, basename(artifact.path)),
      new Uint8Array(await artifact.arrayBuffer()),
    );
  }
  return pathToFileURL(resolve(destination, `${name}.js`));
}

/** Write real manifest and import files for controlled native lifecycle adapters. */
export async function writePluginFixture(
  assets: string,
  plugins: ManifestPlugin[],
  imports: string,
) {
  await mkdir(assets, {
    recursive: true,
  });
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    app: {},
    policy: {},
    plugins,
    developmentSdk: {},
  });
  await writeFile(resolve(assets, "plugin-imports.js"), imports);
}

/** Bundle a real UI worker with controlled adapters using the production generated-module boundary. */
export async function bundleUIPluginFixture(
  assets: string,
  plugins: ManifestPlugin[],
  imports: string,
) {
  await writePluginFixture(assets, plugins, imports);
  const result = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../../native/windows/bun/ui.ts"),
    ],
    target: "bun",
    outdir: assets,
    plugins: [
      {
        name: "fixture-plugin-imports",
        setup(build) {
          build.onResolve(
            {
              filter: /^bunaway:plugin-imports$/,
            },
            () => ({
              path: resolve(assets, "plugin-imports.js"),
            }),
          );
        },
      },
    ],
  });
  if (!result.success) {
    throw new Error(result.logs.map(String).join("\n"));
  }
}

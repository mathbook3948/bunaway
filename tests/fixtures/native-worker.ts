import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  installedPlugins,
  pluginTableSource,
} from "../../packages/cli/src/plugins.ts";

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
  const result = await Bun.build({
    entrypoints: entrypoint
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
        ],
    target: "bun",
    splitting: true,
    naming: "[name].[ext]",
    plugins: [
      {
        name: "test-native-plugins",
        setup(build) {
          build.onResolve(
            {
              filter: /plugin-table\.ts$/,
            },
            () => ({
              path: "table",
              namespace: "test-native",
            }),
          );
          build.onLoad(
            {
              filter: /.*/,
              namespace: "test-native",
            },
            () => ({
              contents: pluginTableSource(plugins),
              loader: "ts",
            }),
          );
        },
      },
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

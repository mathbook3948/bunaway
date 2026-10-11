import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ownedDirectory,
  publishOwnedDirectory,
} from "../../packaging/src/directories.ts";
import { readPluginDeclaration } from "./plugins.ts";
import { run } from "./processes.ts";

/**
 * Build src/index.ts into a browser-safe declaration and one native export per
 * declared OS. Platform modules export createOperations and initialize resources
 * only when that factory is called. TypeScript must be installed by the author.
 * The package.json version is embedded in every output's registration.
 * Failed builds preserve the previous dist directory.
 */
export async function buildNativePlugin(directory = "."): Promise<string> {
  const root = resolve(directory);
  const manifest: unknown = await Bun.file(
    resolve(root, "package.json"),
  ).json();
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    typeof Reflect.get(manifest, "version") !== "string" ||
    !Reflect.get(manifest, "version")
  ) {
    throw new Error("Native plugins require a package.json version.");
  }
  const version: string = Reflect.get(manifest, "version");
  await ownedDirectory(root, resolve(root, "dist"));
  const stage = await mkdtemp(resolve(root, ".plugin-build-"));
  try {
    const build = async (platform?: string) => {
      const output = platform
        ? resolve(stage, "native", `${platform}.js`)
        : resolve(stage, "index.js");
      const result = await Bun.build({
        entrypoints: [
          resolve(root, "src/index.ts"),
        ],
        target: platform ? "bun" : "browser",
        format: "esm",
        packages: "external",
        plugins: [
          {
            name: "bunaway-plugin-platforms",
            setup(builder) {
              // Keep the shared SDK external while supplying this package's build metadata.
              builder.onResolve(
                {
                  filter: /^@bunaway\/plugin$/,
                },
                ({ path }) => ({
                  path,
                  namespace: "bunaway-plugin-sdk",
                }),
              );
              builder.onResolve(
                {
                  filter: /^\.\/bunaway-plugin-sdk-external$/,
                },
                () => ({
                  path: "@bunaway/plugin",
                  external: true,
                }),
              );
              builder.onLoad(
                {
                  filter: /.*/,
                  namespace: "bunaway-plugin-sdk",
                },
                () => ({
                  // Bun 1.4.2 drops external star re-exports from virtual modules.
                  contents: `export { s, BunawayError } from "./bunaway-plugin-sdk-external";
import { defineNativePlugin as define } from "./bunaway-plugin-sdk-external";
export function defineNativePlugin(declaration) {
  const plugin = define(declaration);
  return { ...plugin, definition: Object.freeze({ ...plugin.definition, version: ${JSON.stringify(version)} }) };
}`,
                  loader: "js",
                }),
              );
              builder.onLoad(
                {
                  filter:
                    /(?:^|[\\/])platforms[\\/](windows|macos|linux|android|ios)\.ts$/,
                },
                ({ path }) => {
                  // Bun has resolved extensions and aliases before this boundary is checked.
                  const imported = resolve(path);
                  if (
                    imported ===
                    resolve(root, "src/platforms", `${platform}.ts`)
                  ) {
                    return;
                  }
                  if (
                    ![
                      "windows",
                      "macos",
                      "linux",
                      "android",
                      "ios",
                    ].some(
                      (os) =>
                        imported === resolve(root, "src/platforms", `${os}.ts`),
                    )
                  ) {
                    throw new Error(
                      "Native platform modules must be in src/platforms/<platform>.ts.",
                    );
                  }
                  return {
                    contents:
                      'export function createOperations() { throw new Error("Load the plugin native/<platform> export on its owning host."); }',
                    loader: "js",
                  };
                },
              );
            },
          },
        ],
      });
      if (!result.success) {
        throw new AggregateError(
          result.logs,
          `Native plugin build failed: ${root}`,
        );
      }
      await mkdir(resolve(output, ".."), {
        recursive: true,
      });
      const bundle = result.outputs[0];
      if (!bundle || result.outputs.length !== 1) {
        throw new Error(
          "Native plugin entries must produce one JavaScript bundle without file assets.",
        );
      }
      await Bun.write(output, bundle);
    };
    await build();
    const declaration = await readPluginDeclaration(
      resolve(stage, "index.js"),
      root,
    );
    for (const platform of Object.keys(declaration.nativePlatforms)) {
      await build(platform);
    }
    await run(
      [
        process.execPath,
        "x",
        "--no-install",
        "tsc",
        "--project",
        resolve(root, "tsconfig.json"),
        "--noEmit",
        "false",
        "--declaration",
        "--emitDeclarationOnly",
        "--rootDir",
        resolve(root, "src"),
        "--declarationDir",
        resolve(stage, "types"),
      ],
      root,
    );
    await publishOwnedDirectory(root, stage, resolve(root, "dist"));
    return resolve(root, "dist");
  } finally {
    if (await ownedDirectory(root, stage)) {
      await rm(stage, {
        recursive: true,
        force: true,
      });
    }
  }
}

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PLATFORMS } from "@bunaway/plugin-api";
import {
  ownedDirectory,
  publishOwnedDirectory,
} from "../../packaging/src/directories.ts";
import { buildPluginBundle } from "./plugin-imports.ts";
import { readPluginDeclaration } from "./plugins.ts";
import { run, runWorker } from "./processes.ts";

const PLATFORM_MODULE_FILTER = new RegExp(
  String.raw`(?:^|[\\/])platforms[\\/](${PLATFORMS.join("|")})\.ts$`,
);

/**
 * Source of the virtual `@bunaway/plugin` module a plugin bundle imports instead of the
 * installed SDK. It re-exports every value the plugin's SDK exports by name, because Bun
 * 1.4.2 drops external star re-exports from virtual modules, and wraps defineNativePlugin
 * so the package version is embedded in every registration.
 */
async function sdkModuleSource(root: string, version: string): Promise<string> {
  const sdk: Record<string, unknown> = await import(
    pathToFileURL(Bun.resolveSync("@bunaway/plugin", root)).href
  );
  const reexported = Object.keys(sdk).filter(
    (name) => name !== "defineNativePlugin" && name !== "default",
  );
  return `export { ${reexported.join(", ")} } from "./bunaway-plugin-sdk-external";
import { defineNativePlugin as define } from "./bunaway-plugin-sdk-external";
export function defineNativePlugin(declaration, calls) {
  return define(declaration, calls, ${JSON.stringify(version)});
}`;
}

/**
 * Build src/index.ts into a browser-safe declaration and one native export per
 * declared OS. Platform modules export native functions and initialize resources
 * only during host activation. TypeScript must be installed by the author.
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
  const sdkModule = await sdkModuleSource(root, version);
  await ownedDirectory(root, resolve(root, "dist"));
  const stage = await mkdtemp(resolve(root, ".plugin-build-"));
  try {
    // Inspect once per boundary. Every output must see the same declaration shape.
    const platformStubs = new Map<string, string>();
    const build = async (platform?: string) => {
      const output = platform
        ? resolve(stage, "native", `${platform}.js`)
        : resolve(stage, "index.js");
      const result = await buildPluginBundle(root, {
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
                  contents: sdkModule,
                  loader: "js",
                }),
              );
              builder.onLoad(
                {
                  filter: PLATFORM_MODULE_FILTER,
                },
                async ({ path }) => {
                  // Bun has resolved extensions and aliases before this boundary is checked.
                  const imported = resolve(path);
                  if (
                    imported ===
                    resolve(root, "src/platforms", `${platform}.ts`)
                  ) {
                    return;
                  }
                  if (
                    !PLATFORMS.some(
                      (os) =>
                        imported === resolve(root, "src/platforms", `${os}.ts`),
                    )
                  ) {
                    throw new Error(
                      "Native platform modules must be in src/platforms/<platform>.ts.",
                    );
                  }
                  let stub = platformStubs.get(imported);
                  if (stub === undefined) {
                    const result: unknown = JSON.parse(
                      await runWorker(
                        "plugin-platform.ts",
                        "platformModuleStub",
                        [
                          imported,
                          root,
                        ],
                        root,
                      ),
                    );
                    if (typeof result !== "string") {
                      throw new Error("Invalid native platform build output.");
                    }
                    stub = result;
                    platformStubs.set(imported, stub);
                  }
                  return {
                    contents: stub,
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
      // Imports are portable by contract: inspect keys without invoking setup or initializing OS resources.
      await readPluginDeclaration(
        resolve(stage, "native", `${platform}.js`),
        root,
      );
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

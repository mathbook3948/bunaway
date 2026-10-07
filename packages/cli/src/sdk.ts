import { lstat, realpath } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { files, hash, inside, installedPackageRoot, json } from "./files.ts";
import { type InstalledPlugin, installedPlugins } from "./plugins.ts";

interface SdkReference {
  name: string;
  parent: string;
}

export async function assertAppDefinitionExport(source: string): Promise<void> {
  const extension = extname(source);
  const loader =
    extension === ".tsx"
      ? "tsx"
      : extension === ".jsx"
        ? "jsx"
        : /\.[cm]?ts$/.test(extension)
          ? "ts"
          : "js";
  try {
    const { exports } = new Bun.Transpiler({
      loader,
    }).scan(await Bun.file(source).text());
    if (!exports.includes("default")) {
      throw new Error("build.app must default-export an AppDefinition.");
    }
  } catch (error) {
    throw new Error(
      `Bundle failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function sdkPlugin(
  project: string,
  references: readonly SdkReference[] = [],
  plugins?: readonly InstalledPlugin[],
): Promise<BunPlugin> {
  const root = await installedPackageRoot(project, "@bunaway/cli");
  const release = (await json(resolve(root, "framework.json"))) as {
    packages: Record<string, string>;
    version: string;
  };
  const entries = new Map<string, string>();
  const nativePlugins =
    plugins ?? (await installedPlugins(project, release.version));
  const checked = new Map<string, Promise<boolean>>();
  const roots = new Map<string, string>();
  for (const name of Object.values(release.packages)) {
    if (name === "@bunaway/cli") {
      continue;
    }
    const packageRoot = await realpath(await installedPackageRoot(root, name));
    const manifest = (await json(resolve(packageRoot, "package.json"))) as {
      exports: Record<string, string>;
    };
    for (const [subpath, entry] of Object.entries(manifest.exports)) {
      if (typeof entry !== "string" || !entry.startsWith("./src/")) {
        continue;
      }
      const specifier = subpath === "." ? name : name + subpath.slice(1);
      entries.set(specifier, await realpath(resolve(packageRoot, entry)));
      roots.set(specifier, packageRoot);
    }
  }
  async function check(name: string, parent: string): Promise<string> {
    const expected = entries.get(name);
    try {
      const path = await realpath(Bun.resolveSync(name, parent));
      if (expected && relative(expected, path) === "") {
        return path;
      }
      if (expected && roots.has(name)) {
        // Bun can install identical local tarballs twice when direct dependencies
        // use relative paths and the CLI uses absolute paths. Compare the entire
        // package before routing both imports to one SDK to preserve class identity.
        const key = `${expected}\n${path}`;
        let identical = checked.get(key);
        if (!identical) {
          identical = (async () => {
            const expectedRoot = roots.get(name);
            if (!expectedRoot) {
              return false;
            }
            const actualRoot = resolve(
              dirname(path),
              relative(dirname(expected), expectedRoot),
            );
            const expectedFiles = await files(expectedRoot, [
              "node_modules",
            ]);
            const actualFiles = await files(actualRoot, [
              "node_modules",
            ]);
            const names = expectedFiles
              .map((file) => relative(expectedRoot, file))
              .sort();
            const actualNames = actualFiles
              .map((file) => relative(actualRoot, file))
              .sort();
            if (JSON.stringify(names) !== JSON.stringify(actualNames)) {
              return false;
            }
            for (const file of names) {
              if (
                (await hash(resolve(expectedRoot, file))) !==
                (await hash(resolve(actualRoot, file)))
              ) {
                return false;
              }
            }
            return true;
          })();
          checked.set(key, identical);
        }
        if (await identical) {
          return expected;
        }
      }
    } catch {}
    throw new Error(
      `Incompatible SDK resolution: ${name} from ${parent}; run bun install to restore the matching installed SDK packages.`,
    );
  }
  for (const { name, parent } of references) {
    await check(name, parent);
  }
  return {
    name: "pinned-bunaway-sdk",
    setup(build) {
      // Native sources use relative imports inside the CLI artifact. Resolve
      // those entries to the installed SDK too, preserving class identity.
      build.onResolve(
        {
          filter: /packages\/[a-z-]+\/src\/index\.ts$/,
        },
        ({ path, importer }) => {
          for (const [directory, name] of Object.entries(release.packages)) {
            if (
              resolve(dirname(importer), path) ===
              resolve(root, `packages/${directory}/src/index.ts`)
            ) {
              const entry = entries.get(name);
              if (entry) {
                return {
                  path: entry,
                };
              }
            }
          }
          return undefined;
        },
      );
      build.onResolve(
        {
          filter: /^@bunaway\//,
        },
        async ({ path, importer }) => {
          // Let Bun resolve plugin exports and target conditions. Only common SDKs
          // need routing to one installation to preserve their runtime identity.
          if (
            nativePlugins.some(
              ({ packageName }) =>
                path === packageName || path.startsWith(`${packageName}/`),
            )
          ) {
            return undefined;
          }
          return {
            path: await check(path, importer || project),
          };
        },
      );
    },
  };
}

export async function validateSdkGraph(
  project: string,
  references: readonly SdkReference[],
  sources: readonly string[],
  plugins?: readonly InstalledPlugin[],
): Promise<string[]> {
  const plugin = await sdkPlugin(project, references, plugins);
  const dependencies = new Set<string>();
  for (const source of sources) {
    const frontend = (await lstat(source)).isDirectory();
    const entrypoints = frontend
      ? (await files(source)).filter(
          (path) => /\.(ts|js)$/.test(path) && !path.endsWith(".d.ts"),
        )
      : [
          source,
        ];
    if (!entrypoints.length) {
      continue;
    }
    if (!frontend) {
      await assertAppDefinitionExport(source);
    }
    await buildWithSdk(
      {
        entrypoints,
        metafile: !frontend,
        ...(frontend
          ? {
              root: source,
            }
          : {
              packages: "bundle" as const,
            }),
        target: frontend ? "browser" : "bun",
        splitting: false,
      },
      plugin,
      (metadata) => {
        for (const name of Object.keys(metadata?.inputs ?? {})) {
          const path = resolve(project, name);
          if (inside(project, path)) {
            dependencies.add(relative(project, path).replaceAll("\\", "/"));
          }
        }
      },
    );
  }
  return [
    ...dependencies,
  ].sort();
}

export async function buildWithSdk(
  options: Bun.BuildConfig,
  plugin: BunPlugin,
  onMetadata?: (metadata: Bun.BuildMetafile | undefined) => void,
): Promise<Bun.BuildArtifact[]> {
  try {
    const result = await Bun.build({
      ...options,
      plugins: [
        plugin,
      ],
    });
    if (!result.success) {
      throw new Error(result.logs.map(String).join("\n"));
    }
    onMetadata?.(result.metafile);
    return result.outputs;
  } catch (error) {
    const errors =
      error instanceof AggregateError
        ? error.errors
        : [
            error,
          ];
    throw new Error(`Bundle failed:\n${errors.map(String).join("\n")}`);
  }
}

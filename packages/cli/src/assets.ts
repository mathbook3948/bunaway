import { cp, mkdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { readAppManifest } from "@bunaway/runtime-bun/app-manifest";
import type { BunPlugin } from "bun";
import { appModules, commonJsSdkSource } from "./app-modules.ts";
import { type Project, runtimeSettings } from "./config.ts";
import { release } from "./distribution.ts";
import {
  files,
  hash,
  inside,
  installedPackageRoot,
  json,
  writeJson,
} from "./files.ts";
import {
  type InstalledPlugin,
  installedPlugins,
  writePluginManifest,
} from "./plugins.ts";
import { assertAppDefinitionExport, buildWithSdk, sdkPlugin } from "./sdk.ts";

async function bundleBytes(
  output: Bun.BuildArtifact,
  development: boolean,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(await output.arrayBuffer());
  if (!development || !output.path.endsWith(".js")) {
    return bytes;
  }
  const text = new TextDecoder().decode(bytes);
  return Buffer.from(
    text.replace(
      /(\/\/# sourceMappingURL=data:application\/json;base64,)([^\s]+)(?=\s*$)/,
      (_, prefix, encoded) => {
        const map = JSON.parse(Buffer.from(encoded, "base64").toString());
        // Bun emits paths relative to the build cwd, but assets are saved elsewhere.
        map.sources = map.sources.map((source: string) =>
          isAbsolute(source) || !/^[\w-]+:/.test(source)
            ? resolve(source).replaceAll("\\", "/")
            : source,
        );
        return prefix + Buffer.from(JSON.stringify(map)).toString("base64");
      },
    ),
  );
}

async function bundle(
  entrypoints: string[],
  root: string,
  plugin: BunPlugin,
  development: boolean,
): Promise<Bun.BuildArtifact[]> {
  if (entrypoints.length === 0) {
    return [];
  }
  return buildWithSdk(
    {
      entrypoints,
      root,
      target: "browser",
      splitting: false,
      sourcemap: development ? "inline" : "none",
    },
    plugin,
  );
}

async function webAssets(
  project: Project,
  destination: string,
  plugin: BunPlugin,
  development: boolean,
): Promise<void> {
  const sources = await files(project.frontend);
  const entries: string[] = [];
  const outputs = new Map<
    string,
    {
      path: string;
      source: string | Bun.BuildArtifact;
    }
  >();
  const addOutput = (name: string, source: string | Bun.BuildArtifact) => {
    const path = resolve(destination, name);
    if (!inside(destination, path)) {
      throw new Error(`Frontend output escapes destination: ${name}`);
    }
    const rel = relative(destination, path).replaceAll("\\", "/");
    // Catch names that collide when the output is unpacked on a case-insensitive filesystem.
    const key = rel.toLowerCase();
    if (outputs.has(key)) {
      throw new Error(`Frontend output collision: ${rel}`);
    }
    outputs.set(key, {
      path,
      source,
    });
  };
  for (const source of sources) {
    const rel = relative(project.frontend, source);
    if (rel.endsWith(".d.ts")) {
      continue;
    }
    const isEntry = /\.(ts|js)$/.test(rel);
    // Bundle script files and copy other frontend files without rewriting their contents.
    if (isEntry) {
      entries.push(source);
    } else {
      addOutput(rel, source);
    }
  }
  for (const output of await bundle(
    entries,
    project.frontend,
    plugin,
    development,
  )) {
    addOutput(output.path, output);
  }
  for (const { path, source } of outputs.values()) {
    await mkdir(dirname(path), {
      recursive: true,
    });
    if (typeof source === "string") {
      await cp(source, path);
    } else {
      await writeFile(path, await bundleBytes(source, development));
    }
  }
}

/** Build the Windows host and, when needed, its packaged frontend assets. */
export async function bundleWindowsAssets(
  project: Project,
  assets: string,
  developmentServer = false,
  development = false,
): Promise<string[]> {
  await assertAppDefinitionExport(project.appEntry);
  await mkdir(assets, {
    recursive: true,
  });
  const server = developmentServer ? project.dev : undefined;
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    ...runtimeSettings(project, server, development),
    plugins: [],
    developmentSdk: {},
  });
  if (!developmentServer) {
    await webAssets(
      project,
      resolve(assets, "web"),
      await sdkPlugin(project.root, [], project.nativePlugins),
      development,
    );
  }
  return bundleWindowsHost(
    resolve(project.frameworkRoot, "native/windows/bun"),
    assets,
    project.appEntry,
    project.root,
    development,
    project.nativePlugins,
  );
}

/**
 * Bundle the Windows bootstrap, app entry and host workers into the asset directory.
 * With project metadata, development builds retain shared SDK entries; return asset basenames.
 */
export async function bundleWindowsHost(
  source: string,
  destination: string,
  appEntry: string,
  project?: string,
  development = false,
  installed?: readonly InstalledPlugin[],
): Promise<string[]> {
  // Bundle all entries together so lazy adapters and their owning host share error and SDK classes.
  const pluginProject = project ?? dirname(appEntry);
  const plugins =
    installed ??
    (project ||
    (await Bun.file(resolve(pluginProject, "package.json")).exists())
      ? await installedPlugins(pluginProject, (await release()).version)
      : []);
  const sdk = project ? await sdkPlugin(project, [], plugins) : undefined;
  await writePluginManifest(destination, plugins);
  const sharedEntries = new Map<string, string>();
  if (development && sdk && project) {
    const require = createRequire(resolve(project, "package.json"));
    for (const entry of sdk.entries) {
      sharedEntries.set(...entry);
    }
    for (const plugin of plugins) {
      const manifest = await json(resolve(plugin.root, "package.json"));
      const exports =
        manifest && typeof manifest === "object" && "exports" in manifest
          ? manifest.exports
          : undefined;
      const subpaths =
        exports &&
        typeof exports === "object" &&
        Object.keys(exports).some((key) => key.startsWith("."))
          ? Object.keys(exports)
          : [
              ".",
            ];
      for (const subpath of subpaths) {
        if (
          subpath !== "." &&
          (!subpath.startsWith("./") || subpath.includes("*"))
        ) {
          continue;
        }
        const name =
          subpath === "."
            ? plugin.packageName
            : plugin.packageName + subpath.slice(1);
        for (const kind of [
          "import",
          "require",
        ] as const) {
          let source: string;
          try {
            source =
              kind === "require"
                ? require.resolve(name)
                : Bun.resolveSync(name, project);
          } catch {
            // Disabled exports are not shared; actual imports still fail in the app build.
            continue;
          }
          const entry = await realpath(source);
          // Assets use Bun's loaders instead of the executable-module wrappers.
          if (/\.[cm]?[jt]sx?$/.test(entry) && !/\.d\.[cm]?ts$/.test(entry)) {
            sharedEntries.set(
              kind === "require" ? `require:${name}` : name,
              entry,
            );
          }
        }
      }
    }
  }
  const sdkNames = new Map<string, string>();
  const namesBySource = new Map<string, string>();
  for (const [name, source] of sharedEntries) {
    const entry = namesBySource.get(source) ?? `sdk${namesBySource.size}`;
    namesBySource.set(source, entry);
    sdkNames.set(name, entry);
  }
  const sdkSources = new Map(
    [
      ...namesBySource,
    ].map(([path, name]) => [
      `${name}.ts`,
      path,
    ]),
  );
  const entries: BunPlugin = {
    name: "windows-app-entry",
    setup(build) {
      sdk?.setup(build);
      appModules({
        appEntry,
        plugins,
        sdkSources,
      }).setup(build);
      build.onResolve(
        {
          filter: /^\.\/app\.js$/,
        },
        ({ importer }) =>
          resolve(importer) === resolve(source, "boot.ts")
            ? {
                path: "app.ts",
                namespace: "bunaway-generated",
              }
            : undefined,
      );
    },
  };
  const buildWindowsEntries = (
    entrypoints: string[],
    onMetadata?: (metadata: Bun.BuildMetafile | undefined) => void,
  ) =>
    buildWithSdk(
      {
        entrypoints,
        target: "bun",
        packages: "bundle",
        splitting: true,
        naming: "[name].[ext]",
        sourcemap: development ? "inline" : "none",
        metafile: onMetadata !== undefined,
      },
      entries,
      onMetadata,
    );
  const commonJsSources = new Set<string>();
  const artifacts = await buildWindowsEntries(
    [
      resolve(source, "boot.ts"),
      resolve(source, "ui.ts"),
      resolve(source, "host-operations.ts"),
      "bunaway-generated/plugin-imports.ts",
      "bunaway-generated/app.ts",
      ...[
        ...namesBySource.values(),
      ].map((name) => `bunaway-generated/${name}.ts`),
    ],
    sharedEntries.size
      ? (metadata) => {
          for (const [path, input] of Object.entries(metadata?.inputs ?? {})) {
            if (input.format === "cjs") {
              // Bun 1.4.2 prefixes cross-drive Windows inputs with ../ before the drive path.
              const inputPath =
                process.platform === "win32"
                  ? path.replace(/^(?:\.\.\/)+(?=[A-Za-z]:\/)/, "")
                  : path;
              commonJsSources.add(resolve(inputPath));
            }
          }
        }
      : undefined,
  );
  if (
    ![
      "boot.js",
      "app.js",
    ].every((name) =>
      artifacts.some((output) => basename(output.path) === name),
    )
  ) {
    throw new Error("Windows bootstrap bundle failed");
  }
  const bundledAssets = new Set<string>();
  const saveOutput = async (output: Bun.BuildArtifact) => {
    const name = basename(output.path);
    await writeFile(
      resolve(destination, name),
      await bundleBytes(output, development),
    );
    // File imports become path strings in JS, so the compile pass cannot
    // discover these assets again. Track by artifact kind, not extension.
    if (output.kind === "asset") {
      bundledAssets.add(name);
    }
  };
  for (const output of artifacts) {
    await saveOutput(output);
  }
  if (sharedEntries.size) {
    const inventory: Record<string, string> = {};
    for (const [name, entry] of sdkNames) {
      const source = sharedEntries.get(name);
      if (source && commonJsSources.has(source)) {
        // A raw CJS entry exposes dynamic named exports that an ESM barrel cannot enumerate.
        inventory[name] = `${entry}.cjs`;
        await writeFile(
          resolve(destination, `${entry}.cjs`),
          commonJsSdkSource(entry),
        );
      } else {
        inventory[name] = `${entry}.js`;
      }
    }
    await writeJson(resolve(destination, "manifest.json"), {
      ...(await readAppManifest(destination)),
      developmentSdk: inventory,
    });
  }
  return [
    ...bundledAssets,
  ].sort();
}

/**
 * Bundle a replacement app against the SDK entries retained by the host build.
 * The reload generation must have a valid ID and the result is the new app bundle hash.
 */
export async function bundleWindowsReload(
  project: Project,
  assets: string,
  id: string,
): Promise<string> {
  const entries = (await readAppManifest(assets)).developmentSdk;
  if (Object.keys(entries).length === 0) {
    throw new Error("Missing development SDK inventory; restart bunaway dev.");
  }
  const aliases = new Map<string, string>();
  for (const [name, entry] of Object.entries(entries)) {
    aliases.set(name, entry);
  }
  const sdk = await sdkPlugin(project.root, [], project.nativePlugins);
  const sources = new Map(
    [
      ...sdk.entries,
    ].map(([name, path]) => [
      path,
      name,
    ]),
  );
  const outputs = await buildWithSdk(
    {
      entrypoints: [
        project.appEntry,
      ],
      target: "bun",
      packages: "bundle",
      splitting: false,
      sourcemap: "inline",
      naming: "app.js",
    },
    {
      name: "retained-development-sdk",
      setup(build) {
        build.onResolve(
          {
            filter: /.*/,
          },
          ({ path, importer, kind }) => {
            let name = aliases.has(path)
              ? path
              : sources.get(
                  resolve(dirname(importer || project.appEntry), path),
                );
            if (
              (kind === "require-call" || kind === "require-resolve") &&
              project.nativePlugins?.some(
                ({ packageName }) =>
                  path === packageName || path.startsWith(`${packageName}/`),
              )
            ) {
              name = `require:${path}`;
            }
            const entry = name === undefined ? undefined : aliases.get(name);
            return entry
              ? {
                  path: `../../${entry}`,
                  external: true,
                }
              : undefined;
          },
        );
        sdk.setup(build);
      },
    },
  );
  const directory = resolve(assets, "reloads", id);
  if (!/^[a-f0-9-]{36}$/.test(id)) {
    throw new Error("Invalid app reload generation.");
  }
  await mkdir(directory, {
    recursive: true,
  });
  for (const output of outputs) {
    await writeFile(
      resolve(directory, basename(output.path)),
      await bundleBytes(output, true),
    );
  }
  return hash(resolve(directory, "app.js"));
}

/** Bundle packaged web assets and the Android child-process bootstrap from the common app definition. */
export async function bundleAndroidAssets(
  project: Project,
  assets: string,
): Promise<void> {
  await assertAppDefinitionExport(project.appEntry);
  const sdk = await sdkPlugin(project.root, [], project.nativePlugins);
  await webAssets(project, resolve(assets, "web"), sdk, false);
  const runtimeEntry = resolve(
    await installedPackageRoot(project.frameworkRoot, "@bunaway/runtime-bun"),
    "src/index.ts",
  );
  const backend = await buildWithSdk(
    {
      entrypoints: [
        "bunaway-generated/backend.ts",
      ],
      root: project.root,
      target: "bun",
      packages: "bundle",
      naming: {
        entry: "backend.js",
        asset: "backend-assets/[name]-[hash].[ext]",
      },
    },
    {
      name: "android-app-entry",
      setup(build) {
        sdk.setup(build);
        appModules({
          appEntry: project.appEntry,
          processRuntime: runtimeEntry,
        }).setup(build);
      },
    },
  );
  await writeAndroidBackend(backend, assets);
}

/** Preserve the backend entry and file imports together for extraction from the APK. */
export async function writeAndroidBackend(
  outputs: readonly Bun.BuildArtifact[],
  assets: string,
): Promise<void> {
  const entries = outputs.filter((output) => output.kind === "entry-point");
  if (
    entries.length !== 1 ||
    basename(entries[0]?.path ?? "") !== "backend.js"
  ) {
    throw new Error("Missing Android backend bundle.");
  }
  const destination = resolve(assets, "backend");
  for (const output of outputs) {
    if (output.kind !== "entry-point" && output.kind !== "asset") {
      throw new Error(`Unexpected Android backend output: ${output.kind}`);
    }
    const path = resolve(destination, output.path);
    if (!inside(destination, path)) {
      throw new Error(
        `Android backend output escapes destination: ${output.path}`,
      );
    }
    await mkdir(dirname(path), {
      recursive: true,
    });
    await writeFile(path, await bundleBytes(output, false));
  }
}

/** Bundle the macOS Bun entry and backend Worker; return file imports for compilation. */
export async function bundleMacosAssets(
  project: Project,
  assets: string,
  developmentServer = false,
  development = false,
): Promise<string[]> {
  await assertAppDefinitionExport(project.appEntry);
  await mkdir(assets, {
    recursive: true,
  });
  const sdk = await sdkPlugin(project.root, [], project.nativePlugins);
  await writeJson(resolve(assets, "manifest.json"), {
    format: 1,
    ...runtimeSettings(project, developmentServer ? project.dev : undefined),
    plugins: [],
    developmentSdk: {},
  });
  if (!developmentServer) {
    await webAssets(project, resolve(assets, "web"), sdk, development);
  }
  return bundleMacosHost(
    resolve(project.frameworkRoot, "native/macos/bun"),
    assets,
    project.appEntry,
    project.root,
    development,
    project.nativePlugins,
  );
}

/** Bundle macOS host code and application imports; return imported asset basenames. */
export async function bundleMacosHost(
  source: string,
  destination: string,
  appEntry: string,
  project?: string,
  development = false,
  installed: readonly InstalledPlugin[] = [],
): Promise<string[]> {
  const sdk = project ? await sdkPlugin(project, [], installed) : undefined;
  await writePluginManifest(destination, installed, "macos");
  const outputs = await buildWithSdk(
    {
      entrypoints: [
        resolve(source, "boot.ts"),
        resolve(source, "backend.ts"),
      ],
      target: "bun",
      packages: "bundle",
      splitting: false,
      naming: "[name].[ext]",
      sourcemap: development ? "inline" : "none",
    },
    {
      name: "macos-app-entry",
      setup(build) {
        sdk?.setup(build);
        appModules({
          plugins: installed,
          platform: "macos",
        }).setup(build);
        build.onResolve(
          {
            filter: /^\.\/app\.js$/,
          },
          ({ importer }) =>
            resolve(importer) === resolve(source, "backend.ts")
              ? {
                  path: resolve(appEntry),
                }
              : undefined,
        );
      },
    },
  );
  const bundledAssets: string[] = [];
  for (const output of outputs) {
    await writeFile(
      resolve(destination, basename(output.path)),
      await bundleBytes(output, development),
    );
    // File imports become path strings, so the compile pass needs their asset names.
    if (output.kind === "asset") {
      bundledAssets.push(basename(output.path));
    }
  }
  return bundledAssets.sort();
}

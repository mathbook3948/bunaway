import { cp, mkdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { readAppManifest } from "@bunaway/runtime-bun/app-manifest";
import { type AppMetadata, appName } from "@bunaway/runtime-bun/app-metadata";
import type { BunPlugin } from "bun";
import { appModules, commonJsSdkSource } from "./app-modules.ts";
import { readAppVersions } from "./app-versions.ts";
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

type SdkPlugin = Awaited<ReturnType<typeof sdkPlugin>>;

/** Plugins for the host build: the caller's list, else those installed in a project that has a package.json. */
async function hostPlugins(
  appEntry: string,
  project: string | undefined,
  installed: readonly InstalledPlugin[] | undefined,
): Promise<readonly InstalledPlugin[]> {
  if (installed !== undefined) {
    return installed;
  }
  const pluginProject = project ?? dirname(appEntry);
  return project ||
    (await Bun.file(resolve(pluginProject, "package.json")).exists())
    ? await installedPlugins(pluginProject, (await release()).version)
    : [];
}

/** Subpaths a package exports; a package without subpath exports shares only its root. */
function exportedSubpaths(manifest: unknown): string[] {
  const exports =
    manifest && typeof manifest === "object" && "exports" in manifest
      ? manifest.exports
      : undefined;
  return exports &&
    typeof exports === "object" &&
    Object.keys(exports).some((key) => key.startsWith("."))
    ? Object.keys(exports)
    : [
        ".",
      ];
}

/** Wildcard and non-subpath export keys cannot be named as one shared entry. */
function isSharedSubpath(subpath: string): boolean {
  return (
    subpath === "." || (subpath.startsWith("./") && !subpath.includes("*"))
  );
}

/** Resolve one export for the import or require condition; disabled exports resolve to nothing. */
function resolveSharedSource(
  name: string,
  kind: "import" | "require",
  require: ReturnType<typeof createRequire>,
  project: string,
): string | undefined {
  try {
    return kind === "require"
      ? require.resolve(name)
      : Bun.resolveSync(name, project);
  } catch {
    // Disabled exports are not shared; actual imports still fail in the app build.
    return undefined;
  }
}

/** Assets use Bun's loaders instead of the executable-module wrappers. */
function isBundledModule(entry: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(entry) && !/\.d\.[cm]?ts$/.test(entry);
}

/** Add the import and require entries of every shareable export of one plugin package. */
async function addPluginEntries(
  plugin: InstalledPlugin,
  project: string,
  require: ReturnType<typeof createRequire>,
  sharedEntries: Map<string, string>,
): Promise<void> {
  const manifest = await json(resolve(plugin.root, "package.json"));
  for (const subpath of exportedSubpaths(manifest).filter(isSharedSubpath)) {
    const name =
      subpath === "."
        ? plugin.packageName
        : plugin.packageName + subpath.slice(1);
    for (const kind of [
      "import",
      "require",
    ] as const) {
      const source = resolveSharedSource(name, kind, require, project);
      if (source === undefined) {
        continue;
      }
      const entry = await realpath(source);
      if (isBundledModule(entry)) {
        sharedEntries.set(kind === "require" ? `require:${name}` : name, entry);
      }
    }
  }
}

/** Development builds share the SDK and plugin entries between the host and reloaded apps. */
async function collectSharedEntries(
  sdk: SdkPlugin,
  project: string,
  plugins: readonly InstalledPlugin[],
): Promise<Map<string, string>> {
  const sharedEntries = new Map<string, string>();
  const require = createRequire(resolve(project, "package.json"));
  for (const entry of sdk.entries) {
    sharedEntries.set(...entry);
  }
  for (const plugin of plugins) {
    await addPluginEntries(plugin, project, require, sharedEntries);
  }
  return sharedEntries;
}

/** Give each distinct shared source one generated entry name, whatever names import it. */
function nameSharedEntries(sharedEntries: ReadonlyMap<string, string>) {
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
  return {
    sdkNames,
    namesBySource,
    sdkSources,
  };
}

function windowsEntryPlugin(
  source: string,
  appEntry: string,
  plugins: readonly InstalledPlugin[],
  sdk: SdkPlugin | undefined,
  sdkSources: ReadonlyMap<string, string>,
): BunPlugin {
  return {
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
}

/** Record the inputs Bun reports as CommonJS, which need a raw entry instead of an ESM barrel. */
function commonJsCollector(commonJsSources: Set<string>) {
  return (metadata: Bun.BuildMetafile | undefined) => {
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
  };
}

/** Write each build output and return the basenames of the ones that are assets, not modules. */
async function saveWindowsOutputs(
  artifacts: Bun.BuildArtifact[],
  destination: string,
  development: boolean,
): Promise<string[]> {
  const bundledAssets = new Set<string>();
  for (const output of artifacts) {
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
  }
  return [
    ...bundledAssets,
  ].sort();
}

/** Record which generated entry serves each shared name so reloads can import them as externals. */
async function writeSdkInventory(
  destination: string,
  sdkNames: ReadonlyMap<string, string>,
  sharedEntries: ReadonlyMap<string, string>,
  commonJsSources: ReadonlySet<string>,
): Promise<void> {
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
  const plugins = await hostPlugins(appEntry, project, installed);
  const sdk = project ? await sdkPlugin(project, [], plugins) : undefined;
  await writePluginManifest(destination, plugins);
  const sharedEntries =
    development && sdk && project
      ? await collectSharedEntries(sdk, project, plugins)
      : new Map<string, string>();
  const { sdkNames, namesBySource, sdkSources } =
    nameSharedEntries(sharedEntries);
  const commonJsSources = new Set<string>();
  const artifacts = await buildWithSdk(
    {
      entrypoints: [
        resolve(source, "boot.ts"),
        resolve(source, "ui.ts"),
        resolve(source, "host-operations.ts"),
        "bunaway-generated/plugin-imports.ts",
        "bunaway-generated/app.ts",
        ...[
          ...namesBySource.values(),
        ].map((name) => `bunaway-generated/${name}.ts`),
      ],
      target: "bun",
      packages: "bundle",
      splitting: true,
      naming: "[name].[ext]",
      sourcemap: development ? "inline" : "none",
      metafile: sharedEntries.size > 0,
    },
    windowsEntryPlugin(source, appEntry, plugins, sdk, sdkSources),
    sharedEntries.size ? commonJsCollector(commonJsSources) : undefined,
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
  const bundledAssets = await saveWindowsOutputs(
    artifacts,
    destination,
    development,
  );
  if (sharedEntries.size) {
    await writeSdkInventory(
      destination,
      sdkNames,
      sharedEntries,
      commonJsSources,
    );
  }
  return bundledAssets;
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

/**
 * Resolves the app facts that mobile backends receive as a build-time constant,
 * from the same sources as the desktop package manifest: the app settings, the
 * app's package.json version and the framework's package.json version.
 */
async function mobileAppMetadata(project: Project): Promise<AppMetadata> {
  return {
    name: appName(project.app.title, project.app.appId),
    identifier: project.app.appId,
    ...(await readAppVersions(project.root, project.frameworkRoot)),
    isPackaged: true,
    paths: null,
  };
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
  const appMetadata = await mobileAppMetadata(project);
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
          appMetadata,
        }).setup(build);
      },
    },
  );
  await writeMobileBackend(backend, assets, [
    "backend.js",
  ]);
}

/** Bundle the long-lived iOS entry and its replaceable backend Worker from app.ts. */
export async function bundleIosAssets(
  project: Project,
  assets: string,
): Promise<void> {
  await assertAppDefinitionExport(project.appEntry);
  const sdk = await sdkPlugin(project.root, [], project.nativePlugins);
  await webAssets(project, resolve(assets, "web"), sdk, false);
  const source = resolve(project.frameworkRoot, "native/ios");
  const appMetadata = await mobileAppMetadata(project);
  const outputs = await buildWithSdk(
    {
      entrypoints: [
        resolve(source, "entry.ts"),
        resolve(source, "backend.ts"),
      ],
      target: "bun",
      packages: "bundle",
      splitting: false,
      naming: {
        entry: "[name].js",
        asset: "backend-assets/[name]-[hash].[ext]",
      },
    },
    {
      name: "ios-app-entry",
      setup(build) {
        sdk.setup(build);
        appModules({
          appMetadata,
        }).setup(build);
        build.onResolve(
          {
            filter: /^\.\/app\.js$/,
          },
          ({ importer }) =>
            resolve(importer) === resolve(source, "backend.ts")
              ? {
                  path: project.appEntry,
                }
              : undefined,
        );
      },
    },
  );
  await writeMobileBackend(outputs, assets, [
    "entry.js",
    "backend.js",
  ]);
}

/** Preserve mobile backend entries and file imports together in their relative layout. */
export async function writeMobileBackend(
  outputs: readonly Bun.BuildArtifact[],
  assets: string,
  expectedEntries: readonly string[],
): Promise<void> {
  const entries = outputs.filter((output) => output.kind === "entry-point");
  const names = entries.map((output) => basename(output.path));
  if (
    names.length !== expectedEntries.length ||
    expectedEntries.some((name) => !names.includes(name))
  ) {
    throw new Error("Missing mobile backend bundle.");
  }
  const destination = resolve(assets, "backend");
  for (const output of outputs) {
    if (output.kind !== "entry-point" && output.kind !== "asset") {
      throw new Error(`Unexpected mobile backend output: ${output.kind}`);
    }
    const path = resolve(destination, output.path);
    if (!inside(destination, path)) {
      throw new Error(
        `Mobile backend output escapes destination: ${output.path}`,
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
        resolve(source, "host-operations.ts"),
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

import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PLATFORMS } from "@bunaway/plugin-api";
import { type NativePluginContract, NativeRegistry } from "@bunaway/protocol";
import { readAppManifest } from "@bunaway/runtime-bun/app-manifest";
import {
  inside,
  installedPackageRoot,
  isOptionalDependency,
  json,
  type PackageDependencies,
  writeJson,
} from "./files.ts";

export type InstalledPlugin = {
  name: string;
  packageName: string;
  root: string;
  version: string;
  native: NativePluginContract;
  targets: Record<
    string,
    {
      thread: "worker" | "ui";
      operations: string;
      supportedOperations?: string[];
    }
  >;
};

/** Read declaration metadata in an isolated Bun process without invoking factories. */
export async function readPluginDeclaration(
  entry: string,
  directory: string,
  packageName?: string,
) {
  // Read the declaration without importing the app, calling its API or initializing adapters.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { default: exported } = await import(${JSON.stringify(pathToFileURL(entry).href)}); const plugin = exported?._definition; if (!plugin || typeof plugin !== "object") throw new Error("Native plugin default export must be a defineNativePlugin result."); const packageName = ${JSON.stringify(packageName ?? null)}; process.stdout.write(JSON.stringify({ name: plugin.name, version: plugin.version, native: plugin.native, nativePlatforms: plugin.nativePlatforms && Object.fromEntries(Object.entries(plugin.nativePlatforms).map(([os, target]) => [os, { ...target, create: typeof target.create === "function", ...(packageName ? { module: Bun.resolveSync(packageName + "/native/" + os, ${JSON.stringify(directory)}) } : {}) }])) }));`,
    ],
    {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  if ((await child.exited) !== 0) {
    throw new Error(await errors);
  }
  const declaration = JSON.parse(await output) as {
    name: string;
    version: string;
    native: NativePluginContract;
    nativePlatforms: Record<
      string,
      {
        thread: "worker" | "ui";
        create: boolean;
        module?: string;
        operations?: string[];
      }
    >;
  };
  await errors;
  const native = declaration.native;
  new NativeRegistry([
    {
      name: declaration.name,
      version: declaration.version,
      native,
    },
  ]);
  if (
    !declaration.nativePlatforms ||
    typeof declaration.nativePlatforms !== "object" ||
    Array.isArray(declaration.nativePlatforms)
  ) {
    throw new Error("Invalid native plugin platform declaration.");
  }
  for (const [platform, target] of Object.entries(
    declaration.nativePlatforms,
  )) {
    if (
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      Object.hasOwn(target, "execution") ||
      !PLATFORMS.some((supported) => supported === platform) ||
      ![
        "worker",
        "ui",
      ].includes(target.thread)
    ) {
      throw new Error("Invalid native plugin target.");
    }
    if (target.create !== true) {
      throw new Error("Native plugin platforms require an adapter factory.");
    }
    if (
      target.operations !== undefined &&
      (!Array.isArray(target.operations) ||
        new Set(target.operations).size !== target.operations.length ||
        target.operations.some(
          (operation) =>
            typeof operation !== "string" ||
            !native.operations.some(
              (contract) =>
                contract.name === `${declaration.name}.${operation}`,
            ),
        ))
    ) {
      throw new Error("Invalid native plugin operation support.");
    }
  }
  return declaration;
}

/** Resolve an installed plugin file and reject paths that escape its package. */
async function contained(root: string, value: unknown): Promise<string> {
  if (
    typeof value !== "string" ||
    isAbsolute(value) ||
    value.split(/[\\/]/).includes("..")
  ) {
    throw new Error("Plugin paths must remain inside their installed package.");
  }
  const path = await realpath(resolve(root, value));
  if (!inside(root, path)) {
    throw new Error("Plugin path escapes its installed package.");
  }
  return path;
}

/**
 * Load and validate native plugins declared by the project dependencies.
 * Optional missing packages are skipped; incompatible installed packages fail.
 */
export async function installedPlugins(
  project: string,
  version: string,
): Promise<InstalledPlugin[]> {
  const pkg = (await json(
    resolve(project, "package.json"),
  )) as PackageDependencies;
  const result: InstalledPlugin[] = [];
  for (const packageName of Object.keys({
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  })) {
    let root: string;
    try {
      root = await installedPackageRoot(project, packageName);
    } catch (error) {
      if (
        isOptionalDependency(pkg, packageName) &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    const manifest = (await json(resolve(root, "package.json"))) as {
      name: string;
      version: string;
      bunaway?: {
        plugin?: string;
      };
      peerDependencies?: Record<string, string>;
    };
    if (!manifest.bunaway?.plugin) {
      continue;
    }
    if (
      manifest.name !== packageName ||
      (packageName.startsWith("@bunaway/") && manifest.version !== version) ||
      !(
        manifest.peerDependencies?.["@bunaway/plugin"] === version ||
        manifest.peerDependencies?.["@bunaway/plugin"]?.endsWith(".tgz")
      )
    ) {
      throw new Error(`Incompatible native plugin package: ${packageName}.`);
    }
    for (const [name, peer] of Object.entries(
      manifest.peerDependencies ?? {},
    )) {
      if (!name.startsWith("@bunaway/")) {
        continue;
      }
      const installed = (await json(
        resolve(await installedPackageRoot(root, name), "package.json"),
      )) as {
        name: string;
        version: string;
      };
      if (
        installed.name !== name ||
        installed.version !== version ||
        !(peer === version || peer.endsWith(".tgz"))
      ) {
        throw new Error(
          `Incompatible SDK/CLI package: ${name}; expected ${version} for plugin ${packageName}.`,
        );
      }
    }
    const entry = await contained(root, manifest.bunaway.plugin);
    const declaration = await readPluginDeclaration(
      entry,
      project,
      packageName,
    );
    if (declaration.version !== manifest.version) {
      throw new Error(
        "Plugin declaration does not match its installed manifest.",
      );
    }
    const native = declaration.native;
    const targets: InstalledPlugin["targets"] = {};
    for (const [platform, target] of Object.entries(
      declaration.nativePlatforms,
    )) {
      // Normalize Windows short names and linked paths before comparing with the canonical package root.
      const nativeEntry = await realpath(target.module ?? "");
      targets[platform] = {
        thread: target.thread,
        operations: await contained(root, relative(root, nativeEntry)),
        ...(target.operations === undefined
          ? {}
          : {
              supportedOperations: target.operations.map(
                (operation) => `${declaration.name}.${operation}`,
              ),
            }),
      };
    }
    result.push({
      name: declaration.name,
      packageName,
      root,
      version: manifest.version,
      native,
      targets,
    });
  }
  new NativeRegistry(result, {
    mode: "catalog",
  });
  return result;
}

/** Refresh installed plugin data in the execution manifest and reset reload inventory. */
export async function writePluginManifest(
  assets: string,
  plugins: readonly InstalledPlugin[],
  platform: "windows" | "macos" = "windows",
): Promise<void> {
  await mkdir(assets, {
    recursive: true,
  });
  const manifest = (await Bun.file(resolve(assets, "manifest.json")).exists())
    ? await readAppManifest(assets)
    : {
        format: 1,
        app: {},
        policy: {},
        plugins: [],
        developmentSdk: {},
      };
  await writeJson(resolve(assets, "manifest.json"), {
    ...manifest,
    plugins: plugins.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      native: plugin.native,
      ...(plugin.targets[platform]
        ? {
            thread: plugin.targets[platform]?.thread,
            ...(plugin.targets[platform]?.supportedOperations === undefined
              ? {}
              : {
                  supportedOperations:
                    plugin.targets[platform]?.supportedOperations,
                }),
          }
        : {}),
    })),
    developmentSdk: {},
  });
}

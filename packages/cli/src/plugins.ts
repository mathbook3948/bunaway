import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type NativePluginContract, NativeRegistry } from "@bunaway/protocol";
import {
  inside,
  installedPackageRoot,
  isOptionalDependency,
  json,
  type PackageDependencies,
} from "./files.ts";

export type InstalledPlugin = {
  name: string;
  packageName: string;
  root: string;
  version: string;
  native: NativePluginContract;
  authorization?: string;
  targets: Record<string, { execution: "io" | "ui"; operations: string }>;
};

async function contained(root: string, value: unknown): Promise<string> {
  if (typeof value !== "string" || isAbsolute(value) || value.split(/[\\/]/).includes(".."))
    throw new Error("Plugin paths must remain inside their installed package.");
  const path = await realpath(resolve(root, value));
  if (!inside(root, path)) throw new Error("Plugin path escapes its installed package.");
  return path;
}

export async function installedPlugins(
  project: string,
  version: string,
): Promise<InstalledPlugin[]> {
  const pkg = (await json(resolve(project, "package.json"))) as PackageDependencies;
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
      )
        continue;
      throw error;
    }
    const manifest = (await json(resolve(root, "package.json"))) as {
      name: string;
      version: string;
      bunaway?: { plugin?: string };
      peerDependencies?: Record<string, string>;
    };
    if (!manifest.bunaway?.plugin) continue;
    if (
      manifest.name !== packageName ||
      (packageName.startsWith("@bunaway/") && manifest.version !== version) ||
      !(
        manifest.peerDependencies?.["@bunaway/plugin"] === version ||
        manifest.peerDependencies?.["@bunaway/plugin"]?.endsWith(".tgz")
      )
    )
      throw new Error(`Incompatible native plugin package: ${packageName}.`);
    for (const [name, peer] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!name.startsWith("@bunaway/")) continue;
      const installed = (await json(
        resolve(await installedPackageRoot(root, name), "package.json"),
      )) as { name: string; version: string };
      if (
        installed.name !== name ||
        installed.version !== version ||
        !(peer === version || peer.endsWith(".tgz"))
      )
        throw new Error(
          `Incompatible SDK/CLI package: ${name}; expected ${version} for plugin ${packageName}.`,
        );
    }
    const descriptor = (await json(await contained(root, manifest.bunaway.plugin))) as {
      format: number;
      name: string;
      entry: string;
      platforms: Record<string, { execution: "io" | "ui"; operations: string }>;
    };
    if (descriptor.format !== 1 || !descriptor.platforms)
      throw new Error("Invalid native plugin descriptor.");
    const entry = await contained(root, descriptor.entry);
    // Read the declaration without importing the app, calling its API or initializing adapters.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { default: plugin } = await import(${JSON.stringify(pathToFileURL(entry).href)}); process.stdout.write(JSON.stringify({ name: plugin.name, version: plugin.version, native: plugin.native, matches: typeof plugin.matches === "function" }));`,
      ],
      { cwd: project, stdout: "pipe", stderr: "pipe" },
    );
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    if ((await child.exited) !== 0) throw new Error(await errors);
    const declaration = JSON.parse(await output) as {
      name: string;
      version: string;
      native: NativePluginContract;
      matches: boolean;
    };
    await errors;
    if (declaration.name !== descriptor.name || declaration.version !== manifest.version)
      throw new Error("Plugin declaration does not match its installed manifest.");
    const native = declaration.native;
    new NativeRegistry([{ name: descriptor.name, version: manifest.version, native }]);
    const scoped = native.permissions.some((permission) => permission.scope);
    if (scoped && !declaration.matches)
      throw new Error("Scoped plugin permissions require matches.");
    const targets: InstalledPlugin["targets"] = {};
    for (const [platform, target] of Object.entries(descriptor.platforms)) {
      if (
        !["windows", "macos", "linux", "android", "ios"].includes(platform) ||
        !["io", "ui"].includes(target.execution)
      )
        throw new Error("Invalid native plugin target.");
      targets[platform] = {
        execution: target.execution,
        operations: await contained(root, target.operations),
      };
    }
    result.push({
      name: descriptor.name,
      packageName,
      root,
      version: manifest.version,
      native,
      ...(scoped ? { authorization: entry } : {}),
      targets,
    });
  }
  new NativeRegistry(result, { mode: "catalog" });
  return result;
}

export function pluginTableSource(plugins: readonly InstalledPlugin[]): string {
  return `export const packagedPlugins = [${plugins
    .map((plugin) => {
      const target = plugin.targets.windows;
      return `{ name: ${JSON.stringify(plugin.name)}, version: ${JSON.stringify(plugin.version)}, native: ${JSON.stringify(plugin.native)}${plugin.authorization ? `, authorization: () => import(${JSON.stringify(plugin.authorization)}).then(({ default: plugin }) => ({ matches: plugin.matches }))` : ""}${target ? `, execution: ${JSON.stringify(target.execution)}, operations: () => import(${JSON.stringify(target.operations)})` : ""} }`;
    })
    .join(",")}];`;
}

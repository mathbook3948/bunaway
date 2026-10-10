import { readAppManifest } from "@bunaway/runtime-bun/app-manifest";
import type { PackagedPlugin, PluginImports } from "./plugin-contract.ts";

/** Join manifest data with bundled or already loaded imports without initializing adapters. */
export async function loadPluginCatalog(
  assets: string,
  imports?: PluginImports,
): Promise<readonly PackagedPlugin[]> {
  const manifest = await readAppManifest(assets);
  // Keep the dependency visible to both bundle passes so adapters share the host's SDK classes.
  const pluginImports =
    imports ?? (await import("bunaway:plugin-imports")).pluginImports;
  return manifest.plugins.map(({ authorization, ...plugin }) => {
    const imports = pluginImports[plugin.name];
    if (
      !Object.hasOwn(pluginImports, plugin.name) ||
      !imports ||
      (typeof imports.authorization === "function") !== authorization ||
      (typeof imports.operations === "function") !==
        (plugin.execution !== undefined)
    ) {
      throw new Error(
        `Generated plugin imports do not match the manifest: ${plugin.name}.`,
      );
    }
    return {
      ...plugin,
      ...imports,
    };
  });
}

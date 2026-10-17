import { dirname, resolve } from "node:path";
import type { AppMetadata } from "@bunaway/runtime-bun/app-metadata";
import type { BunPlugin } from "bun";
import type { InstalledPlugin } from "./plugins.ts";

/** Preserve dynamically discovered CommonJS exports when loading a shared SDK bundle. */
export function commonJsSdkSource(entry: string): string {
  return `module.exports = require(${JSON.stringify(`./${entry}.js`)}).default;\n`;
}

/** Generate executable links only; installed contracts remain in the execution manifest. */
export function pluginImportsSource(
  plugins: readonly InstalledPlugin[],
  platform: "windows" | "macos" = "windows",
): string {
  return `export const pluginImports = {${plugins
    .map((plugin) => {
      const target = plugin.targets[platform];
      return `[${JSON.stringify(plugin.name)}]: {${target ? `operations: () => import(${JSON.stringify(target.operations)}).then(({ default: plugin }) => ({ createOperations: plugin._definition.nativePlatforms[${JSON.stringify(platform)}].create }))` : ""}}`;
    })
    .join(",")}};\n`;
}

/**
 * Own the app's build-only modules in one namespace. Literal imports let both
 * bundling passes preserve SDK identity without writing intermediate source files.
 */
export function appModules(options: {
  appEntry?: string;
  processRuntime?: string;
  /** App facts embedded in the generated process backend; required with `processRuntime`. */
  appMetadata?: AppMetadata;
  plugins?: readonly InstalledPlugin[];
  platform?: "windows" | "macos";
  sdkSources?: ReadonlyMap<string, string>;
}): BunPlugin {
  const modules = new Map<
    string,
    {
      contents: string;
      resolveDir: string;
    }
  >();
  if (options.processRuntime && !options.appMetadata) {
    throw new Error("A process backend requires app metadata.");
  }
  if (options.appMetadata) {
    // Build-time constant: the backend has no package manifest to read at run time.
    modules.set("app-metadata.ts", {
      contents: `export default ${JSON.stringify(options.appMetadata)};`,
      resolveDir: process.cwd(),
    });
  }
  if (options.appEntry) {
    const entry = resolve(options.appEntry);
    modules.set(options.processRuntime ? "backend.ts" : "app.ts", {
      contents: options.processRuntime
        ? `import app from ${JSON.stringify(entry)};\nimport appMetadata from "bunaway-generated/app-metadata.ts";\nimport { runBunApp } from ${JSON.stringify(options.processRuntime)};\nawait runBunApp(app, { app: appMetadata });`
        : `export { default } from ${JSON.stringify(entry)};`,
      resolveDir: dirname(entry),
    });
  }
  modules.set("plugin-imports.ts", {
    contents: pluginImportsSource(options.plugins ?? [], options.platform),
    resolveDir: process.cwd(),
  });
  for (const [name, source] of options.sdkSources ?? []) {
    modules.set(name, {
      // Bun's namespace also exposes the default created for CommonJS modules.
      contents: `export * from ${JSON.stringify(source)};\nimport * as entry from ${JSON.stringify(source)};\nconst defaultExport = Reflect.get(entry, "default");\nexport { defaultExport as default };`,
      resolveDir: dirname(source),
    });
  }
  return {
    name: "bunaway-app-modules",
    setup(build) {
      build.onResolve(
        {
          filter: /^(bunaway-generated\/|bunaway:plugin-imports$)/,
        },
        ({ path }) => ({
          path:
            path === "bunaway:plugin-imports"
              ? "plugin-imports.ts"
              : path.slice("bunaway-generated/".length),
          namespace: "bunaway-generated",
        }),
      );
      build.onLoad(
        {
          filter: /.*/,
          namespace: "bunaway-generated",
        },
        ({ path }) => {
          const module = modules.get(path);
          if (!module) {
            throw new Error(`Unknown generated app module: ${path}`);
          }
          return {
            ...module,
            loader: "ts",
          };
        },
      );
    },
  };
}

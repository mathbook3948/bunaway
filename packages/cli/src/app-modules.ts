import { dirname, resolve } from "node:path";
import type { BunPlugin } from "bun";
import type { InstalledPlugin } from "./plugins.ts";

/** Preserve dynamically discovered CommonJS exports when loading a shared SDK bundle. */
export function commonJsSdkSource(entry: string): string {
  return `module.exports = require(${JSON.stringify(`./${entry}.js`)}).default;\n`;
}

/** Generate executable links only; installed contracts remain in the execution manifest. */
export function pluginImportsSource(
  plugins: readonly InstalledPlugin[],
): string {
  return `export const pluginImports = {${plugins
    .map((plugin) => {
      const target = plugin.targets.windows;
      return `[${JSON.stringify(plugin.name)}]: {${plugin.authorization ? `authorization: () => import(${JSON.stringify(plugin.authorization)}).then(({ default: plugin }) => ({ matches: plugin.matches })),` : ""}${target ? `operations: () => import(${JSON.stringify(target.operations)})` : ""}}`;
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
  plugins?: readonly InstalledPlugin[];
  sdkSources?: ReadonlyMap<string, string>;
}): BunPlugin {
  const modules = new Map<
    string,
    {
      contents: string;
      resolveDir: string;
    }
  >();
  if (options.appEntry) {
    const entry = resolve(options.appEntry);
    modules.set(options.processRuntime ? "backend.ts" : "app.ts", {
      contents: options.processRuntime
        ? `import app from ${JSON.stringify(entry)};\nimport { runBunApp } from ${JSON.stringify(options.processRuntime)};\nawait runBunApp(app);`
        : `export { default } from ${JSON.stringify(entry)};`,
      resolveDir: dirname(entry),
    });
  }
  modules.set("plugin-imports.ts", {
    contents: pluginImportsSource(options.plugins ?? []),
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

import { cp, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import type { Project } from "./config.ts";
import { files, inside, installedPackageRoot } from "./files.ts";
import { assertAppDefinitionExport, buildWithSdk, sdkPlugin } from "./sdk.ts";

async function bundleBytes(output: Bun.BuildArtifact, development: boolean): Promise<Uint8Array> {
  const bytes = new Uint8Array(await output.arrayBuffer());
  if (!development || !output.path.endsWith(".js")) return bytes;
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
  if (entrypoints.length === 0) return [];
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
  const outputs = new Map<string, { path: string; source: string | Bun.BuildArtifact }>();
  const addOutput = (name: string, source: string | Bun.BuildArtifact) => {
    const path = resolve(destination, name);
    if (!inside(destination, path)) throw new Error(`Frontend output escapes destination: ${name}`);
    const rel = relative(destination, path).replaceAll("\\", "/");
    const key = rel.toLowerCase();
    if (outputs.has(key)) throw new Error(`Frontend output collision: ${rel}`);
    outputs.set(key, { path, source });
  };
  for (const source of sources) {
    const rel = relative(project.frontend, source);
    if (rel.endsWith(".d.ts")) continue;
    const isEntry = /\.(ts|js)$/.test(rel);
    if (isEntry) entries.push(source);
    else addOutput(rel, source);
  }
  for (const output of await bundle(entries, project.frontend, plugin, development))
    addOutput(output.path, output);
  for (const { path, source } of outputs.values()) {
    await mkdir(dirname(path), { recursive: true });
    if (typeof source === "string") await cp(source, path);
    else await writeFile(path, await bundleBytes(source, development));
  }
}

export async function bundleAssets(
  project: Project,
  assets: string,
  developmentServer = false,
  development = false,
): Promise<void> {
  await assertAppDefinitionExport(project.appEntry);
  const plugin = await sdkPlugin(project.root);
  if (!developmentServer) await webAssets(project, resolve(assets, "web"), plugin, development);
  const runtimeEntry = resolve(
    await installedPackageRoot(project.frameworkRoot, "@bunaway/runtime-bun"),
    "src/index.ts",
  );
  // The current process host needs a bootstrap; app authors only supply the definition.
  const entry: BunPlugin = {
    name: "process-app-entry",
    setup(build) {
      plugin.setup(build);
      build.onResolve({ filter: /^bunaway-process-app$/ }, () => ({
        path: "backend.ts",
        namespace: "bunaway-process-entry",
      }));
      build.onLoad({ filter: /.*/, namespace: "bunaway-process-entry" }, () => ({
        contents: `import app from ${JSON.stringify(project.appEntry)};
import { runBunApp } from ${JSON.stringify(runtimeEntry)};
await runBunApp(app);`,
        loader: "ts",
        resolveDir: project.root,
      }));
    },
  };
  const backend = await buildWithSdk(
    {
      entrypoints: ["bunaway-process-app"],
      target: "bun",
      packages: "bundle",
      sourcemap: development ? "inline" : "none",
    },
    entry,
  );
  const backendOutput = backend[0];
  if (backend.length !== 1 || !backendOutput) throw new Error("Missing backend bundle.");
  await writeFile(resolve(assets, "backend.js"), await bundleBytes(backendOutput, development));
}

export async function bundleWindowsAssets(
  project: Project,
  assets: string,
  developmentServer = false,
  development = false,
): Promise<void> {
  await assertAppDefinitionExport(project.appEntry);
  if (!developmentServer)
    await webAssets(project, resolve(assets, "web"), await sdkPlugin(project.root), development);
  await bundleWindowsHost(
    resolve(project.frameworkRoot, "native/windows/bun"),
    assets,
    project.appEntry,
    project.root,
    development,
  );
}

export async function bundleWindowsHost(
  source: string,
  destination: string,
  appEntry: string,
  project?: string,
  development = false,
): Promise<void> {
  // A shared chunk preserves class identity (e.g. BunawayError) between core and app.
  const sdk = project ? await sdkPlugin(project) : undefined;
  const entries: BunPlugin = {
    name: "windows-app-entry",
    setup(build) {
      sdk?.setup(build);
      build.onResolve({ filter: /^bunaway-windows-app\/app\.ts$/ }, () => ({
        path: "app.ts",
        namespace: "bunaway-windows-entry",
      }));
      build.onLoad({ filter: /.*/, namespace: "bunaway-windows-entry" }, () => ({
        contents: `export { default } from ${JSON.stringify(resolve(appEntry))};`,
        loader: "ts",
        resolveDir: dirname(resolve(appEntry)),
      }));
    },
  };
  const options: Bun.BuildConfig = {
    entrypoints: [resolve(source, "boot.ts"), "bunaway-windows-app/app.ts"],
    target: "bun",
    packages: "bundle",
    splitting: true,
    naming: "[name].[ext]",
    sourcemap: development ? "inline" : "none",
  };
  const artifacts = await buildWithSdk(options, entries);
  if (
    !["boot.js", "app.js"].every((name) =>
      artifacts.some((output) => basename(output.path) === name),
    )
  )
    throw new Error("Windows bootstrap bundle failed");
  for (const output of artifacts)
    await writeFile(
      resolve(destination, basename(output.path)),
      await bundleBytes(output, development),
    );
  for (const name of ["ui", "host-operations"]) {
    const result = await Bun.build({
      entrypoints: [resolve(source, `${name}.ts`)],
      target: "bun",
      packages: "bundle",
      sourcemap: development ? "inline" : "none",
    });
    if (!result.success || result.outputs.length !== 1 || !result.outputs[0])
      throw new Error(`Windows host bundle failed: ${result.logs.join("\n")}`);
    await writeFile(
      resolve(destination, `${name}.js`),
      await bundleBytes(result.outputs[0], development),
    );
  }
}

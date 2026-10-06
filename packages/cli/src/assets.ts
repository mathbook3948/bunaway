import { cp, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import type { Project } from "./config.ts";
import { files, inside, installedPackageRoot } from "./files.ts";
import { assertAppDefinitionExport, buildWithSdk, sdkPlugin } from "./sdk.ts";

async function bundle(
  entrypoints: string[],
  root: string,
  plugin: BunPlugin,
): Promise<Bun.BuildArtifact[]> {
  if (entrypoints.length === 0) return [];
  return buildWithSdk({ entrypoints, root, target: "browser", splitting: false }, plugin);
}

async function webAssets(project: Project, destination: string, plugin: BunPlugin): Promise<void> {
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
  for (const output of await bundle(entries, project.frontend, plugin))
    addOutput(output.path, output);
  for (const { path, source } of outputs.values()) {
    await mkdir(dirname(path), { recursive: true });
    if (typeof source === "string") await cp(source, path);
    else await writeFile(path, new Uint8Array(await source.arrayBuffer()));
  }
}

export async function bundleAssets(
  project: Project,
  assets: string,
  developmentServer = false,
): Promise<void> {
  await assertAppDefinitionExport(project.appEntry);
  const plugin = await sdkPlugin(project.root);
  if (!developmentServer) await webAssets(project, resolve(assets, "web"), plugin);
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
    { entrypoints: ["bunaway-process-app"], target: "bun", packages: "bundle" },
    entry,
  );
  const backendOutput = backend[0];
  if (backend.length !== 1 || !backendOutput) throw new Error("Missing backend bundle.");
  await writeFile(resolve(assets, "backend.js"), new Uint8Array(await backendOutput.arrayBuffer()));
}

export async function bundleWindowsAssets(
  project: Project,
  assets: string,
  developmentServer = false,
): Promise<void> {
  await assertAppDefinitionExport(project.appEntry);
  if (!developmentServer)
    await webAssets(project, resolve(assets, "web"), await sdkPlugin(project.root));
  await bundleWindowsHost(
    resolve(project.frameworkRoot, "native/windows/bun"),
    assets,
    project.appEntry,
    project.root,
  );
}

export async function bundleWindowsHost(
  source: string,
  destination: string,
  appEntry: string,
  project?: string,
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
      new Uint8Array(await output.arrayBuffer()),
    );
  for (const name of ["ui", "host-operations"]) {
    const result = await Bun.build({
      entrypoints: [resolve(source, `${name}.ts`)],
      target: "bun",
      packages: "bundle",
    });
    if (!result.success || result.outputs.length !== 1 || !result.outputs[0])
      throw new Error(`Windows host bundle failed: ${result.logs.join("\n")}`);
    await writeFile(
      resolve(destination, `${name}.js`),
      new Uint8Array(await result.outputs[0].arrayBuffer()),
    );
  }
}

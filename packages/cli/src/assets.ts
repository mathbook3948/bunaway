import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import type { Project } from "./config.ts";
import { files, inside } from "./files.ts";
import { buildWithSdk, sdkPlugin } from "./sdk.ts";

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

export async function bundleAssets(project: Project, assets: string): Promise<void> {
  const plugin = await sdkPlugin(project.root);
  await webAssets(project, resolve(assets, "web"), plugin);
  const backend = await buildWithSdk(
    { entrypoints: [project.backend], target: "bun", packages: "bundle" },
    plugin,
  );
  const backendOutput = backend[0];
  if (backend.length !== 1 || !backendOutput) throw new Error("Missing backend bundle.");
  await writeFile(resolve(assets, "backend.js"), new Uint8Array(await backendOutput.arrayBuffer()));
}

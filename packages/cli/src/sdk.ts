import { lstat, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { files, json } from "./files.ts";

interface SdkReference {
  name: string;
  parent: string;
}

export async function sdkPlugin(
  project: string,
  references: readonly SdkReference[] = [],
): Promise<BunPlugin> {
  const root = resolve(project, "vendor/bunaway");
  const release = (await json(resolve(root, "framework.json"))) as {
    packages: Record<string, string>;
  };
  const entries = new Map<string, string>();
  for (const [directory, name] of Object.entries(release.packages)) {
    entries.set(name, await realpath(resolve(root, `packages/${directory}/src/index.ts`)));
  }
  async function check(name: string, parent: string): Promise<string> {
    const expected = entries.get(name);
    try {
      const path = await realpath(Bun.resolveSync(name, parent));
      if (expected && relative(expected, path) === "") return path;
    } catch {}
    throw new Error(
      `Incompatible SDK resolution: ${name} from ${parent}; run bun install to restore the pinned vendor workspaces.`,
    );
  }
  for (const { name, parent } of references) await check(name, parent);
  return {
    name: "pinned-bunaway-sdk",
    setup(build) {
      build.onResolve({ filter: /^@bunaway\// }, async ({ path, importer }) => ({
        path: await check(path, importer || project),
      }));
    },
  };
}

export async function validateSdkGraph(
  project: string,
  references: readonly SdkReference[],
  sources: readonly string[],
): Promise<void> {
  const plugin = await sdkPlugin(project, references);
  for (const source of sources) {
    const frontend = (await lstat(source)).isDirectory();
    const entrypoints = frontend
      ? (await files(source)).filter((path) => /\.(ts|js)$/.test(path) && !path.endsWith(".d.ts"))
      : [source];
    if (!entrypoints.length) continue;
    await buildWithSdk(
      {
        entrypoints,
        ...(frontend ? { root: source } : { packages: "bundle" as const }),
        target: frontend ? "browser" : "bun",
        splitting: false,
      },
      plugin,
    );
  }
}

export async function buildWithSdk(
  options: Bun.BuildConfig,
  plugin: BunPlugin,
): Promise<Bun.BuildArtifact[]> {
  try {
    const result = await Bun.build({ ...options, plugins: [plugin] });
    if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    return result.outputs;
  } catch (error) {
    const errors = error instanceof AggregateError ? error.errors : [error];
    throw new Error(`Bundle failed:\n${errors.map(String).join("\n")}`);
  }
}

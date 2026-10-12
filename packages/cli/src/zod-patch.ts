import { dirname, resolve } from "node:path";
import type { PluginBuilder } from "bun";
import patch from "../../../patches/zod-files.json";
import { frameworkRoot, json } from "./files.ts";

export const zodPatchFiles = Object.entries(patch.files);

/** Read only the reviewed patch, from the CLI artifact or the patched development dependency. */
export async function zodPatchSource(
  file: string,
  root = frameworkRoot,
): Promise<string> {
  const directory = (await Bun.file(
    resolve(root, "artifact.files.json"),
  ).exists())
    ? resolve(root, "packages/cli/vendor/zod")
    : dirname(Bun.resolveSync("zod/package.json", frameworkRoot));
  const source = (await Bun.file(resolve(directory, file)).text()).replaceAll(
    "\r\n",
    "\n",
  );
  const pin = zodPatchFiles.find(([name]) => name === file)?.[1];
  if (!pin || digest(source) !== pin.patched) {
    throw new Error(
      "Missing reviewed Zod patch; restore the pinned dependencies or CLI artifact.",
    );
  }
  return source;
}

function digest(source: string): string {
  return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

/** Apply the reviewed dependency patch while bundling, including external plugins' Zod imports. */
export function registerZodPatch(build: PluginBuilder, root: string): void {
  if (build.config.target !== "bun") {
    return;
  }
  const sources = new Map<string, Promise<string>>();
  build.onLoad(
    {
      filter: /[\\/]v4[\\/]core[\\/](schemas|checks|parse|util)\.(ts|js|cjs)$/,
    },
    async ({ path }) => {
      const file = path
        .replaceAll("\\", "/")
        .match(
          /((?:src\/)?v4\/core\/(?:schemas|checks|parse|util)\.(?:ts|js|cjs))$/,
        )?.[1];
      if (!file) {
        return undefined;
      }
      const manifestPath = resolve(path.slice(0, -file.length), "package.json");
      if (!(await Bun.file(manifestPath).exists())) {
        return undefined;
      }
      const manifest = await json(manifestPath);
      if (
        !manifest ||
        typeof manifest !== "object" ||
        Reflect.get(manifest, "name") !== "zod"
      ) {
        return undefined;
      }
      const pin = zodPatchFiles.find(([name]) => name === file)?.[1];
      const contents = (await Bun.file(path).text()).replaceAll("\r\n", "\n");
      const actual = digest(contents);
      if (
        Reflect.get(manifest, "version") !== patch.version ||
        !pin ||
        (actual !== pin.original && actual !== pin.patched)
      ) {
        throw new Error(
          "Unsupported Zod runtime at " +
            path +
            "; use the reviewed Zod " +
            patch.version +
            " dependency.",
        );
      }
      let source = sources.get(file);
      if (!source) {
        source = zodPatchSource(file, root);
        sources.set(file, source);
      }
      // Keep imports relative to the consumer's matching Zod installation, preserving module identity.
      return {
        contents: await source,
        loader: file.endsWith(".ts") ? "ts" : "js",
      };
    },
  );
}

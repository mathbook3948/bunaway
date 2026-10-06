import { cp, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { checkArtifact, packageFilename, release } from "./distribution.ts";
import { frameworkRoot, json, writeJson } from "./files.ts";

export async function createProject(
  directory: string,
  options: { packageDirectory?: string; template?: "vanilla" | "vite" } = {},
): Promise<string> {
  const template = options.template ?? "vanilla";
  if (template !== "vanilla" && template !== "vite")
    throw new Error(`Unknown template: ${template}.`);
  const requested = resolve(directory);
  const target = resolve(await realpath(dirname(requested)), basename(requested));
  try {
    await stat(target);
    throw new Error("Target exists; choose a new directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = `${target}.creating-${crypto.randomUUID()}`;
  try {
    if (await Bun.file(resolve(frameworkRoot, "artifact.files.json")).exists()) {
      await checkArtifact(frameworkRoot);
    }
    await cp(resolve(frameworkRoot, `packages/cli/templates/${template}`), staging, {
      recursive: true,
    });
    await rename(resolve(staging, "gitignore"), resolve(staging, ".gitignore"));
    await rename(resolve(staging, "gitattributes"), resolve(staging, ".gitattributes"));
    const info = await release();
    const pkg = (await json(resolve(staging, "package.json"))) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const dependencies of [pkg.dependencies, pkg.devDependencies]) {
      for (const name of Object.keys(dependencies).filter((name) => name.startsWith("@bunaway/"))) {
        if (options.packageDirectory) {
          const artifact = await realpath(
            resolve(options.packageDirectory, packageFilename(name, info.version)),
          );
          dependencies[name] = `file:${artifact.replaceAll("\\", "/")}`;
        } else dependencies[name] = info.version;
      }
    }
    await writeJson(resolve(staging, "package.json"), pkg);
    const configPath = resolve(staging, "src-bunaway/bunaway.json");
    const config = (await json(configPath)) as { app: Record<string, unknown> };
    const app = config.app;
    const slug =
      basename(target)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 40) || "app";
    app.appId = `app.${slug.replace(/^-+|-+$/g, "") || "app"}`;
    app.title = basename(target);
    await writeJson(configPath, config);
    await rename(staging, target);
    return target;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

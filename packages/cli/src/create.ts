import { cp, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { checkArtifact, copyFramework, writeFrameworkLock } from "./distribution.ts";
import { frameworkRoot, json, writeJson } from "./files.ts";

export async function createProject(directory: string): Promise<string> {
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
    await cp(resolve(frameworkRoot, "packages/cli/templates/vanilla"), staging, {
      recursive: true,
    });
    await rename(resolve(staging, "gitignore"), resolve(staging, ".gitignore"));
    const snapshot = resolve(staging, "vendor/bunaway");
    await copyFramework(snapshot);
    await writeFrameworkLock(staging);
    const app = (await json(resolve(staging, "app.json"))) as Record<string, unknown>;
    const slug =
      basename(target)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 40) || "app";
    app.appId = `app.${slug.replace(/^-+|-+$/g, "") || "app"}`;
    app.title = basename(target);
    await writeJson(resolve(staging, "app.json"), app);
    await rename(staging, target);
    return target;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

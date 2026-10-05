import { cp, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
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
    await cp(resolve(frameworkRoot, "packages/cli/templates/vanilla"), staging, {
      recursive: true,
    });
    const snapshot = resolve(staging, "vendor/bunaway");
    await mkdir(snapshot, { recursive: true });
    for (const name of [
      "backend-sdk",
      "client-sdk",
      "core",
      "protocol",
      "runtime-bun",
      "cli",
      "packaging",
    ]) {
      await cp(resolve(frameworkRoot, `packages/${name}`), resolve(snapshot, `packages/${name}`), {
        recursive: true,
        filter: (path) =>
          !/[\\/](node_modules|vendor|build|dist)([\\/]|$)/.test(path.slice(frameworkRoot.length)),
      });
    }
    for (const name of [
      "tsconfig.base.json",
      "package.json",
      "native/host-api/generated",
      "native/windows/host/host.cpp",
      "native/windows/host/CMakeLists.txt",
      "native/windows/host/deps.json",
      "native/windows/host/run.ps1",
      "native/macos/host/main.mm",
      "native/macos/host/run.sh",
      "runtime/build-manifests",
    ]) {
      await cp(resolve(frameworkRoot, name), resolve(snapshot, name), { recursive: true });
    }
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

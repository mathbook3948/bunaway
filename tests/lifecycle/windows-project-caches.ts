import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Copies the repository's Bun runtime and WebView2 SDK downloads into a created project's CLI
 * snapshot, so its `build` finds them without downloading again.
 */
export async function seedWindowsBuildCaches(
  project: string,
  repository: string,
): Promise<void> {
  const snapshot = resolve(project, "node_modules/@bunaway/cli");
  const cache = resolve(snapshot, "build/cache/bun");
  await mkdir(cache, {
    recursive: true,
  });
  for (const name of [
    "bun-windows-x64-baseline.zip",
    "bun-windows-x64-baseline",
    "LICENSE.bun",
  ]) {
    await cp(
      resolve(repository, "build/cache/bun", name),
      resolve(cache, name),
      {
        recursive: true,
      },
    );
  }
  const sdk = resolve(snapshot, "build/cache/webview2");
  await mkdir(sdk, {
    recursive: true,
  });
  await cp(
    resolve(repository, "build/cache/webview2/webview2-1.0.4129.50.nupkg"),
    resolve(sdk, "webview2-1.0.4129.50.nupkg"),
  );
}

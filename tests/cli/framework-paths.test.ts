import { expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { frameworkPaths } from "#cli/distribution";

const repository = resolve(import.meta.dir, "../..");
/** Native source directories whose files the installed framework compiles or imports. */
const shippedDirectories = [
  "native/windows/bun",
  "native/macos/bun",
  "native/host-api/bun",
  "native/ios",
];
/** Files that only build or run the repository's regression packages and never ship. */
const unshipped = new Set([
  "native/windows/bun/package.ts",
  "native/macos/bun/package.ts",
  "native/ios/run.ts",
  "native/ios/.gitkeep",
]);

/** Every file below `directory`, as repository-relative paths with forward slashes. */
async function filesBelow(directory: string): Promise<string[]> {
  const paths: string[] = [];
  const entries = await readdir(resolve(repository, directory), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      paths.push(...(await filesBelow(path)));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

test("every native host source file is listed in the framework distribution or marked unshipped", async () => {
  const listed = new Set<string>(frameworkPaths);
  const missing: string[] = [];
  for (const directory of shippedDirectories) {
    for (const path of await filesBelow(directory)) {
      if (!listed.has(path) && !unshipped.has(path)) {
        missing.push(path);
      }
    }
  }
  // A module the host imports but the distribution omits fails every installed app build.
  expect(missing).toEqual([]);
  for (const path of unshipped) {
    expect(listed.has(path)).toBe(false);
  }
});

test("every framework distribution entry exists in the repository", async () => {
  const stale: string[] = [];
  for (const path of frameworkPaths) {
    // A renamed or deleted entry only fails later, inside the framework pack.
    const exists = await stat(resolve(repository, path)).then(
      () => true,
      () => false,
    );
    if (!exists) {
      stale.push(path);
    }
  }
  expect(stale).toEqual([]);
});

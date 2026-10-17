import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { frameworkPaths } from "#cli/distribution";

const repository = resolve(import.meta.dir, "../..");
/** Native source directories whose files the installed framework compiles or imports. */
const shippedDirectories = [
  "native/windows/bun",
  "native/macos/bun",
  "native/host-api/bun",
];
/** Files that only build the repository's regression packages and never ship. */
const unshipped = new Set([
  "native/windows/bun/package.ts",
  "native/macos/bun/package.ts",
]);

test("every native host source file is listed in the framework distribution or marked unshipped", async () => {
  const listed = new Set<string>(frameworkPaths);
  const missing: string[] = [];
  for (const directory of shippedDirectories) {
    const entries = await readdir(resolve(repository, directory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const path = `${directory}/${entry.name}`;
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

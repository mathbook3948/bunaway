import { expect, test } from "bun:test";
import { resolve } from "node:path";

const plugins = resolve(import.meta.dir, "../../plugins");
/** A neutral plugin module (`src/*.ts`) that types its operations by a platform module. */
const PLATFORM_TYPE_IMPORT = /^import type .* from "#[\w-]+\/platforms\//;
/**
 * Neutral modules that still import a platform type. The list only shrinks: type the operations
 * by an interface declared in `contract.ts` (as `plugins/storage` does with `StorageInstance`)
 * and remove the file. A new plugin or a new import fails below.
 */
const KNOWN_PLATFORM_TYPE_IMPORTS: Record<string, number> = {
  "clipboard/src/operations.ts": 2,
  "global-shortcut/src/operations.ts": 1,
  "image/src/operations.ts": 1,
  "log/src/index.ts": 1,
  "log/src/operations.ts": 1,
  "notification/src/operations.ts": 1,
  "power/src/operations.ts": 1,
};

test("neutral plugin modules type their operations by a contract interface, not a platform class", async () => {
  const found = new Map<string, number>();
  for await (const file of new Bun.Glob("*/src/*.ts").scan({
    cwd: plugins,
  })) {
    const path = file.replaceAll("\\", "/");
    const count = (await Bun.file(resolve(plugins, path)).text())
      .split("\n")
      .filter((line) => PLATFORM_TYPE_IMPORT.test(line)).length;
    if (count > 0) {
      found.set(path, count);
    }
  }
  const grown = [
    ...found,
  ]
    .filter(([path, count]) => count > (KNOWN_PLATFORM_TYPE_IMPORTS[path] ?? 0))
    .map(([path, count]) => `${path}: ${count}`)
    .sort();
  // Declare the instance interface in contract.ts and `implements` it in each platform class.
  expect(grown).toEqual([]);
  const stale = Object.entries(KNOWN_PLATFORM_TYPE_IMPORTS)
    .filter(([path, count]) => (found.get(path) ?? 0) < count)
    .map(
      ([path, count]) => `${path}: ${found.get(path) ?? 0} (baseline ${count})`,
    )
    .sort();
  // A removed import stays removed: lower the baseline so the ratchet keeps its ground.
  expect(stale).toEqual([]);
});

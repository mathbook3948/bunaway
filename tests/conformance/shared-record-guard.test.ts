import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const EXEMPT = new Set([
  "packages/protocol/src/validation.ts",
  "tests/conformance/shared-record-guard.test.ts",
]);
/** A hand-written non-null, non-array object check; `isRecord` from `@bunaway/protocol` replaces it. */
const LOCAL_CHECK =
  /typeof (\w+) [!=]== "object"[^;{}]{0,60}Array\.isArray\(\1\)|Array\.isArray\((\w+)\)[^;{}]{0,60}typeof \2 [!=]== "object"/g;
/** A local copy of the type guard itself. */
const LOCAL_GUARD = /\): value is Record<string, unknown>/g;

/**
 * Files that still hold a hand-written check, with how many. Each count only goes down: moving a
 * check to `isRecord` lowers it, and a file that reaches zero leaves the list. A new file, or a
 * new check in a listed file, fails.
 */
const LOCAL_CHECKS: Record<string, number> = {
  "packages/plugin-sdk/src/index.ts": 2,
  "tests/api/menu.test.ts": 1,
  "tests/cli/distribution.test.ts": 3,
  "tests/core/core.test.ts": 1,
  "tests/fixtures/macos-image.ts": 6,
  "tests/lifecycle/macos-storage.ts": 3,
  "tests/lifecycle/windows-app-reload.ts": 1,
  "tests/lifecycle/windows-bun-storage.ts": 1,
  "tests/lifecycle/windows-modal-events.fixture.ts": 1,
  "tests/lifecycle/windows-path.test.ts": 1,
};

async function sources(): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of [
    "**/*.ts",
    "**/*.tsx",
  ]) {
    for await (const file of new Bun.Glob(pattern).scan({
      cwd: root,
    })) {
      if (!/(^|\/)(node_modules|dist|\.git)\//.test(file)) {
        files.push(file.replaceAll("\\", "/"));
      }
    }
  }
  return files.sort();
}

test("object shape checks use isRecord from @bunaway/protocol", async () => {
  const found: Record<string, number> = {};
  for (const file of await sources()) {
    if (EXEMPT.has(file)) {
      continue;
    }
    const text = await Bun.file(resolve(root, file)).text();
    const count =
      (text.match(LOCAL_CHECK)?.length ?? 0) +
      (text.match(LOCAL_GUARD)?.length ?? 0);
    if (count > 0) {
      found[file] = count;
    }
  }
  expect(found).toEqual(LOCAL_CHECKS);
});

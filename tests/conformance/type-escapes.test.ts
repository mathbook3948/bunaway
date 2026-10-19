import { expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { deadline } from "../fixtures/deadlines";

setDefaultTimeout(deadline("build"));

const repository = resolve(import.meta.dir, "../..");
const SOURCE_ROOTS = [
  "packages",
  "plugins",
  "native",
  "scripts",
];

/** Production files that still need a type escape, with how many they use today. */
const BASELINE: Readonly<Record<string, number>> = {
  "native/host-api/bun/plugins.ts": 3,
  "native/ios/backend.ts": 2,
  "native/macos/bun/backend.ts": 1,
  "native/windows/bun/boot.ts": 1,
  "packages/backend-sdk/src/app.ts": 1,
  "packages/plugin-sdk/src/index.ts": 1,
};

const ESCAPE =
  /\bas (?:unknown|never|any)\b|@ts-(?:ignore|expect-error|nocheck)|[:,]\s*any\b|<any>/g;

/** Counts type escapes on code lines; `@ts-` directives are comments, so they count anywhere. */
function countEscapes(source: string): number {
  let count = 0;
  for (const line of source.split("\n")) {
    const trimmed = line.trimStart();
    const isComment =
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*");
    for (const match of line.matchAll(ESCAPE)) {
      if (!isComment || match[0].startsWith("@ts-")) {
        count += 1;
      }
    }
  }
  return count;
}

async function productionFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of SOURCE_ROOTS) {
    const glob = new Bun.Glob(`${root}/**/*.{ts,tsx,mts,cts}`);
    for await (const scanned of glob.scan({
      cwd: repository,
    })) {
      const file = scanned.replaceAll("\\", "/");
      if (
        file.includes("node_modules/") ||
        file.endsWith(".d.ts") ||
        file.endsWith(".test.ts") ||
        file.includes("/tests/")
      ) {
        continue;
      }
      files.push(file);
    }
  }
  return files.sort();
}

test("the counter recognises type escapes and ignores prose", () => {
  expect(countEscapes("const a = b as unknown as C;")).toBe(1);
  expect(countEscapes("const a = b as never;")).toBe(1);
  expect(countEscapes("function f(x: any) {}")).toBe(1);
  expect(
    countEscapes("// @ts-expect-error generated\nimport x from 'y';"),
  ).toBe(1);
  expect(countEscapes("// cast it as unknown later\n * as never")).toBe(0);
  expect(countEscapes("// @ts-nocheck")).toBe(1);
  expect(countEscapes("const m: Map<string, any> = new Map();")).toBe(1);
  expect(countEscapes("const a = b as Known;")).toBe(0);
});

test("production code does not add type escapes beyond the recorded baseline", async () => {
  const actual: Record<string, number> = {};
  for (const file of await productionFiles()) {
    const count = countEscapes(
      await Bun.file(resolve(repository, file)).text(),
    );
    if (count > 0) {
      actual[file] = count;
    }
  }
  // Lowering a count is progress: update BASELINE so the new lower number is enforced.
  expect(actual).toEqual(BASELINE);
});

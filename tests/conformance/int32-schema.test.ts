import { expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { deadline } from "../fixtures/deadlines";

setDefaultTimeout(deadline("build"));

const repository = resolve(import.meta.dir, "../..");
const SHARED_MODULE = "packages/plugin-sdk/src/schemas.ts";
const SOURCE_ROOTS = [
  "packages",
  "plugins",
  "native",
];

const MAXIMUM = String.raw`(?:INT32_MAX|0x7fffffff|2_?147_?483_?647|2 ?\*\* ?31 ?- ?1)`;
const MINIMUM = String.raw`(?:INT32_MIN|-0x80000000|-2_?147_?483_?648|-\(?2 ?\*\* ?31\)?)`;
/** An upper bound at the signed 32-bit maximum, which only `int32Schema` should spell out. */
const UPPER_BOUND = new RegExp(String.raw`\.max\(\s*${MAXIMUM}\s*,?\s*\)`, "i");
/** Both bounds of the signed 32-bit range on one chain, in either order. */
const FULL_RANGE = new RegExp(
  String.raw`\.min\(\s*${MINIMUM}\s*,?\s*\)\s*\.max\(\s*${MAXIMUM}\s*,?\s*\)|\.max\(\s*${MAXIMUM}\s*,?\s*\)\s*\.min\(\s*${MINIMUM}\s*,?\s*\)`,
  "i",
);

/**
 * Whether a source file spells the signed 32-bit range as bounds on a number schema. A lone
 * lower bound is not flagged: a schema that widens the upper end (an exit code up to
 * 0xffffffff) is not a signed 32-bit integer.
 */
function declaresInt32Range(source: string): boolean {
  return UPPER_BOUND.test(source) || FULL_RANGE.test(source);
}

async function sourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of SOURCE_ROOTS) {
    const glob = new Bun.Glob(`${root}/**/*.ts`);
    for await (const scanned of glob.scan({
      cwd: repository,
    })) {
      const file = scanned.replaceAll("\\", "/");
      if (file.includes("node_modules/") || file.endsWith(".d.ts")) {
        continue;
      }
      if (file !== SHARED_MODULE) {
        files.push(file);
      }
    }
  }
  return files.sort();
}

test("the detector recognises signed 32-bit bounds written out by hand", () => {
  expect(
    declaresInt32Range("z.number().int().min(-0x80000000).max(0x7fffffff)"),
  ).toBe(true);
  expect(
    declaresInt32Range("z.number().int().max(2_147_483_647).optional()"),
  ).toBe(true);
  expect(
    declaresInt32Range("z.number().int().min(INT32_MIN).max(INT32_MAX)"),
  ).toBe(true);
  expect(declaresInt32Range("z.number().int().max(\n  INT32_MAX,\n)")).toBe(
    true,
  );
  expect(
    declaresInt32Range("z.number().int().min(-0x80000000).max(0xffffffff)"),
  ).toBe(false);
  expect(declaresInt32Range("z.number().int().min(0).max(65_535)")).toBe(false);
});

test("number schemas reuse int32Schema instead of spelling the 32-bit range", async () => {
  const offenders: string[] = [];
  for (const file of await sourceFiles()) {
    const source = await Bun.file(resolve(repository, file)).text();
    if (declaresInt32Range(source)) {
      offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});

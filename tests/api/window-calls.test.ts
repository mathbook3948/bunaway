import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { windowDefinitions } from "#plugins/windows/src/contract";

/** Every operation without data takes no request and every all-optional one may omit it. */
test("each null or all-optional window operation has a call helper that fills its request", async () => {
  const source = await Bun.file(
    resolve(import.meta.dir, "../../plugins/windows/src/calls.ts"),
  ).text();
  const flat = source.replace(/\s+/g, " ");
  const wrong: string[] = [];
  for (const [name, definition] of Object.entries(windowDefinitions)) {
    const input = definition.input;
    let filler = "input";
    if (input.safeParse(null).success) {
      filler = "null";
    } else if (!input.safeParse({}).success) {
      continue;
    }
    const helper = new RegExp(
      String.raw`(^| )${name}: \([^)]*\) => api\.${name}\(${filler}, options\),`,
    );
    if (!helper.test(flat)) {
      wrong.push(name);
    }
  }
  expect(wrong).toEqual([]);
});

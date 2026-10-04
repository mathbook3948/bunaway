import { expect, test } from "bun:test";
import { validateValue } from "../../packages/protocol/src/index.ts";
import { validationCases } from "./validation-cases.ts";

test("combined keywords, JSON equality and Unicode lengths match the shared cases", () => {
  for (const { name, schema, value, accepted } of validationCases) {
    if (accepted) expect(validateValue(schema, value), name).toEqual(value);
    else expect(() => validateValue(schema, value), name).toThrow();
  }
});

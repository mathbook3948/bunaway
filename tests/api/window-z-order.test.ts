import { expect, test } from "bun:test";
import {
  validateWindowCall,
  validateWindowOutput,
  windowOperations,
} from "@bunaway/plugin-windows";

for (const name of [
  "moveTop",
  "moveToBottom",
] as const) {
  const operation = `windows.${name}` as const;

  test(`${name} takes only a window target and returns null`, () => {
    expect(windowOperations[operation]).toBeDefined();
    expect(
      validateWindowCall({
        operation,
        payload: {
          view: "main",
        },
      }),
    ).toMatchObject({
      operation,
    });
    expect(() =>
      validateWindowCall({
        operation,
        payload: {
          view: "main",
          extra: true,
        },
      } as never),
    ).toThrow();
    expect(validateWindowOutput(operation, null)).toBeNull();
    expect(() => validateWindowOutput(operation, true)).toThrow();
  });
}

import { expect, test } from "bun:test";
import {
  editCommandEvaluateParameters,
  interpretEditCommandResult,
} from "#native/windows/bun/webview-edit-command";

const reply = (value: unknown) =>
  JSON.stringify({
    result: {
      type: "object",
      value,
    },
  });

test("each role runs its execCommand name from a user gesture without key events", () => {
  for (const role of [
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "selectAll",
  ] as const) {
    const parameters = editCommandEvaluateParameters(role) as {
      expression: string;
      userGesture: boolean;
      returnByValue: boolean;
    };
    expect(parameters.userGesture).toBe(true);
    expect(parameters.returnByValue).toBe(true);
    expect(parameters.expression).toContain(`execCommand("${role}")`);
    expect(parameters.expression).not.toContain("dispatchEvent");
    expect(parameters.expression).not.toContain("KeyboardEvent");
  }
});

test("replies are classified without throwing", () => {
  expect(
    interpretEditCommandResult(
      0,
      reply({
        outcome: "executed",
        focused: true,
      }),
    ),
  ).toMatchObject({
    kind: "executed",
  });
  expect(
    interpretEditCommandResult(
      0,
      reply({
        outcome: "cross-origin-frame",
        focused: false,
      }),
    ),
  ).toMatchObject({
    kind: "skipped",
    reason: "cross-origin-frame",
  });
  expect(
    interpretEditCommandResult(
      0,
      reply({
        outcome: "refused",
        focused: false,
      }),
    ),
  ).toEqual({
    kind: "failed",
    reason: "execCommand-refused (focused: false)",
  });
  expect(interpretEditCommandResult(-2147467259, "")).toEqual({
    kind: "failed",
    reason: "0x80004005",
  });
  expect(
    interpretEditCommandResult(
      0,
      JSON.stringify({
        exceptionDetails: {},
      }),
    ),
  ).toEqual({
    kind: "failed",
    reason: "script-exception",
  });
  for (const json of [
    "not json",
    "null",
    "{}",
    reply({
      outcome: "other",
      focused: true,
    }),
    reply({
      outcome: "executed",
    }),
  ]) {
    expect(interpretEditCommandResult(0, json)).toEqual({
      kind: "failed",
      reason: "invalid-result",
    });
  }
});

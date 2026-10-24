import { expect, test } from "bun:test";
import {
  isWindowRole,
  runWindowRole,
  type WindowRoleTargets,
} from "#native/windows/bun/menu-window-role";

function targets(throwing?: keyof WindowRoleTargets, minimizable = true) {
  const calls: string[] = [];
  const record =
    (name: keyof WindowRoleTargets) =>
    (...args: string[]) => {
      calls.push(args.length ? `${name}:${args[0]}` : name);
      if (throwing === name) {
        throw new Error(`${name} failed`);
      }
    };
  const value: WindowRoleTargets = {
    requestClose: record("requestClose"),
    minimizable: () => minimizable,
    minimize: record("minimize"),
    requestQuit: record("requestQuit"),
    failed: record("failed"),
    skipped: record("skipped"),
  };
  return {
    calls,
    value,
  };
}

test("each window role runs only its own target", () => {
  for (const [role, call] of [
    [
      "close",
      "requestClose",
    ],
    [
      "minimize",
      "minimize",
    ],
    [
      "quit",
      "requestQuit",
    ],
  ] as const) {
    const { calls, value } = targets();
    runWindowRole(role, value);
    expect(calls).toEqual([
      call,
    ]);
  }
});

test("a failing target is reported and not thrown", () => {
  for (const [role, name] of [
    [
      "close",
      "requestClose",
    ],
    [
      "minimize",
      "minimize",
    ],
    [
      "quit",
      "requestQuit",
    ],
  ] as const) {
    const { calls, value } = targets(name);
    runWindowRole(role, value);
    expect(calls).toEqual([
      name,
      `failed:${name} failed`,
    ]);
  }
});

test("minimize does nothing when the window is not minimizable", () => {
  const { calls, value } = targets(undefined, false);
  runWindowRole("minimize", value);
  expect(calls).toEqual([
    "skipped:not-minimizable",
  ]);
});

test("editing roles are not window roles", () => {
  expect(
    [
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "selectAll",
    ].some(isWindowRole),
  ).toBe(false);
  expect(
    [
      "close",
      "minimize",
      "quit",
    ].every(isWindowRole),
  ).toBe(true);
});

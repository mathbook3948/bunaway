import { expect, test } from "bun:test";
import os from "@bunaway/plugin-os";
import { NativeRegistry } from "@bunaway/protocol";
import { osOperations } from "#plugins/os/src/operations";

test("os.beep defaults to the default kind and rejects unknown input", () => {
  const { input } = osOperations.beep;
  expect(input.parse({})).toEqual({
    kind: "default",
  });
  for (const kind of [
    "default",
    "info",
    "warning",
    "error",
  ]) {
    expect(
      input.parse({
        kind,
      }),
    ).toEqual({
      kind,
    });
  }
  for (const value of [
    null,
    {
      kind: "question",
    },
    {
      kind: "info",
      frequency: 440,
    },
  ]) {
    expect(input.safeParse(value).success).toBe(false);
  }
  expect(osOperations.beep.output.parse(null)).toBeNull();
});

test("os.beep requires its own permission", () => {
  const registry = new NativeRegistry([
    os._definition,
  ]);
  const call = {
    operation: "os.beep",
    payload: {},
  };
  expect(
    registry.allowed(
      {
        permissions: [
          "os.beep",
        ],
      },
      call,
    ),
  ).toBe(true);
  for (const permissions of [
    [],
    [
      "os.info",
      "os.usage",
      "os.locale",
    ],
  ]) {
    expect(
      registry.allowed(
        {
          permissions,
        },
        call,
      ),
    ).toBe(false);
  }
});

import { expect, test } from "bun:test";
import { MAX_WINDOW_INSTANCES, MAX_WINDOWS } from "@bunaway/plugin-api/native";
import { validateWindowOutput } from "@bunaway/plugin-windows";
import { windowDefinitions } from "../../plugins/windows/src/contract.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("windows", windowDefinitions);

test("window catalog responses accept the definition limit and reject larger lists", async () => {
  const catalog = Array.from(
    {
      length: MAX_WINDOWS,
    },
    (_, index) => ({
      view: `view-${index}`,
      open: false,
    }),
  );
  for (const output of [
    [],
    catalog,
  ]) {
    expect(validateWindowOutput("windows.list", output)).toEqual(output);
    expect(await parsers.validateOutput("windows.list", output)).toEqual(
      output,
    );
  }
  const oversized = [
    ...catalog,
    {
      view: "extra",
      open: true,
    },
  ];
  expect(() => validateWindowOutput("windows.list", oversized)).toThrow();
  await expect(
    parsers.validateOutput("windows.list", oversized),
  ).rejects.toThrow();
});

test("child window responses accept the instance limit and reject larger lists", async () => {
  const children = Array.from(
    {
      length: MAX_WINDOW_INSTANCES,
    },
    (_, index) => ({
      windowId: `window-${index}`,
      viewId: "editor",
    }),
  );
  for (const output of [
    [],
    children,
  ]) {
    expect(validateWindowOutput("windows.getChildren", output)).toEqual(output);
    expect(await parsers.validateOutput("windows.getChildren", output)).toEqual(
      output,
    );
  }
  const oversized = [
    ...children,
    {
      windowId: "extra",
      viewId: "editor",
    },
  ];
  expect(() =>
    validateWindowOutput("windows.getChildren", oversized),
  ).toThrow();
  await expect(
    parsers.validateOutput("windows.getChildren", oversized),
  ).rejects.toThrow();
});

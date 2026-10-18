import { expect, test } from "bun:test";
import opener from "@bunaway/plugin-opener";
import { NativeRegistry } from "@bunaway/protocol";
import {
  urlHandlerSchema,
  validateOpenerInput,
} from "#plugins/opener/src/contract";
import { windowsOperations } from "#plugins/opener/src/operations";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("opener", windowsOperations);
const registry = new NativeRegistry([
  opener._definition,
]);

test("getUrlHandler reuses the openUrl input rules", () => {
  expect(
    validateOpenerInput("opener.getUrlHandler", {
      url: "https://example.com/a b",
    }),
  ).toEqual({
    url: "https://example.com/a b",
  });
  for (const input of [
    {},
    {
      url: "https://example.com/",
      extra: 1,
    },
    {
      url: 1,
    },
    {
      url: "x".repeat(8193),
    },
  ]) {
    expect(() => validateOpenerInput("opener.getUrlHandler", input)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});

test("getUrlHandler result is a strict name and path object or null", () => {
  const output = windowsOperations.getUrlHandler.output;
  expect(
    output.parse({
      name: "Browser",
      path: "C:\\Browser\\browser.exe",
    }),
  ).toEqual({
    name: "Browser",
    path: "C:\\Browser\\browser.exe",
  });
  expect(output.parse(null)).toBeNull();
  expect(
    urlHandlerSchema.safeParse({
      name: "",
      path: "C:\\a.exe",
    }).success,
  ).toBe(false);
  expect(
    urlHandlerSchema.safeParse({
      name: "Browser",
      path: "C:\\a.exe",
      icon: "data",
    }).success,
  ).toBe(false);
});

test("getUrlHandler has its own permission separate from openUrl", async () => {
  const call = await parsers.validateCall({
    operation: "opener.getUrlHandler",
    payload: {
      url: "https://example.com/",
    },
  });
  const granted = {
    permissions: [
      "opener.getUrlHandler",
    ],
  };
  expect(registry.allowed(granted, call)).toBe(true);
  expect(
    registry.allowed(
      {
        permissions: [
          "opener.openUrl",
        ],
      },
      call,
    ),
  ).toBe(false);
  const openCall = await parsers.validateCall({
    operation: "opener.openUrl",
    payload: {
      url: "https://example.com/",
    },
  });
  expect(registry.allowed(granted, openCall)).toBe(false);
});

import { expect, test } from "bun:test";
import opener from "@bunaway/plugin-opener";
import { NativeRegistry, type Policy } from "@bunaway/protocol";
import { validateOpenerInput } from "#plugins/opener/src/contract";
import { windowsOperations } from "#plugins/opener/src/operations";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const emptyPolicy: Policy = {
  version: 1,
  views: [],
  backend: {
    permissions: [],
  },
};
const parsers = pluginParsers("opener", windowsOperations);
const registry = new NativeRegistry([
  opener._definition,
]);

test("recent document operations validate strict inputs", () => {
  expect(
    validateOpenerInput("opener.addRecentDocument", {
      path: "C:\\docs\\report.txt",
    }),
  ).toEqual({
    path: "C:\\docs\\report.txt",
  });
  expect(validateOpenerInput("opener.clearRecentDocuments", {})).toEqual({});
  for (const [name, input] of [
    [
      "opener.addRecentDocument",
      {},
    ],
    [
      "opener.addRecentDocument",
      {
        path: "C:\\a.txt",
        extra: 1,
      },
    ],
    [
      "opener.clearRecentDocuments",
      {
        path: "C:\\a.txt",
      },
    ],
  ] as const) {
    expect(() => validateOpenerInput(name, input)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});

test("recent document grants authorize only the named operation", async () => {
  for (const [action, payload] of [
    [
      "addRecentDocument",
      {
        path: "C:/docs/report.txt",
      },
    ],
    [
      "clearRecentDocuments",
      {},
    ],
  ] as const) {
    const source = {
      permissions: [
        `opener.${action}`,
      ],
    };
    registry.validatePolicy({
      ...emptyPolicy,
      backend: source,
    });
    const call = await parsers.validateCall({
      operation: `opener.${action}`,
      payload,
    });
    expect(registry.allowed(source, call)).toBe(true);
    expect(
      registry.allowed(
        {
          permissions: [
            "opener.openFile",
          ],
        },
        call,
      ),
    ).toBe(false);
  }
});

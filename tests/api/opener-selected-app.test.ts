import { expect, test } from "bun:test";
import type { CommandContext } from "@bunaway/plugin-api";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import opener from "@bunaway/plugin-opener";
import {
  type HostCall,
  type HostContext,
  NativeRegistry,
} from "@bunaway/protocol";
import { bindHostAPI } from "#core/host-api";
import { windowsOperations as openerOperations } from "#plugins/opener/src/operations";
import { normalizeApplicationPath } from "#plugins/opener/src/path";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("opener", openerOperations);
const registry = new NativeRegistry([
  opener._definition,
]);

test("selected applications require absolute native executable paths", () => {
  expect(normalizeApplicationPath("c:/한글 앱/editor.EXE")).toBe(
    "C:\\한글 앱\\editor.EXE",
  );
  for (const app of [
    "editor.exe",
    "C:/editor.cmd",
    "C:/editor.lnk",
    "C:/editor.exe --flag",
    "C:/editor.exe\0",
    "C:/editor.exe.",
  ]) {
    expect(() => normalizeApplicationPath(app)).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  }
});

test("selected-app operations have independent permissions and strict Zod contracts", async () => {
  for (const [operation, payload] of [
    [
      "opener.openFileWith",
      {
        path: "C:/report.txt",
        app: "C:/editor.exe",
      },
    ],
    [
      "opener.openUrlWith",
      {
        url: "https://example.com/",
        app: "C:/browser.exe",
      },
    ],
  ] as const) {
    const call = await parsers.validateCall({
      operation,
      payload,
    });
    expect(
      registry.allowed(
        {
          permissions: [
            operation,
          ],
        },
        call,
      ),
    ).toBe(true);
    for (const permission of [
      "opener.openUrl",
      "opener.openFile",
      "opener.revealFile",
      operation === "opener.openFileWith"
        ? "opener.openUrlWith"
        : "opener.openFileWith",
    ]) {
      expect(
        registry.allowed(
          {
            permissions: [
              permission,
            ],
          },
          call,
        ),
      ).toBe(false);
    }
    await expect(
      parsers.validateCall({
        operation,
        payload: {
          ...payload,
          args: [
            "--extra",
          ],
        },
      }),
    ).rejects.toThrow();
    await expect(
      parsers.validateCall({
        operation,
        payload: {
          ...payload,
          app: 42,
        },
      }),
    ).rejects.toThrow();
    await expect(
      parsers.validateCall({
        operation,
        payload:
          operation === "opener.openFileWith"
            ? {
                path: "C:/report.txt",
              }
            : {
                url: "https://example.com/",
              },
      }),
    ).rejects.toThrow();
    await expect(parsers.validateOutput(operation, true)).rejects.toThrow();
  }
});

test("selected-app helpers normalize one target and preserve context, permission and OS errors", async () => {
  const calls: HostCall[] = [];
  const controller = new AbortController();
  let failure: "PERMISSION_DENIED" | "INTERNAL" | undefined;
  const host = bindHostAPI(
    "selected-app-context" as HostContext,
    controller.signal,
    async (context, call) => {
      expect(context).toBe("selected-app-context" as HostContext);
      calls.push(call);
      return failure
        ? {
            kind: "error",
            error: {
              code: failure,
              message: "Selected application failed.",
            },
          }
        : {
            kind: "result",
            payload: null,
          };
    },
    registry,
  );
  const command = bindCommandHost({
    input: {
      const: null,
    },
    output: {
      const: null,
    },
    run: async (_input: unknown, _context: CommandContext) => {
      expect(
        await opener.openFileWith(
          "c:/한글 폴더/공백 값.txt",
          "c:/앱/editor.exe",
        ),
      ).toBeNull();
      expect(
        await opener.openUrlWith(
          'https://example.com/경로?q=공백 값#"',
          "c:/앱/browser.exe",
        ),
      ).toBeNull();
      await expect(
        opener.openFileWith("C:/report.txt", "C:/editor.cmd"),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(
        opener.openUrlWith("custom://example.com/", "C:/browser.exe"),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      failure = "PERMISSION_DENIED";
      await expect(
        opener.openFileWith("C:/report.txt", "C:/editor.exe"),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      failure = "INTERNAL";
      await expect(
        opener.openUrlWith("https://example.com/", "C:/browser.exe"),
      ).rejects.toMatchObject({
        code: "INTERNAL",
      });
      return null;
    },
  });
  await command.run(null, {
    signal: controller.signal,
    host,
    state: {
      get: () => undefined,
      set() {},
      delete: () => false,
    },
    events: {
      async emit() {},
    },
  });
  expect(calls).toEqual([
    {
      operation: "opener.openFileWith",
      payload: {
        path: "C:\\한글 폴더\\공백 값.txt",
        app: "C:\\앱\\editor.exe",
      },
    },
    {
      operation: "opener.openUrlWith",
      payload: {
        url: new URL('https://example.com/경로?q=공백 값#"').href,
        app: "C:\\앱\\browser.exe",
      },
    },
    {
      operation: "opener.openFileWith",
      payload: {
        path: "C:\\report.txt",
        app: "C:\\editor.exe",
      },
    },
    {
      operation: "opener.openUrlWith",
      payload: {
        url: "https://example.com/",
        app: "C:\\browser.exe",
      },
    },
  ]);
});

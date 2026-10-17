import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import clipboard from "@bunaway/plugin-clipboard";
import {
  type HostContext,
  NativeRegistry,
  serializeHostResponse,
} from "@bunaway/protocol";
import { installedPlugins } from "#cli/plugins";
import { bindHostAPI } from "#core/host-api";
import { MAX_TEXT_LENGTH } from "#plugins/clipboard/src/contract";
import {
  windowsOperations as clipboardOperations,
  macosOperations,
} from "#plugins/clipboard/src/operations";
import { testAppInfo } from "../fixtures/app-info.ts";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("clipboard", clipboardOperations);
const registry = new NativeRegistry([
  clipboard._definition,
]);
test("clipboard has separate read, write and clear permissions with strict Unicode contracts", async () => {
  expect([
    ...registry.operations.keys(),
  ]).toEqual([
    "clipboard.readText",
    "clipboard.writeText",
    "clipboard.clear",
    "clipboard.readImage",
    "clipboard.writeImage",
    "clipboard.getFormats",
    "clipboard.hasFormat",
    "clipboard.readFormats",
    "clipboard.writeFormats",
    "clipboard.waitForChange",
  ]);
  for (const text of [
    "",
    "한글 😀\n\r\n",
    "😀".repeat(MAX_TEXT_LENGTH),
  ]) {
    expect(
      (
        await parsers.validateCall({
          operation: "clipboard.writeText",
          payload: {
            text,
          },
        })
      ).payload,
    ).toEqual({
      text,
    });
    expect(await parsers.validateOutput("clipboard.readText", text)).toBe(text);
    // Even the most expensive allowed JSON escaping fits the shared transport.
    serializeHostResponse({
      kind: "result",
      payload: text,
    });
  }
  serializeHostResponse({
    kind: "result",
    payload: "\u0001".repeat(MAX_TEXT_LENGTH),
  });
  expect(await parsers.validateOutput("clipboard.readText", null)).toBeNull();
  for (const payload of [
    {
      text: "a\0b",
    },
    {
      text: "\ud800",
    },
    {
      text: "\udfff",
    },
    {
      text: "x".repeat(MAX_TEXT_LENGTH + 1),
    },
    {
      text: "ok",
      extra: 1,
    },
    {
      text: 12,
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "clipboard.writeText",
        payload,
      }),
    ).rejects.toThrow();
  }
  for (const operation of [
    "clipboard.readText",
    "clipboard.clear",
  ]) {
    await expect(
      parsers.validateCall({
        operation,
        payload: {},
      }),
    ).rejects.toThrow();
  }
  expect(() =>
    new NativeRegistry([]).operation("clipboard.readText"),
  ).toThrow();
});
test("clipboard grants only the requested operation", () => {
  for (const operation of registry.operations.values()) {
    const call = {
      operation: operation.name,
      payload: operation.name.endsWith("writeText")
        ? {
            text: "ok",
          }
        : null,
    };
    expect(
      registry.allowed(
        {
          permissions: [
            operation.name,
          ],
        },
        call,
      ),
    ).toBe(true);
    expect(
      registry.allowed(
        {
          permissions: [],
        },
        call,
      ),
    ).toBe(false);
    for (const other of registry.operations.keys()) {
      if (other !== operation.name) {
        expect(
          registry.allowed(
            {
              permissions: [
                other,
              ],
            },
            call,
          ),
        ).toBe(false);
      }
    }
  }
  expect(() =>
    registry.validatePolicy({
      version: 1,
      views: [],
      backend: {
        permissions: [
          "clipboard.readText",
        ],
      },
    }),
  ).not.toThrow();
});
test("clipboard public functions reuse the active command host and validate at the owning adapter", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const contextId = "clipboard-context" as HostContext;
  const host = bindHostAPI(
    contextId,
    controller.signal,
    async (context, call) => {
      expect(context).toBe(contextId);
      await parsers.validateCall(call);
      calls.push(call.operation);
      return {
        kind: "result",
        payload: call.operation === "clipboard.readText" ? "한글 😀" : null,
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
    async run(
      _input: unknown,
      _context: import("@bunaway/plugin-api").CommandContext,
    ) {
      expect(await clipboard.readText(null)).toBe("한글 😀");
      await clipboard.writeText({
        text: "한글 😀",
      });
      await clipboard.clear(null);
      await expect(
        clipboard.writeText({
          text: "bad\0text",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      return null;
    },
  });
  await command.run(null, {
    app: testAppInfo,
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
    "clipboard.readText",
    "clipboard.writeText",
    "clipboard.clear",
  ]);
});
test("clipboard is independently discoverable as a Windows and macOS UI plugin", async () => {
  const plugins = await installedPlugins(
    resolve(import.meta.dir, "../.."),
    "0.0.0",
  );
  const plugin = plugins.find(({ name }) => name === "clipboard");
  expect(plugin?.packageName).toBe("@bunaway/plugin-clipboard");
  expect(plugin?.targets.windows?.thread).toBe("ui");
  expect(plugin?.targets.macos?.thread).toBe("ui");
  expect(plugin?.targets.macos?.supportedOperations).toEqual(
    Object.keys(macosOperations).map((name) => `clipboard.${name}`),
  );
  const result = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../../plugins/clipboard/dist/index.js"),
    ],
    target: "browser",
  });
  expect(result.success).toBe(true);
  const source = await result.outputs[0]?.text();
  expect(source).not.toContain("user32.dll");
  expect(source).not.toContain("AppKit.framework");
  expect(source).not.toContain("libobjc.A.dylib");
  expect(source).not.toContain("node:async_hooks");
}, 20000);

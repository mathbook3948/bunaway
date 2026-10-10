import { expect, test } from "bun:test";
import { bindHostAPI } from "#core/host-api";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import { clipboard, clipboardPlugin } from "@bunaway/plugin-clipboard";
import { s } from "@bunaway/plugin";
import {
  type HostContext,
  NativeRegistry,
  serializeHostResponse,
} from "@bunaway/protocol";
import { MAX_TEXT_LENGTH } from "#plugins/clipboard/src/text";
import { installedPlugins } from "#cli/plugins";
import { resolve } from "node:path";

const registry = new NativeRegistry([
  clipboardPlugin,
]);
test("clipboard has separate read, write and clear permissions with strict Unicode contracts", () => {
  expect([
    ...registry.permissions.keys(),
  ]).toEqual([
    "clipboard:read-text",
    "clipboard:write-text",
    "clipboard:clear",
  ]);
  for (const text of [
    "",
    "한글 😀\n\r\n",
    "😀".repeat(MAX_TEXT_LENGTH),
  ]) {
    expect(
      registry.validateCall({
        operation: "clipboard.writeText",
        payload: {
          text,
        },
      }).payload,
    ).toEqual({
      text,
    });
    expect(registry.validateOutput("clipboard.readText", text)).toBe(text);
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
  expect(registry.validateOutput("clipboard.readText", null)).toBeNull();
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
    expect(() =>
      registry.validateCall({
        operation: "clipboard.writeText",
        payload,
      }),
    ).toThrow();
  }
  for (const operation of [
    "clipboard.readText",
    "clipboard.clear",
  ]) {
    expect(() =>
      registry.validateCall({
        operation,
        payload: {},
      }),
    ).toThrow();
  }
  expect(() =>
    new NativeRegistry([]).operation("clipboard.readText"),
  ).toThrow();
});

test("clipboard grants only the requested operation and rejects scopes", () => {
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
            operation.permission,
          ],
        },
        call,
        () => false,
      ),
    ).toBe(true);
    expect(
      registry.allowed(
        {
          permissions: [],
        },
        call,
        () => false,
      ),
    ).toBe(false);
    for (const other of registry.permissions.keys()) {
      if (other !== operation.permission) {
        expect(
          registry.allowed(
            {
              permissions: [
                other,
              ],
            },
            call,
            () => false,
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
          {
            identifier: "clipboard:read-text",
            allow: [
              {},
            ],
          },
        ],
      },
    }),
  ).toThrow();
});

test("clipboard public functions reuse the active command host and validate before dispatch", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const contextId = "clipboard-context" as HostContext;
  const host = bindHostAPI(
    contextId,
    controller.signal,
    async (context, call) => {
      expect(context).toBe(contextId);
      calls.push(call.operation);
      return {
        kind: "result",
        payload: call.operation === "clipboard.readText" ? "한글 😀" : null,
      };
    },
    registry,
  );
  const command = bindCommandHost({
    input: s.null(),
    output: s.null(),
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

test("clipboard is independently discoverable as a Windows UI plugin", async () => {
  const plugins = await installedPlugins(
    resolve(import.meta.dir, "../.."),
    "0.0.0",
  );
  const plugin = plugins.find(({ name }) => name === "clipboard");
  expect(plugin?.packageName).toBe("@bunaway/plugin-clipboard");
  expect(plugin?.targets.windows?.execution).toBe("ui");
  expect(plugin?.targets.macos).toBeUndefined();
  const result = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../../plugins/clipboard/src/index.ts"),
    ],
    target: "browser",
  });
  expect(result.success).toBe(true);
  const source = await result.outputs[0]?.text();
  expect(source).not.toContain("user32.dll");
  expect(source).not.toContain("node:async_hooks");
}, 20_000);

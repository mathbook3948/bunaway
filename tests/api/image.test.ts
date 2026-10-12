import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { bindCommandHost } from "@bunaway/plugin-api/host";
import { image, imagePlugin } from "@bunaway/plugin-image";
import {
  type HostContext,
  NativeRegistry,
  serializeHostResponse,
} from "@bunaway/protocol";
import { installedPlugins } from "#cli/plugins";
import { bindHostAPI } from "#core/host-api";
import {
  imageOperations,
  MAX_ENCODED_BYTES,
  MAX_IMAGE_BYTES,
  validateImageInput,
} from "#plugins/image/src/contract";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("image", imageOperations);
const registry = new NativeRegistry([
  imagePlugin,
]);
const pixels = {
  width: 1,
  height: 1,
  rgba: "AQIDBA==",
};
const id = crypto.randomUUID();
test("image creation contracts enforce dimensions, canonical base64, data URL MIME and strict objects", async () => {
  for (const input of [
    {
      ...pixels,
      width: 2,
    },
    {
      ...pixels,
      height: 0,
    },
    {
      ...pixels,
      rgba: "AQIDBB==",
    },
    {
      ...pixels,
      width: -1,
    },
    {
      ...pixels,
      height: 1.5,
    },
    {
      ...pixels,
      extra: true,
    },
    {
      width: 4096,
      height: 4096,
      rgba: "",
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "image.createRGBA",
        payload: input,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(
    validateImageInput("image.createRGBA", {
      width: 0,
      height: 0,
      rgba: "",
    }),
  ).toEqual({
    width: 0,
    height: 0,
    rgba: "",
  });
  expect(() => validateImageInput("other.createRGBA", pixels)).toThrow(
    expect.objectContaining({
      code: "UNSUPPORTED",
    }),
  );
  expect(() => validateImageInput("image.constructor", null)).toThrow(
    expect.objectContaining({
      code: "UNSUPPORTED",
    }),
  );
  for (const url of [
    "data:image/png;base64,AB==",
    "data:image/png;base64,====",
    "data:image/gif;base64,AA==",
    "https://example.com/a.png",
    "data:image/png;base64,",
  ]) {
    await expect(
      parsers.validateCall({
        operation: "image.createDataURL",
        payload: {
          url,
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(
    validateImageInput("image.createDataURL", {
      url: "data:image/png;base64,AA==",
    }),
  ).toEqual({
    url: "data:image/png;base64,AA==",
  });
  const maximum = {
    width: 512,
    height: 256,
    rgba: Buffer.alloc(MAX_IMAGE_BYTES).toString("base64"),
  };
  await parsers.validateCall({
    operation: "image.createRGBA",
    payload: maximum,
  });
  serializeHostResponse({
    kind: "result",
    payload: maximum,
  });
  serializeHostResponse({
    kind: "result",
    payload: {
      mime: "image/png",
      data: Buffer.alloc(MAX_ENCODED_BYTES).toString("base64"),
    },
  });
});

test("image permissions are independent and resource outputs are validated at the adapter", async () => {
  expect([
    ...registry.operations.keys(),
  ]).toEqual(Object.keys(imageOperations).map((name) => `image.${name}`));
  for (const operation of registry.operations.keys()) {
    const call = {
      operation,
      payload: null,
    };
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
    for (const other of registry.operations.keys()) {
      if (operation !== other) {
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
  expect(
    await parsers.validateOutput("image.createRGBA", {
      id,
      width: 1,
      height: 1,
      empty: false,
    }),
  ).toEqual({
    id,
    width: 1,
    height: 1,
    empty: false,
  });
  await expect(
    parsers.validateOutput("image.getInfo", {
      width: 0,
      height: 1,
      empty: false,
    }),
  ).rejects.toMatchObject({
    code: "INTERNAL",
  });
  await expect(
    parsers.validateOutput("image.getPixels", {
      ...pixels,
      rgba: "AQIDBB==",
    }),
  ).rejects.toMatchObject({
    code: "INTERNAL",
  });
  await expect(
    parsers.validateOutput("image.exportBytes", {
      mime: "image/gif",
      data: "AA==",
    }),
  ).rejects.toMatchObject({
    code: "INTERNAL",
  });
});

test("image public SDK helpers preserve host scope and resource IDs", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const contextId = "image-api" as HostContext;
  const host = bindHostAPI(
    contextId,
    controller.signal,
    async (_context, call) => {
      await parsers.validateCall(call);
      calls.push(call.operation);
      return {
        kind: "result",
        payload:
          call.operation === "image.createRGBA"
            ? {
                id,
                width: 1,
                height: 1,
                empty: false,
              }
            : true,
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
      const resource = await image.createRGBA(pixels);
      expect(resource.id).toBe(id);
      expect(
        await image.dispose({
          id: resource.id,
        }),
      ).toBe(true);
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
    "image.createRGBA",
    "image.dispose",
  ]);
});

test("image is independently discoverable and browser declaration excludes WIC resources", async () => {
  const plugins = await installedPlugins(
    resolve(import.meta.dir, "../.."),
    "0.0.0",
  );
  const plugin = plugins.find((item) => item.name === "image");
  expect(plugin?.packageName).toBe("@bunaway/plugin-image");
  expect(plugin?.targets.windows?.execution).toBe("ui");
  const result = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../../plugins/image/dist/index.js"),
    ],
    target: "browser",
  });
  expect(result.success).toBe(true);
  expect(await result.outputs[0]?.text()).not.toContain("ole32.dll");
});

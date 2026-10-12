import { expect, test } from "bun:test";
import { serializeHostResponse } from "@bunaway/protocol";
import {
  clipboardOperations,
  validateClipboardInput,
} from "#plugins/clipboard/src/contract";
import {
  imageSchema,
  MAX_IMAGE_BYTES,
  writeFormatsSchema,
} from "#plugins/clipboard/src/formats";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("clipboard", clipboardOperations);
const image = {
  width: 1,
  height: 1,
  rgba: "AQIDBA==",
};

test("clipboard format contracts reject ambiguous, malformed and oversized inputs at the owning adapter", async () => {
  for (const input of [
    {
      items: [],
    },
    {
      items: [
        {
          format: "text/plain",
          data: "a",
        },
        {
          format: "text/plain",
          data: "b",
        },
      ],
    },
    {
      items: [
        {
          format: "text/html",
          data: "bad\0fragment",
        },
      ],
    },
    {
      items: [
        {
          format: "application/x-bunaway-file-list",
          data: [
            "relative.txt",
          ],
        },
      ],
    },
    {
      items: [
        {
          format: "application/x-bunaway-file-list",
          data: [
            "\\\\.\\pipe\\secret",
          ],
        },
      ],
    },
    {
      items: [
        {
          format: "application/x-bunaway-file-list",
          data: [
            "\\\\bad\nserver\\share\\file",
          ],
        },
      ],
    },
    {
      items: [
        {
          format: "text/rtf",
          data: "{\\rtf1 한글}",
        },
      ],
    },
    {
      items: [
        {
          format: "text/rtf",
          data: "plain",
        },
      ],
    },
    {
      items: [
        {
          format: "application/octet-stream",
          data: "AA==",
        },
      ],
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "clipboard.writeFormats",
        payload: input,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  for (const input of [
    {
      ...image,
      rgba: "AQIDBB==",
    }, // Nonzero unused base64 padding bits.
    {
      ...image,
      rgba: "AQID",
    },
    {
      ...image,
      width: 2,
    },
    {
      ...image,
      height: 0,
    },
    {
      ...image,
      height: 1.5,
    },
    {
      ...image,
      extra: 1,
    },
    {
      width: 4096,
      height: 4096,
      rgba: "",
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "clipboard.writeImage",
        payload: input,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  }
  expect(validateClipboardInput("clipboard.writeImage", image)).toEqual(image);
  expect(() =>
    validateClipboardInput("clipboard.hasFormat", {
      format: "unknown",
    }),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  await expect(
    parsers.validateCall({
      operation: "clipboard.readFormats",
      payload: {
        formats: [
          "text/html",
          "text/html",
        ],
      },
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
});

test("maximum RGBA image fits the protocol and combined formats have an explicit envelope budget", () => {
  const maximum = {
    width: 512,
    height: 256,
    rgba: Buffer.alloc(MAX_IMAGE_BYTES, 255).toString("base64"),
  };
  expect(imageSchema.parse(maximum)).toEqual(maximum);
  serializeHostResponse({
    kind: "result",
    payload: maximum,
  });
  const items = [
    {
      format: "image/bmp",
      data: maximum,
    },
    {
      format: "text/plain",
      data: "\u0001".repeat(16_384),
    },
    {
      format: "text/html",
      data: "\u0001".repeat(16_384),
    },
    {
      format: "text/rtf",
      data: `{\\rtf1 ${"\u0001".repeat(16_376)}}`,
    },
  ];
  expect(() =>
    writeFormatsSchema.parse({
      items,
    }),
  ).toThrow();
});

test("clipboard results preserve format tags, missing data and strict image boundaries", async () => {
  const results = [
    {
      format: "image/bmp",
      data: image,
    },
    {
      format: "text/html",
      data: "<p>한글 😀</p>",
    },
    {
      format: "application/x-bunaway-file-list",
      data: [
        "C:\\한글\\memo.txt",
        "\\\\server\\share\\memo.txt",
      ],
    },
    {
      format: "text/rtf",
      data: null,
    },
  ];
  expect(
    await parsers.validateOutput("clipboard.readFormats", results),
  ).toEqual(results);
  expect(await parsers.validateOutput("clipboard.readImage", null)).toBeNull();
  await expect(
    parsers.validateOutput("clipboard.readFormats", [
      {
        format: "text/html",
        data: image,
      },
    ]),
  ).rejects.toMatchObject({
    code: "INTERNAL",
  });
});

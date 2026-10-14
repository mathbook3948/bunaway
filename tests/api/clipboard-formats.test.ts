import { expect, test } from "bun:test";
import { serializeHostResponse } from "@bunaway/protocol";
import {
  imageSchema,
  MAX_BINARY_BYTES,
  MAX_BOOKMARK_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_PATH_LENGTH,
  validateClipboardInput,
  writeFormatsSchema,
} from "#plugins/clipboard/src/contract";
import { windowsOperations as clipboardOperations } from "#plugins/clipboard/src/operations";
import {
  decodeFiles,
  encodeFiles,
} from "#plugins/clipboard/src/platforms/windows-codecs";
import { pluginParsers } from "../fixtures/plugin-parsers.ts";

const parsers = pluginParsers("clipboard", clipboardOperations);
const image = {
  width: 1,
  height: 1,
  rgba: "AQIDBA==",
};

test("file-list contracts round-trip Unicode paths at the UTF-16 limit", async () => {
  for (const character of [
    "a",
    "😀",
  ]) {
    // Keep each component below Windows' limit while crossing the total path boundary.
    const prefix = `C:\\${Array.from(
      {
        length: 5,
      },
      () => character.repeat(200 / character.length),
    ).join("\\")}\\`;
    const path = prefix + "x".repeat(MAX_PATH_LENGTH - prefix.length);
    const items = [
      {
        format: "application/x-bunaway-file-list",
        data: [
          path,
        ],
      },
    ];
    expect(path.length).toBe(MAX_PATH_LENGTH);
    expect(
      (
        await parsers.validateCall({
          operation: "clipboard.writeFormats",
          payload: {
            items,
          },
        })
      ).payload,
    ).toEqual({
      items,
    });
    expect(
      decodeFiles(
        encodeFiles([
          path,
        ]),
      ),
    ).toEqual([
      path,
    ]);
    expect(
      await parsers.validateOutput("clipboard.readFormats", items),
    ).toEqual(items);

    const oversized = {
      items: [
        {
          format: "application/x-bunaway-file-list",
          data: [
            path + "x",
          ],
        },
      ],
    };
    await expect(
      parsers.validateCall({
        operation: "clipboard.writeFormats",
        payload: oversized,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(() =>
      validateClipboardInput("clipboard.writeFormats", oversized),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      decodeFiles(
        encodeFiles([
          path + "x",
        ]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INTERNAL",
      }),
    );
  }
});

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

test("bookmark and private binary contracts preserve bounded values without new operation grants", async () => {
  const binary = "application/x-bunaway-binary/memo.v1";
  expect(
    await parsers.validateOutput("clipboard.getFormats", [
      "text/plain",
      "text/html",
      "text/rtf",
      "application/x-bunaway-file-list",
      "image/bmp",
      "application/x-bunaway-bookmark",
    ]),
  ).toHaveLength(6);
  const longestName = `application/x-bunaway-binary/${"x".repeat(64)}`;
  expect(
    (
      await parsers.validateCall({
        operation: "clipboard.hasFormat",
        payload: {
          format: longestName,
        },
      })
    ).payload,
  ).toEqual({
    format: longestName,
  });
  for (const data of [
    "",
    "AA==",
    "AP+A/w==",
    Buffer.alloc(MAX_BINARY_BYTES, 255).toString("base64"),
  ]) {
    const items = [
      {
        format: binary,
        data,
      },
    ];
    expect(
      (
        await parsers.validateCall({
          operation: "clipboard.writeFormats",
          payload: {
            items,
          },
        })
      ).payload,
    ).toEqual({
      items,
    });
    expect(
      await parsers.validateOutput("clipboard.readFormats", items),
    ).toEqual(items);
    serializeHostResponse({
      kind: "result",
      payload: items,
    });
  }
  const url =
    "https://example.com/" +
    "x".repeat(MAX_BOOKMARK_LENGTH - "https://example.com/".length);
  const items = [
    {
      format: "application/x-bunaway-bookmark",
      data: {
        url,
      },
    },
    {
      format: binary,
      data: "AA==",
    },
  ];
  expect(
    (
      await parsers.validateCall({
        operation: "clipboard.writeFormats",
        payload: {
          items,
        },
      })
    ).payload,
  ).toEqual({
    items,
  });
  expect(await parsers.validateOutput("clipboard.readFormats", items)).toEqual(
    items,
  );
  expect(
    await parsers.validateOutput("clipboard.readFormats", [
      {
        format: binary,
        data: null,
      },
    ]),
  ).toEqual([
    {
      format: binary,
      data: null,
    },
  ]);
  for (const item of [
    {
      format: binary,
      data: "AB==",
    },
    {
      format: binary,
      data: "AAB=",
    },
    {
      format: binary,
      data: "AA",
    },
    {
      format: binary,
      data: "AA==\n",
    },
    {
      format: binary,
      data: Buffer.alloc(MAX_BINARY_BYTES + 1).toString("base64"),
    },
    {
      format: binary,
      data: [
        0,
      ],
    },
    {
      format: "application/x-bunaway-binary/",
      data: "",
    },
    {
      format: "application/x-bunaway-binary/HTML Format",
      data: "",
    },
    {
      format: "application/x-bunaway-binary/Memo",
      data: "",
    },
    {
      format: "application/x-bunaway-binary/memo/child",
      data: "",
    },
    {
      format: `application/x-bunaway-binary/${"x".repeat(65)}`,
      data: "",
    },
    {
      format: "application/x-bunaway-binary/memo\n",
      data: "",
    },
    ...[
      "",
      "javascript:alert(1)",
      "file:///C:/private",
      "https://",
      "https://example.com/\n",
      "https://example.com/\ud800",
      `${url}x`,
    ].map((url) => ({
      format: "application/x-bunaway-bookmark",
      data: {
        url,
      },
    })),
    {
      format: "application/x-bunaway-bookmark",
      data: {
        url,
        title: "unused",
      },
    },
  ]) {
    await expect(
      parsers.validateCall({
        operation: "clipboard.writeFormats",
        payload: {
          items: [
            item,
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      parsers.validateOutput("clipboard.readFormats", [
        item,
      ]),
    ).rejects.toThrow();
  }
  await expect(
    parsers.validateCall({
      operation: "clipboard.writeFormats",
      payload: {
        items: [
          {
            format: binary,
            data: "",
          },
          {
            format: binary,
            data: "AA==",
          },
        ],
      },
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  const oversized = Array.from(
    {
      length: 3,
    },
    (_, index) => ({
      format: `application/x-bunaway-binary/budget-${index}`,
      data: Buffer.alloc(MAX_BINARY_BYTES).toString("base64"),
    }),
  );
  await expect(
    parsers.validateCall({
      operation: "clipboard.writeFormats",
      payload: {
        items: oversized,
      },
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
  });
  await expect(
    parsers.validateOutput("clipboard.readFormats", oversized),
  ).rejects.toThrow();
});

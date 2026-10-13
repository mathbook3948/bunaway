import { expect, test } from "bun:test";
import type { JsonValue } from "@bunaway/protocol";
import type { ClipboardItem } from "#plugins/clipboard/src/formats";
import { MAX_IMAGE_BYTES } from "#plugins/clipboard/src/formats";
import type { Pasteboard } from "#plugins/clipboard/src/macos-pasteboard";
import {
  decodeTIFF,
  encodeTIFF,
  MAX_TIFF_BYTES,
} from "#plugins/clipboard/src/macos-tiff";
import { pasteboardOperations } from "#plugins/clipboard/src/platforms/macos";

const image = {
  width: 2,
  height: 2,
  rgba: Buffer.from([
    255,
    0,
    0,
    128,
    0,
    255,
    0,
    255,
    5,
    7,
    11,
    0,
    0,
    0,
    255,
    1,
  ]).toString("base64"),
};

test("TIFF preserves orientation, straight alpha and transparent RGB at the RGBA boundary", () => {
  expect(decodeTIFF(encodeTIFF(image))).toEqual(image);
  const maximum = {
    width: 512,
    height: 256,
    rgba: Buffer.alloc(MAX_IMAGE_BYTES, 17).toString("base64"),
  };
  expect(decodeTIFF(encodeTIFF(maximum))).toEqual(maximum);
  // Convert directory and SHORT array words, leaving byte-sized samples alone.
  const bigEndian = Buffer.from(encodeTIFF(image));
  bigEndian.write("MM");
  for (const [offset, size] of [
    [
      2,
      2,
    ],
    [
      4,
      4,
    ],
    [
      8,
      2,
    ],
    [
      154,
      4,
    ],
    [
      158,
      2,
    ],
    [
      160,
      2,
    ],
    [
      162,
      2,
    ],
    [
      164,
      2,
    ],
  ]) {
    if (offset === undefined || size === undefined) {
      throw new Error("Missing fixture word.");
    }
    if (size === 2) {
      bigEndian.writeUInt16BE(bigEndian.readUInt16LE(offset), offset);
    } else {
      bigEndian.writeUInt32BE(bigEndian.readUInt32LE(offset), offset);
    }
  }
  for (let index = 0; index < 12; index++) {
    const position = 10 + index * 12;
    const type = bigEndian.readUInt16LE(position + 2);
    const count = bigEndian.readUInt32LE(position + 4);
    bigEndian.writeUInt16BE(bigEndian.readUInt16LE(position), position);
    bigEndian.writeUInt16BE(type, position + 2);
    bigEndian.writeUInt32BE(count, position + 4);
    if (type === 3 && count === 1) {
      bigEndian.writeUInt16BE(
        bigEndian.readUInt16LE(position + 8),
        position + 8,
      );
    } else {
      bigEndian.writeUInt32BE(
        bigEndian.readUInt32LE(position + 8),
        position + 8,
      );
    }
  }
  expect(decodeTIFF(bigEndian)).toEqual(image);
});

test("TIFF refuses malformed, oversized, compressed, planar and multipage external data", () => {
  const changes: [
    number,
    number,
  ][] = [
    [
      4,
      0xffffffff,
    ],
    [
      154,
      8,
    ],
    [
      18,
      4097,
    ],
    [
      30,
      4097,
    ],
    [
      54,
      5,
    ],
    [
      90,
      2,
    ],
    [
      126,
      0xffffffff,
    ],
    [
      138,
      2,
    ],
    [
      150,
      1,
    ],
  ];
  for (const [offset, value] of changes) {
    const bytes = encodeTIFF(image);
    bytes.writeUInt32LE(value, offset);
    expect(() => decodeTIFF(bytes)).toThrow();
  }
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(MAX_TIFF_BYTES + 1),
    encodeTIFF(image).subarray(0, 160),
    encodeTIFF(image).subarray(0, 170),
  ]) {
    expect(() => decodeTIFF(bytes)).toThrow();
  }
});

test("macOS clipboard validates permission and cancellation before touching native state", () => {
  const calls: string[] = [];
  let items: ClipboardItem[] = [];
  const native: Pasteboard = {
    readMany(formats) {
      return formats.map((format) => native.read(format));
    },
    read(format) {
      calls.push("read");
      return (
        items.find((item) => item.format === format) ?? {
          format,
          data: null,
        }
      );
    },
    has(format) {
      calls.push("has");
      return items.some((item) => item.format === format);
    },
    write(value) {
      calls.push("write");
      items = value;
    },
    clear() {
      calls.push("clear");
      items = [];
    },
    dispose() {
      calls.push("dispose");
    },
  };
  const adapter = pasteboardOperations(native);
  const invoke = (
    operation: string,
    input: JsonValue,
    permissions = [
      operation,
    ],
    signal?: AbortSignal,
  ) =>
    adapter.executeUI?.(operation, input, "backend", {
      requestId: "fixture",
      permissions: {
        permissions,
      },
      ...(signal
        ? {
            signal,
          }
        : {}),
    });
  const deniedCalls: [
    string,
    JsonValue,
  ][] = [
    [
      "clipboard.writeText",
      {
        text: "denied",
      },
    ],
    [
      "clipboard.clear",
      null,
    ],
    [
      "clipboard.readText",
      null,
    ],
    [
      "clipboard.writeImage",
      image,
    ],
    [
      "clipboard.writeFormats",
      {
        items: [
          {
            format: "text/plain",
            data: "denied",
          },
        ],
      },
    ],
  ];
  for (const [operation, input] of deniedCalls) {
    expect(() => invoke(operation, input, [])).toThrow(
      expect.objectContaining({
        code: "PERMISSION_DENIED",
      }),
    );
  }
  expect(() =>
    invoke("clipboard.writeText", {
      text: "\ud800",
    }),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  expect(() =>
    invoke(
      "clipboard.clear",
      null,
      [
        "clipboard.clear",
      ],
      AbortSignal.abort(),
    ),
  ).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(calls).toEqual([]);
  expect(
    invoke("clipboard.writeText", {
      text: "한글 😀\r\n",
    }),
  ).toBeNull();
  expect(invoke("clipboard.readText", null)).toBe("한글 😀\r\n");
  expect(
    invoke("clipboard.readFormats", {
      formats: [
        "text/html",
        "text/plain",
      ],
    }),
  ).toEqual([
    {
      format: "text/html",
      data: null,
    },
    {
      format: "text/plain",
      data: "한글 😀\r\n",
    },
  ]);
  adapter.dispose();
  adapter.dispose();
  expect(calls.filter((call) => call === "dispose")).toHaveLength(1);
  expect(() => invoke("clipboard.clear", null)).toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
});

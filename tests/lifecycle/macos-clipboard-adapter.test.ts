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
import { pasteboardOperations } from "../fixtures/injected-native-plugins.ts";

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

test("TIFF accepts default or explicit unsigned samples and rejects other SampleFormat interpretations", () => {
  const pixel = {
    width: 1,
    height: 1,
    rgba: Buffer.from([
      255,
      128,
      0,
      255,
    ]).toString("base64"),
  };
  /** Keep the encoded strip but replace the last alpha tag with external RGB metadata. */
  const rgb = (sampleFormat?: number[]) => {
    const bytes = encodeTIFF(pixel);
    bytes.writeUInt32LE(3, 38); // BitsPerSample count.
    bytes.writeUInt32LE(3, 102); // SamplesPerPixel.
    bytes.writeUInt32LE(3, 126); // StripByteCounts.
    if (sampleFormat === undefined) {
      bytes.writeUInt16LE(11, 8); // Remove ExtraSamples from the IFD.
      bytes.writeUInt32LE(0, 142); // End the directory at the removed entry.
      return bytes;
    }
    const values = Buffer.alloc(sampleFormat.length * 2);
    for (const [index, value] of sampleFormat.entries()) {
      values.writeUInt16LE(value, index * 2);
    }
    const result = Buffer.concat([
      bytes,
      values,
    ]);
    result.writeUInt16LE(339, 142); // SampleFormat, SHORT.
    result.writeUInt32LE(sampleFormat.length, 146);
    if (sampleFormat.length <= 2) {
      result.fill(0, 150, 154);
      values.copy(result, 150);
    } else {
      result.writeUInt32LE(bytes.length, 150);
    }
    return result;
  };
  expect(decodeTIFF(rgb())).toEqual(pixel);
  expect(
    decodeTIFF(
      rgb([
        1,
        1,
        1,
      ]),
    ),
  ).toEqual(pixel);
  for (const sampleFormat of [
    [
      2,
      2,
      2,
    ],
    [
      1,
      2,
      1,
    ],
    [
      3,
      3,
      3,
    ],
    [
      4,
      4,
      4,
    ],
    [
      0,
      0,
      0,
    ],
    [],
    [
      1,
    ],
    [
      1,
      1,
    ],
    [
      1,
      1,
      1,
      1,
    ],
    [
      1,
      1,
      1,
      1,
      1,
    ],
  ]) {
    expect(() => decodeTIFF(rgb(sampleFormat))).toThrow(
      expect.objectContaining({
        code: "INTERNAL",
      }),
    );
  }

  // Append a correctly ordered thirteenth entry without losing the RGBA alpha tag.
  const encoded = encodeTIFF(pixel);
  const entryOffset = 154;
  const entryBytes = 12;
  const valuesOffset = encoded.length + entryBytes;
  const rgba = Buffer.alloc(valuesOffset + 8);
  encoded.copy(rgba, 0, 0, entryOffset);
  encoded.copy(rgba, entryOffset + entryBytes, entryOffset);
  rgba.writeUInt16LE(13, 8);
  rgba.writeUInt32LE(encoded.readUInt32LE(42) + entryBytes, 42); // BitsPerSample offset.
  rgba.writeUInt32LE(encoded.readUInt32LE(78) + entryBytes, 78); // StripOffsets.
  rgba.writeUInt16LE(339, entryOffset);
  rgba.writeUInt16LE(3, entryOffset + 2);
  rgba.writeUInt32LE(4, entryOffset + 4);
  rgba.writeUInt32LE(valuesOffset, entryOffset + 8);
  for (let sample = 0; sample < 4; sample++) {
    rgba.writeUInt16LE(1, valuesOffset + sample * 2);
  }
  expect(decodeTIFF(rgba)).toEqual(pixel);
  rgba.writeUInt16LE(2, valuesOffset + 6); // Signed alpha is unsupported too.
  expect(() => decodeTIFF(rgba)).toThrow(
    expect.objectContaining({
      code: "INTERNAL",
    }),
  );
});

test("macOS clipboard validates permission and cancellation before touching native state", async () => {
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
    await expect(invoke(operation, input, [])).rejects.toThrow(
      expect.objectContaining({
        code: "PERMISSION_DENIED",
      }),
    );
  }
  await expect(
    invoke("clipboard.writeText", {
      text: "\ud800",
    }),
  ).rejects.toThrow(
    expect.objectContaining({
      code: "INVALID_ARGUMENT",
    }),
  );
  await expect(
    invoke(
      "clipboard.clear",
      null,
      [
        "clipboard.clear",
      ],
      AbortSignal.abort(),
    ),
  ).rejects.toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
  expect(calls).toEqual([]);
  expect(
    await invoke("clipboard.writeText", {
      text: "한글 😀\r\n",
    }),
  ).toBeNull();
  expect(await invoke("clipboard.readText", null)).toBe("한글 😀\r\n");
  expect(
    await invoke("clipboard.readFormats", {
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
  await adapter.dispose();
  await adapter.dispose();
  expect(calls.filter((call) => call === "dispose")).toHaveLength(1);
  await expect(invoke("clipboard.clear", null)).rejects.toThrow(
    expect.objectContaining({
      code: "CANCELLED",
    }),
  );
});

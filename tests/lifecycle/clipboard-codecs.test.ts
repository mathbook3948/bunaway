import { expect, test } from "bun:test";
import {
  MAX_BINARY_BYTES,
  MAX_BOOKMARK_LENGTH,
} from "#plugins/clipboard/src/contract";
import {
  decodeBinary,
  decodeBookmark,
  decodeFiles,
  decodeHTML,
  decodeImage,
  decodeRTF,
  encodeBinary,
  encodeFiles,
  encodeHTML,
  encodeImage,
  encodeItem,
  MAX_NATIVE_FORMAT_BYTES,
} from "#plugins/clipboard/src/platforms/windows-codecs";

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
    0,
    0,
    255,
    0,
    11,
    22,
    33,
    44,
  ]).toString("base64"),
};
const invalid = expect.objectContaining({
  code: "INTERNAL",
});

test("DIBV5 preserves row order and straight RGBA alpha; 24-bit bottom-up DIB includes row padding", () => {
  expect(decodeImage(encodeImage(image))).toEqual(image);
  const bottomUp = Buffer.alloc(48);
  bottomUp.writeUInt32LE(40, 0);
  bottomUp.writeInt32LE(1, 4);
  bottomUp.writeInt32LE(2, 8);
  bottomUp.writeUInt16LE(1, 12);
  bottomUp.writeUInt16LE(24, 14);
  bottomUp.set(
    [
      33,
      22,
      11,
      99,
      0,
      0,
      255,
      99,
    ],
    40,
  );
  expect(decodeImage(bottomUp)).toEqual({
    width: 1,
    height: 2,
    rgba: Buffer.from([
      255,
      0,
      0,
      255,
      11,
      22,
      33,
      255,
    ]).toString("base64"),
  });
  // Legacy BI_RGB reserves the fourth byte; zero does not make the bitmap transparent.
  bottomUp.writeUInt16LE(32, 14);
  bottomUp[43] = 0;
  bottomUp[47] = 0;
  expect(decodeImage(bottomUp).rgba).toBe(
    Buffer.from([
      255,
      0,
      0,
      255,
      11,
      22,
      33,
      255,
    ]).toString("base64"),
  );
});

test("BI_BITFIELDS with a 40-byte header stores the BGRA masks after the header and reads pixels after them", () => {
  const bitfields = Buffer.alloc(40 + 12 + 4);
  bitfields.writeUInt32LE(40, 0);
  bitfields.writeInt32LE(1, 4);
  bitfields.writeInt32LE(1, 8);
  bitfields.writeUInt16LE(1, 12);
  bitfields.writeUInt16LE(32, 14);
  bitfields.writeUInt32LE(3, 16); // BI_BITFIELDS
  bitfields.writeUInt32LE(0x00ff0000, 40);
  bitfields.writeUInt32LE(0x0000ff00, 44);
  bitfields.writeUInt32LE(0x000000ff, 48);
  bitfields.set(
    [
      33,
      22,
      11,
      99,
    ],
    52,
  );
  // This header form has no alpha mask, so the fourth byte stays opaque.
  expect(decodeImage(bitfields)).toEqual({
    width: 1,
    height: 1,
    rgba: Buffer.from([
      11,
      22,
      33,
      255,
    ]).toString("base64"),
  });
  const wrongDepth = Buffer.from(bitfields);
  wrongDepth.writeUInt16LE(24, 14);
  expect(() => decodeImage(wrongDepth)).toThrow(invalid);
  const missingMasks = Buffer.from(bitfields.subarray(0, 51));
  expect(() => decodeImage(missingMasks)).toThrow(invalid);
  const wrongMask = Buffer.from(bitfields);
  wrongMask.writeUInt32LE(0xfe, 48);
  expect(() => decodeImage(wrongMask)).toThrow(invalid);
});

test("DIB decoder rejects unsupported masks, compression, profiles, dimensions and truncated rows", () => {
  for (const mutate of [
    (bytes: Buffer) => bytes.writeUInt32LE(200, 0),
    (bytes: Buffer) => bytes.writeInt32LE(-1, 4),
    (bytes: Buffer) => bytes.writeInt32LE(4096, 8),
    (bytes: Buffer) => bytes.writeUInt16LE(2, 12),
    (bytes: Buffer) => bytes.writeUInt16LE(8, 14),
    (bytes: Buffer) => bytes.writeUInt32LE(1, 16),
    (bytes: Buffer) => bytes.writeUInt32LE(1, 32),
    (bytes: Buffer) => bytes.writeUInt32LE(0xff, 40),
    (bytes: Buffer) => bytes.writeUInt32LE(0xff, 52),
    (bytes: Buffer) => bytes.writeUInt32LE(0x4d424544, 56),
    (bytes: Buffer) => bytes.writeUInt32LE(140, 112),
  ]) {
    const bytes = encodeImage(image);
    mutate(bytes);
    expect(() => decodeImage(bytes)).toThrow(invalid);
  }
  expect(() => decodeImage(encodeImage(image).subarray(0, 139))).toThrow(
    invalid,
  );
  expect(() => decodeImage(Buffer.alloc(20))).toThrow(invalid);
});

test("CF_HTML uses UTF-8 byte offsets and rejects invalid UTF-8, missing offsets and out-of-range fragments", () => {
  for (const fragment of [
    "",
    "<p>한글 😀</p>",
    "<!--EndFragment-->inside",
    "\ufeffstart",
  ]) {
    expect(decodeHTML(encodeHTML(fragment))).toBe(fragment);
  }
  const bytes = encodeHTML("x");
  const index =
    bytes.indexOf(Buffer.from("<!--StartFragment-->")) +
    "<!--StartFragment-->".length;
  bytes[index] = 0xff;
  expect(() => decodeHTML(bytes)).toThrow(invalid);
  for (const bytes of [
    Buffer.from("StartFragment:0\r\nEndFragment:9999999\r\n"),
    Buffer.from("StartFragment:0\r\nEndFragment:0\r\n"),
    Buffer.from("<html>missing</html>"),
  ]) {
    expect(() => decodeHTML(bytes)).toThrow(invalid);
  }
});

test("DROPFILES preserves Unicode paths and requires bounded wide lists with a double terminator", () => {
  const files = [
    "C:\\한글\\memo.txt",
    "\\\\server\\share\\😀.txt",
  ];
  expect(decodeFiles(encodeFiles(files))).toEqual(files);
  expect(() => decodeFiles(encodeFiles(files).subarray(0, -2))).toThrow(
    invalid,
  );
  const ansi = encodeFiles(files);
  ansi.writeUInt32LE(0, 16);
  expect(() => decodeFiles(ansi)).toThrow(invalid);
  const invalidOffset = encodeFiles(files);
  invalidOffset.writeUInt32LE(19, 0);
  expect(() => decodeFiles(invalidOffset)).toThrow(invalid);
  expect(() =>
    decodeFiles(
      encodeFiles([
        "relative.txt",
      ]),
    ),
  ).toThrow(invalid);
  expect(() =>
    decodeFiles(
      encodeFiles(
        Array.from(
          {
            length: 65,
          },
          () => "C:\\file.txt",
        ),
      ),
    ),
  ).toThrow(invalid);
  expect(() =>
    decodeRTF(Buffer.from("{\\rtf1 \\u54620?}\0", "ascii")),
  ).not.toThrow();
  expect(() => decodeRTF(Buffer.from("{\\rtf1 한글}\0", "utf8"))).toThrow(
    invalid,
  );
});

test("Windows URL bookmarks require bounded, terminated Unicode HTTP URLs", () => {
  for (const url of [
    "https://example.com/한글😀",
    "http://example.com/?x=1",
    "https://example.com/" +
      "x".repeat(MAX_BOOKMARK_LENGTH - "https://example.com/".length),
  ]) {
    expect(
      decodeBookmark(
        encodeItem({
          format: "application/x-bunaway-bookmark",
          data: {
            url,
          },
        }),
      ),
    ).toEqual({
      url,
    });
  }
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from([
      1,
    ]),
    Buffer.from("https://example.com/", "utf16le"),
    Buffer.from("https://example.com/\ud800\0", "utf16le"),
    Buffer.from("javascript:alert(1)\0", "utf16le"),
    Buffer.from(
      `https://example.com/${"x".repeat(MAX_BOOKMARK_LENGTH)}\0`,
      "utf16le",
    ),
    Buffer.alloc(MAX_NATIVE_FORMAT_BYTES + 1),
  ]) {
    expect(() => decodeBookmark(bytes)).toThrow(invalid);
  }
});

test("private binary framing preserves empty and maximum bytes, excludes allocation padding and rejects malformed lengths", () => {
  for (const data of [
    "",
    "AA==",
    "AP+A/w==",
    Buffer.alloc(MAX_BINARY_BYTES, 255).toString("base64"),
  ]) {
    const encoded = encodeBinary(data);
    expect(decodeBinary(encoded)).toBe(data);
    expect(
      decodeBinary(
        Buffer.concat([
          encoded,
          Buffer.alloc(16, 255),
        ]),
      ),
    ).toBe(data);
  }
  const wrongVersion = encodeBinary("AA==");
  wrongVersion[7] = 50;
  const missingPayload = encodeBinary("AA==");
  missingPayload.writeUInt32LE(2, 8);
  const oversized = encodeBinary("");
  oversized.writeUInt32LE(MAX_BINARY_BYTES + 1, 8);
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(11),
    wrongVersion,
    missingPayload,
    oversized,
    Buffer.alloc(MAX_NATIVE_FORMAT_BYTES + 1),
  ]) {
    expect(() => decodeBinary(bytes)).toThrow(invalid);
  }
});

test("external UniformResourceLocatorW accepts case-insensitive HTTP schemes and preserves native text", () => {
  for (const url of [
    "HTTPS://example.com/Path?Name=Value#Anchor",
    "HTTP://example.com/Path",
    "hTtPs://EXAMPLE.com/한글😀?a=%2F",
  ]) {
    expect(decodeBookmark(Buffer.from(`${url}\0`, "utf16le"))).toEqual({
      url,
    });
  }
  for (const url of [
    "FILE:///C:/private",
    "JAVASCRIPT:alert(1)",
    "HtTpS://",
    "HTTPS://example.com/\n",
  ]) {
    expect(() => decodeBookmark(Buffer.from(`${url}\0`, "utf16le"))).toThrow(
      invalid,
    );
  }
});

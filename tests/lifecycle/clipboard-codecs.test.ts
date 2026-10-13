import { expect, test } from "bun:test";
import {
  decodeFiles,
  decodeHTML,
  decodeImage,
  decodeRTF,
  encodeFiles,
  encodeHTML,
  encodeImage,
} from "#plugins/clipboard/src/codecs";

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

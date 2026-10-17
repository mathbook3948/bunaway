import { expect, test } from "bun:test";
import {
  type NativeIcoFrame,
  parseNativeIco,
  selectNativeIcoFrame,
} from "@bunaway/plugin-api/native";
import {
  composeMaskedPixels,
  hasAlphaChannel,
} from "../../packages/plugin-sdk/src/windows-menu-icon.ts";
import { trayIco, trayPngIco } from "../fixtures/tray-icon.ts";

const encode = (ico: Buffer) => ico.toString("base64");

test("a valid DIB and PNG ICO yield frames with dimensions, depth and data", () => {
  expect(parseNativeIco(encode(trayIco(16)))).toMatchObject([
    {
      width: 16,
      height: 16,
      bitCount: 32,
    },
  ]);
  expect(parseNativeIco(encode(trayPngIco()))).toMatchObject([
    {
      width: 1,
      height: 1,
      bitCount: 32,
    },
  ]);
});

test("a valid directory with a broken DIB or PNG frame is rejected", () => {
  const dibHeaderSize = trayIco();
  dibHeaderSize.writeUInt32LE(12, 22);
  const dibHeight = trayIco();
  dibHeight.writeInt32LE(16, 30);
  const dibDepth = trayIco();
  dibDepth.writeUInt16LE(7, 36);
  const dibDeclared = trayIco();
  dibDeclared.writeUInt32LE(5, 42);
  const dibCompressed = trayIco();
  dibCompressed.writeUInt32LE(1, 38);
  const dibTruncated = trayIco().subarray(0, trayIco().length - 4);
  // The directory still declares the original size, so shrink it to match the cut file.
  const truncated = Buffer.from(dibTruncated);
  truncated.writeUInt32LE(truncated.length - 22, 14);
  const pngWidth = trayPngIco();
  pngWidth.writeUInt32BE(2, 22 + 16);
  const png = trayPngIco();
  const pngNoEnd = png.subarray(0, png.length - 4);
  const pngTruncated = Buffer.from(pngNoEnd);
  pngTruncated.writeUInt32LE(pngTruncated.length - 22, 14);
  const pngOversizedChunk = trayPngIco();
  pngOversizedChunk.writeUInt32BE(0x7fffffff, 22 + 8);
  for (const broken of [
    dibHeaderSize,
    dibHeight,
    dibDepth,
    dibDeclared,
    dibCompressed,
    truncated,
    pngWidth,
    pngTruncated,
    pngOversizedChunk,
    Buffer.concat([
      trayIco().subarray(0, 22),
      Buffer.alloc(8, 0xab),
    ]),
  ]) {
    expect(parseNativeIco(encode(broken))).toBeUndefined();
  }
});

test("size and encoding limits reject the whole ICO", () => {
  expect(parseNativeIco("")).toBeUndefined();
  expect(parseNativeIco(encode(trayIco()).replace(/=*$/, ""))).toBeUndefined();
  expect(
    parseNativeIco(Buffer.alloc(65_537).toString("base64")),
  ).toBeUndefined();
  expect(parseNativeIco("A".repeat(87_384))).toBeUndefined();
});

const frame = (width: number, bitCount: number): NativeIcoFrame => ({
  width,
  height: width,
  bitCount,
  data: Buffer.alloc(0),
});

test("frame selection takes the smallest covering frame, the best depth, else the largest", () => {
  const frames = [
    frame(48, 32),
    frame(16, 8),
    frame(16, 32),
    frame(32, 32),
  ];
  expect(selectNativeIcoFrame(frames, 16)).toBe(frames[2]);
  expect(selectNativeIcoFrame(frames, 20)).toBe(frames[3]);
  expect(selectNativeIcoFrame(frames, 64)).toBe(frames[0]);
  expect(selectNativeIcoFrame(frames, Number.POSITIVE_INFINITY)).toBe(
    frames[0],
  );
  expect(selectNativeIcoFrame([], 16)).toBeUndefined();
});

test("masked pixels keep opaque black and clear transparent pixels", () => {
  // BGRA: black opaque, blue opaque, red but masked transparent.
  const image = Uint8Array.from([
    0,
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    0,
    0,
    255,
    0,
  ]);
  const mask = Uint8Array.from([
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    255,
    255,
    255,
    0,
  ]);
  const pixels = composeMaskedPixels(image, mask);
  expect([
    ...pixels,
  ]).toEqual([
    0,
    0,
    0,
    255,
    255,
    0,
    0,
    255,
    0,
    0,
    0,
    0,
  ]);
  expect(hasAlphaChannel(pixels)).toBe(true);
  expect(hasAlphaChannel(image)).toBe(false);
});

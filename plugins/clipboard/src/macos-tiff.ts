import { BunawayError } from "@bunaway/protocol";
import {
  type ClipboardImage,
  imageSchema,
  MAX_IMAGE_BYTES,
} from "./formats.ts";

const TIFF_MAGIC = 42;
const SAMPLE_FORMAT_UNSIGNED = 1;
const ENTRY_BYTES = 12;
const HEADER_BYTES = 8;
const TAG_COUNT = 12;
const BITS_OFFSET = HEADER_BYTES + 2 + TAG_COUNT * ENTRY_BYTES + 4;
const PIXELS_OFFSET = BITS_OFFSET + 8;
export const MAX_TIFF_BYTES = MAX_IMAGE_BYTES + 4096;

/** Reject external representations rather than truncating or allocating unbounded pixels. */
export function invalidPasteboardData(): never {
  throw new BunawayError({
    code: "INTERNAL",
    message: "macOS clipboard data is invalid or exceeds supported limits.",
  });
}

/** Encode baseline, top-down, single-strip TIFF with unassociated RGBA samples. */
export function encodeTIFF(image: ClipboardImage): Buffer {
  const pixels = Buffer.from(image.rgba, "base64");
  const bytes = Buffer.alloc(PIXELS_OFFSET + pixels.length);
  bytes.write("II");
  bytes.writeUInt16LE(TIFF_MAGIC, 2);
  bytes.writeUInt32LE(HEADER_BYTES, 4);
  bytes.writeUInt16LE(TAG_COUNT, HEADER_BYTES);
  const tags: readonly (readonly [
    number,
    number,
    number,
    number,
  ])[] = [
    [
      256,
      4,
      1,
      image.width,
    ],
    [
      257,
      4,
      1,
      image.height,
    ],
    [
      258,
      3,
      4,
      BITS_OFFSET,
    ],
    [
      259,
      3,
      1,
      1,
    ], // No compression.
    [
      262,
      3,
      1,
      2,
    ], // RGB.
    [
      273,
      4,
      1,
      PIXELS_OFFSET,
    ],
    [
      274,
      3,
      1,
      1,
    ], // Top-left origin.
    [
      277,
      3,
      1,
      4,
    ],
    [
      278,
      4,
      1,
      image.height,
    ],
    [
      279,
      4,
      1,
      pixels.length,
    ],
    [
      284,
      3,
      1,
      1,
    ], // Interleaved samples.
    [
      338,
      3,
      1,
      2,
    ], // Unassociated alpha, preserving even transparent RGB.
  ];
  for (const [index, tag] of tags.entries()) {
    const position = HEADER_BYTES + 2 + index * ENTRY_BYTES;
    bytes.writeUInt16LE(tag[0], position);
    bytes.writeUInt16LE(tag[1], position + 2);
    bytes.writeUInt32LE(tag[2], position + 4);
    bytes.writeUInt32LE(tag[3], position + 8);
  }
  for (let index = 0; index < 4; index++) {
    bytes.writeUInt16LE(8, BITS_OFFSET + index * 2);
  }
  pixels.copy(bytes, PIXELS_OFFSET);
  return bytes;
}

/**
 * Decode bounded baseline TIFF without invoking an unbounded system image decoder.
 * Accept one RGB/RGBA strip with unsigned 8-bit interleaved samples,
 * top-left orientation and unassociated alpha. Compressed, profiled, tiled
 * and multi-page TIFF are rejected.
 */
export function decodeTIFF(bytes: Buffer): ClipboardImage {
  if (bytes.length < HEADER_BYTES || bytes.length > MAX_TIFF_BYTES) {
    invalidPasteboardData();
  }
  const order = bytes.toString("ascii", 0, 2);
  if (order !== "II" && order !== "MM") {
    invalidPasteboardData();
  }
  const short = (offset: number) => {
    if (offset < 0 || offset + 2 > bytes.length) {
      invalidPasteboardData();
    }
    return order === "II"
      ? bytes.readUInt16LE(offset)
      : bytes.readUInt16BE(offset);
  };
  const long = (offset: number) => {
    if (offset < 0 || offset + 4 > bytes.length) {
      invalidPasteboardData();
    }
    return order === "II"
      ? bytes.readUInt32LE(offset)
      : bytes.readUInt32BE(offset);
  };
  if (short(2) !== TIFF_MAGIC) {
    invalidPasteboardData();
  }
  const directory = long(4);
  const count = short(directory);
  if (
    directory < HEADER_BYTES ||
    count > 64 ||
    long(directory + 2 + count * ENTRY_BYTES) !== 0
  ) {
    invalidPasteboardData();
  }
  const tags = new Map<number, number[]>();
  for (let index = 0; index < count; index++) {
    const position = directory + 2 + index * ENTRY_BYTES;
    const tag = short(position);
    const type = short(position + 2);
    const length = long(position + 4);
    if (
      tags.has(tag) ||
      (type !== 3 && type !== 4) ||
      length < 1 ||
      length > 4
    ) {
      invalidPasteboardData();
    }
    const size = type === 3 ? 2 : 4;
    const start = length * size <= 4 ? position + 8 : long(position + 8);
    tags.set(
      tag,
      Array.from(
        {
          length,
        },
        (_, item) =>
          type === 3 ? short(start + item * size) : long(start + item * size),
      ),
    );
  }
  const scalar = (tag: number, fallback?: number): number => {
    const values = tags.get(tag);
    if (!values && fallback !== undefined) {
      return fallback;
    }
    if (values?.length !== 1 || values[0] === undefined) {
      invalidPasteboardData();
    }
    return values[0];
  };
  const width = scalar(256);
  const height = scalar(257);
  const samples = scalar(277);
  const bits = tags.get(258);
  // TIFF defaults to unsigned integers when SampleFormat is absent. Explicit
  // interpretations must describe every sample, including an alpha channel.
  const sampleFormat = tags.get(339);
  const offset = scalar(273);
  const byteCount = scalar(279);
  if (
    width < 1 ||
    width > 4096 ||
    height < 1 ||
    height > 4096 ||
    width * height * 4 > MAX_IMAGE_BYTES ||
    (samples !== 3 && samples !== 4) ||
    bits?.length !== samples ||
    bits.some((value) => value !== 8) ||
    (sampleFormat !== undefined &&
      (sampleFormat.length !== samples ||
        sampleFormat.some((value) => value !== SAMPLE_FORMAT_UNSIGNED))) ||
    scalar(259, 1) !== 1 ||
    scalar(262) !== 2 ||
    scalar(274, 1) !== 1 ||
    scalar(284, 1) !== 1 ||
    scalar(278) < height ||
    (samples === 4 && scalar(338) !== 2) ||
    (samples === 3 && tags.has(338)) ||
    byteCount !== width * height * samples ||
    offset < HEADER_BYTES ||
    offset + byteCount > bytes.length ||
    // These tags introduce color transforms or alternative pixel storage.
    [
      320,
      322,
      323,
      324,
      325,
      34675,
    ].some((tag) => tags.has(tag))
  ) {
    invalidPasteboardData();
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const source = offset + pixel * samples;
    const target = pixel * 4;
    rgba[target] = bytes[source] ?? 0;
    rgba[target + 1] = bytes[source + 1] ?? 0;
    rgba[target + 2] = bytes[source + 2] ?? 0;
    rgba[target + 3] = samples === 4 ? (bytes[source + 3] ?? 0) : 255;
  }
  return imageSchema.parse({
    width,
    height,
    rgba: rgba.toString("base64"),
  });
}

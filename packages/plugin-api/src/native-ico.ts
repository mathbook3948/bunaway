import { MAX_TRAY_ICO_BYTES } from "./native-tray.ts";

/**
 * One validated image from an ICO directory: a PNG or an uncompressed DIB without a file header,
 * ready to pass to `CreateIconFromResourceEx`.
 */
export type NativeIcoFrame = {
  width: number;
  height: number;
  /** Bits per pixel from the DIB header, or the directory value (32 when absent) for a PNG. */
  bitCount: number;
  /** Frame bytes borrowed from the decoded ICO. Copy them before DWORD-aligned native use. */
  data: Buffer;
};

const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const MAX_ICO_FRAMES = 32;
/** A directory entry stores 0 for a 256 pixel dimension. */
const ICO_LARGE_DIMENSION = 256;
const DIB_HEADER_BYTES = 40;
const DIB_BIT_COUNTS = [
  1,
  4,
  8,
  16,
  24,
  32,
];
const PNG_SIGNATURE = Buffer.from([
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10,
]);
const PNG_IHDR_BYTES = 13;
const PNG_CHUNK_OVERHEAD_BYTES = 12;
const PNG_MIN_BYTES = 33;
const DEFAULT_PNG_BIT_COUNT = 32;

/**
 * Decode a canonical base64 ICO and validate it without file I/O or native calls.
 *
 * The encoded and decoded sizes are bounded by `MAX_TRAY_ICO_BYTES`. Every directory entry must
 * stay inside the file, and every frame must be a complete PNG or a conventional uncompressed
 * DIB whose declared sizes match its bytes, which also bounds the decoded allocation.
 * Returns undefined for any violation so each caller can report its own error.
 */
export function parseNativeIco(ico: string): NativeIcoFrame[] | undefined {
  if (ico.length > Math.ceil(MAX_TRAY_ICO_BYTES / 3) * 4) {
    return undefined;
  }
  const bytes = Buffer.from(ico, "base64");
  if (
    bytes.length < ICO_HEADER_BYTES + ICO_ENTRY_BYTES ||
    bytes.length > MAX_TRAY_ICO_BYTES ||
    bytes.toString("base64") !== ico ||
    bytes.readUInt16LE(0) !== 0 ||
    bytes.readUInt16LE(2) !== 1
  ) {
    return undefined;
  }
  const count = bytes.readUInt16LE(4);
  const directoryBytes = ICO_HEADER_BYTES + count * ICO_ENTRY_BYTES;
  if (count < 1 || count > MAX_ICO_FRAMES || bytes.length < directoryBytes) {
    return undefined;
  }
  const frames: NativeIcoFrame[] = [];
  for (let index = 0; index < count; index++) {
    const entry = ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES;
    const width = bytes.readUInt8(entry) || ICO_LARGE_DIMENSION;
    const height = bytes.readUInt8(entry + 1) || ICO_LARGE_DIMENSION;
    const size = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    if (
      bytes.readUInt8(entry + 3) !== 0 ||
      size === 0 ||
      offset < directoryBytes ||
      offset > bytes.length - size
    ) {
      return undefined;
    }
    const data = bytes.subarray(offset, offset + size);
    const bitCount = frameBitCount(
      data,
      width,
      height,
      bytes.readUInt16LE(entry + 6),
    );
    if (bitCount === undefined) {
      return undefined;
    }
    frames.push({
      width,
      height,
      bitCount,
      data,
    });
  }
  return frames;
}

/**
 * Pick the frame to draw at `size` pixels: the smallest frame that covers it, else the largest.
 * Frames of the same width prefer the higher bit depth, and a remaining tie keeps the first.
 * Pass `Infinity` to always take the largest frame.
 */
export function selectNativeIcoFrame(
  frames: readonly NativeIcoFrame[],
  size: number,
): NativeIcoFrame | undefined {
  const extent = (frame: NativeIcoFrame) => Math.max(frame.width, frame.height);
  let covering: NativeIcoFrame | undefined;
  let largest: NativeIcoFrame | undefined;
  for (const frame of frames) {
    if (
      extent(frame) >= size &&
      (!covering ||
        extent(frame) < extent(covering) ||
        (extent(frame) === extent(covering) &&
          frame.bitCount > covering.bitCount))
    ) {
      covering = frame;
    }
    if (
      !largest ||
      extent(frame) > extent(largest) ||
      (extent(frame) === extent(largest) && frame.bitCount > largest.bitCount)
    ) {
      largest = frame;
    }
  }
  return covering ?? largest;
}

/** Validate one frame against its directory dimensions and return its bit depth. */
function frameBitCount(
  image: Buffer,
  width: number,
  height: number,
  directoryBitCount: number,
): number | undefined {
  if (
    image.length >= PNG_MIN_BYTES &&
    image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return validPng(image, width, height)
      ? directoryBitCount || DEFAULT_PNG_BIT_COUNT
      : undefined;
  }
  return dibBitCount(image, width, height);
}

/** Require a PNG whose IHDR matches the directory and whose chunks end exactly at IEND. */
function validPng(image: Buffer, width: number, height: number): boolean {
  if (
    image.readUInt32BE(8) !== PNG_IHDR_BYTES ||
    image.toString("ascii", 12, 16) !== "IHDR" ||
    image.readUInt32BE(16) !== width ||
    image.readUInt32BE(20) !== height
  ) {
    return false;
  }
  let offset = PNG_SIGNATURE.length;
  while (offset <= image.length - PNG_CHUNK_OVERHEAD_BYTES) {
    const length = image.readUInt32BE(offset);
    if (length > image.length - offset - PNG_CHUNK_OVERHEAD_BYTES) {
      return false;
    }
    const type = image.toString("ascii", offset + 4, offset + 8);
    offset += length + PNG_CHUNK_OVERHEAD_BYTES;
    if (type === "IEND") {
      return length === 0 && offset === image.length;
    }
  }
  return false;
}

/**
 * Check a DIB frame: BITMAPINFOHEADER size, doubled height (XOR image plus AND mask), no
 * compression, a supported depth, matching declared sizes, and enough bytes for palette, pixels
 * and mask.
 */
function dibBitCount(
  image: Buffer,
  width: number,
  height: number,
): number | undefined {
  if (
    image.length < DIB_HEADER_BYTES ||
    image.readUInt32LE(0) !== DIB_HEADER_BYTES ||
    image.readInt32LE(4) !== width ||
    image.readInt32LE(8) !== height * 2 ||
    image.readUInt16LE(12) !== 1 ||
    image.readUInt32LE(16) !== 0
  ) {
    return undefined;
  }
  const bits = image.readUInt16LE(14);
  if (!DIB_BIT_COUNTS.includes(bits)) {
    return undefined;
  }
  const declaredColors = image.readUInt32LE(32);
  const colors = bits <= 8 ? declaredColors || 2 ** bits : 0;
  if ((bits <= 8 && colors > 2 ** bits) || (bits > 8 && declaredColors !== 0)) {
    return undefined;
  }
  const colorBytes = Math.ceil((width * bits) / 32) * 4 * height;
  const declaredBytes = image.readUInt32LE(20);
  if (declaredBytes !== 0 && declaredBytes !== colorBytes) {
    return undefined;
  }
  const maskBytes = Math.ceil(width / 32) * 4 * height;
  if (image.length < DIB_HEADER_BYTES + colors * 4 + colorBytes + maskBytes) {
    return undefined;
  }
  return bits;
}

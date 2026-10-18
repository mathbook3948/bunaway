/**
 * Upper bound for a decoded ICO. It bounds image allocation before Windows sees the data, and
 * every ICO consumer (tray, menu, taskbar) shares it. `MAX_TRAY_ICO_BYTES` keeps the same value.
 */
export const MAX_NATIVE_ICO_BYTES = 65_536;

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
  data: Uint8Array;
};

// This module is bundled into WebView code through the plugin contracts, so it only uses
// standard globals: no Buffer, no Bun and no Node modules. The lint override in biome.json and
// the browser boundary conformance test keep it that way.
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
const PNG_SIGNATURE = [
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10,
];
const PNG_IHDR_BYTES = 13;
const PNG_CHUNK_OVERHEAD_BYTES = 12;
const PNG_MIN_BYTES = 33;
const DEFAULT_PNG_BIT_COUNT = 32;
const LITTLE_ENDIAN = true;

/**
 * Decode a canonical base64 ICO and validate it without file I/O or native calls.
 *
 * The encoded and decoded sizes are bounded by `MAX_NATIVE_ICO_BYTES`. Every directory entry must
 * stay inside the file, and every frame must be a complete PNG or a conventional uncompressed
 * DIB whose declared sizes match its bytes, which also bounds the decoded allocation.
 * Returns undefined for any violation so each caller can report its own error.
 */
export function parseNativeIco(ico: string): NativeIcoFrame[] | undefined {
  if (ico.length > Math.ceil(MAX_NATIVE_ICO_BYTES / 3) * 4) {
    return undefined;
  }
  const bytes = decodeCanonicalBase64(ico);
  if (
    !bytes ||
    bytes.length < ICO_HEADER_BYTES + ICO_ENTRY_BYTES ||
    bytes.length > MAX_NATIVE_ICO_BYTES
  ) {
    return undefined;
  }
  const view = dataView(bytes);
  if (
    view.getUint16(0, LITTLE_ENDIAN) !== 0 ||
    view.getUint16(2, LITTLE_ENDIAN) !== 1
  ) {
    return undefined;
  }
  const count = view.getUint16(4, LITTLE_ENDIAN);
  const directoryBytes = ICO_HEADER_BYTES + count * ICO_ENTRY_BYTES;
  if (count < 1 || count > MAX_ICO_FRAMES || bytes.length < directoryBytes) {
    return undefined;
  }
  const frames: NativeIcoFrame[] = [];
  for (let index = 0; index < count; index++) {
    const entry = ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES;
    const width = view.getUint8(entry) || ICO_LARGE_DIMENSION;
    const height = view.getUint8(entry + 1) || ICO_LARGE_DIMENSION;
    const size = view.getUint32(entry + 8, LITTLE_ENDIAN);
    const offset = view.getUint32(entry + 12, LITTLE_ENDIAN);
    if (
      view.getUint8(entry + 3) !== 0 ||
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
      view.getUint16(entry + 6, LITTLE_ENDIAN),
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

/**
 * Decode base64 that round-trips byte for byte. `atob` accepts whitespace and missing padding,
 * so re-encoding and comparing rejects every non-canonical spelling of the same bytes.
 */
function decodeCanonicalBase64(encoded: string): Uint8Array | undefined {
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return undefined;
  }
  if (btoa(binary) !== encoded) {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** A view over exactly the bytes of `bytes`, which may be a subarray of a larger buffer. */
function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The ASCII text of `bytes[start, end)`, used for the four-byte PNG chunk types. */
function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Validate one frame against its directory dimensions and return its bit depth. */
function frameBitCount(
  image: Uint8Array,
  width: number,
  height: number,
  directoryBitCount: number,
): number | undefined {
  if (
    image.length >= PNG_MIN_BYTES &&
    PNG_SIGNATURE.every((byte, index) => image[index] === byte)
  ) {
    return validPng(image, width, height)
      ? directoryBitCount || DEFAULT_PNG_BIT_COUNT
      : undefined;
  }
  return dibBitCount(image, width, height);
}

/** Require a PNG whose IHDR matches the directory and whose chunks end exactly at IEND. */
function validPng(image: Uint8Array, width: number, height: number): boolean {
  const view = dataView(image);
  if (
    view.getUint32(8) !== PNG_IHDR_BYTES ||
    ascii(image, 12, 16) !== "IHDR" ||
    view.getUint32(16) !== width ||
    view.getUint32(20) !== height
  ) {
    return false;
  }
  let offset = PNG_SIGNATURE.length;
  while (offset <= image.length - PNG_CHUNK_OVERHEAD_BYTES) {
    const length = view.getUint32(offset);
    if (length > image.length - offset - PNG_CHUNK_OVERHEAD_BYTES) {
      return false;
    }
    const type = ascii(image, offset + 4, offset + 8);
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
  image: Uint8Array,
  width: number,
  height: number,
): number | undefined {
  if (image.length < DIB_HEADER_BYTES) {
    return undefined;
  }
  const view = dataView(image);
  if (
    view.getUint32(0, LITTLE_ENDIAN) !== DIB_HEADER_BYTES ||
    view.getInt32(4, LITTLE_ENDIAN) !== width ||
    view.getInt32(8, LITTLE_ENDIAN) !== height * 2 ||
    view.getUint16(12, LITTLE_ENDIAN) !== 1 ||
    view.getUint32(16, LITTLE_ENDIAN) !== 0
  ) {
    return undefined;
  }
  const bits = view.getUint16(14, LITTLE_ENDIAN);
  if (!DIB_BIT_COUNTS.includes(bits)) {
    return undefined;
  }
  const declaredColors = view.getUint32(32, LITTLE_ENDIAN);
  const colors = bits <= 8 ? declaredColors || 2 ** bits : 0;
  if ((bits <= 8 && colors > 2 ** bits) || (bits > 8 && declaredColors !== 0)) {
    return undefined;
  }
  const colorBytes = Math.ceil((width * bits) / 32) * 4 * height;
  const declaredBytes = view.getUint32(20, LITTLE_ENDIAN);
  if (declaredBytes !== 0 && declaredBytes !== colorBytes) {
    return undefined;
  }
  const maskBytes = Math.ceil(width / 32) * 4 * height;
  if (image.length < DIB_HEADER_BYTES + colors * 4 + colorBytes + maskBytes) {
    return undefined;
  }
  return bits;
}
